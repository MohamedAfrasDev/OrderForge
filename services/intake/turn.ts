import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { catalogForModel, proposeAlternatives, type Alternative, type Blocker } from "@/domain/catalog";
import {
  acceptQuestion,
  amountsOfAlternative,
  askSchema,
  blockingFields,
  buildPrompt,
  confirmedBoxCount,
  emptyStored,
  extractionSchema,
  fallbackQuestion,
  mergeRequirements,
  parseExtraction,
  proposeJsonSchema,
  proposeSchema,
  rankAlternatives,
  rankingSchema,
  toCatalogRequirements,
  type BlockingField,
  type ConversationEntry,
  type Extraction,
  type InquiryEvent,
  type IntakeErrorCode,
  type ParsedExtraction,
  type Prompt,
  type Proposal,
  type StoredRequirements,
} from "@/domain/intake";
import type { ModelKind, ModelPort, ModelResult, ParseOutcome } from "@/lib/ai";
import type { VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import { cents, format } from "@/lib/money";
import { loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { loadShopProfile } from "@/services/catalog/load-profile";
import { LIMITS, appendRequirements, auditIntake, latestRequirements, loadInquiry, transitionInquiry, type ServiceContext } from "./shared";
import { createToolDispatcher, type ToolContext } from "./tools";

export type TurnDeps = { model: ModelPort };

/** At most three questions to the model in one turn: read the message, then either word a question or propose and rank. */
const MAX_MODEL_QUESTIONS = 3;
const MAX_ALTERNATIVES = 5;
const UNIQUE_VIOLATION = "23505";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ACTOR = "system:intake";

export type HandOffReason = "clarification_limit" | "conflict_persists";

export type TurnOutcome =
  | { kind: "ASKED"; replyId: string; version: number; field: BlockingField; question: string }
  | { kind: "PROPOSED"; replyId: string; version: number; proposal: Proposal }
  | { kind: "HANDED_OFF"; replyId: string; version: number; reason: HandOffReason };

export type TurnResult =
  | { ok: true; value: TurnOutcome }
  | { ok: false; code: IntakeErrorCode; cause?: string; reply?: { id: string; body: string } };

const fail = (code: IntakeErrorCode, cause?: string): TurnResult => ({ ok: false, code, ...(cause ? { cause } : {}) });

const OUTAGE_NOTE = "The assistant could not answer just now. Your message is kept. You can try again or ask the shop to take over.";
const LIMIT_NOTE = "This conversation has reached its limit, so the shop will take over from here.";
const HANDOFF_REPLY = "I could not settle this on my own, so I have passed your request to the shop. They can see our conversation and your requirements.";

const jsonSchemaOf = (schema: z.ZodType): Record<string, unknown> => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;

const BLOCKER_WORDS: Partial<Record<Blocker["code"], string>> = {
  INSUFFICIENT_STOCK: "not enough of one product is in stock",
  OVER_BUDGET: "it is over your budget",
  FOOD_NOT_ALLOWED: "it contains food",
  LOGO_NOT_COVERED: "the logo is not covered",
  UNSUPPORTED_DATE: "the pickup date is too early",
  BELOW_MIN_QUANTITY: "the quantity is below the minimum",
};

type Reply = { id: string; body: string };

async function replyTo(db: SupabaseClient, messageId: string): Promise<Reply | null> {
  const found = await db.from("messages").select("id, body").eq("reply_to", messageId).maybeSingle();
  if (found.error) throw new Error(`load reply: ${found.error.message}`);
  return found.data ? { id: found.data.id as string, body: found.data.body as string } : null;
}

async function countModelRuns(db: SupabaseClient, inquiryId: string): Promise<number> {
  const counted = await db.from("audit_events").select("id", { count: "exact", head: true }).eq("entity", "inquiry").eq("entity_id", inquiryId).eq("action", "intake.model_run");
  if (counted.error) throw new Error(`count model runs: ${counted.error.message}`);
  return counted.count ?? 0;
}

/** Later than the message it follows, so the conversation always reads in order. */
const laterThan = (now: string, createdAt: string): string => new Date(Math.max(Date.parse(now), Date.parse(createdAt) + 1)).toISOString();

async function systemNote(db: SupabaseClient, inquiryId: string, body: string, at: string): Promise<void> {
  const note = await db.from("messages").insert({ inquiry_id: inquiryId, role: "system", body, created_at: at });
  if (note.error) throw new Error(`store note: ${note.error.message}`);
}

/** Sends the inquiry to the merchant (with one note, once). A state that cannot be handed over is left as it is. */
async function handOffWithNote(db: SupabaseClient, inquiryId: string, ctx: ServiceContext, at: string): Promise<void> {
  const moved = await transitionInquiry(db, inquiryId, { type: "HAND_OFF" }, ctx, MODEL_ACTOR);
  if (moved.ok && moved.changed) await systemNote(db, inquiryId, LIMIT_NOTE, at);
}

type ConversationRow = { id: string; role: ConversationEntry["role"]; body: string; created_at: string };

async function conversationUpTo(db: SupabaseClient, inquiryId: string, messageId: string): Promise<{ entries: ConversationEntry[]; createdAt: string } | null> {
  const loaded = await db.from("messages").select("id, role, body, created_at").eq("inquiry_id", inquiryId).order("created_at").order("id");
  if (loaded.error) throw new Error(`load conversation: ${loaded.error.message}`);
  const rows = (loaded.data ?? []) as ConversationRow[];
  const at = rows.findIndex((r) => r.id === messageId);
  if (at < 0 || rows[at]!.role !== "customer") return null;
  const entries = rows
    .slice(0, at + 1)
    .filter((r) => r.role !== "system")
    .map((r) => ({ id: r.id, role: r.role, text: r.body }));
  return { entries, createdAt: rows[at]!.created_at };
}

/** What this turn tells the customer when a box is proposed or blocked: code's words and code's figures. */
export function proposalText(proposal: Proposal, productName: (sku: string) => string, boxCount: number): string {
  if (proposal.status === "VALID" && proposal.priced) {
    const parts = Object.entries(proposal.selections).map(([, sku]) => productName(sku));
    return `Here is a box that fits your request: ${parts.join(", ")}. It comes to ${format(cents(proposal.priced.perBoxMinor))} per box, ${format(cents(proposal.priced.totalMinor))} for ${boxCount} boxes. You can use it, change your request, or ask the shop to take over.`;
  }
  const reasons = [...new Set(proposal.blockers.map((b) => BLOCKER_WORDS[b as Blocker["code"]] ?? "it is not available as asked"))];
  const why = reasons.length > 0 ? ` (${reasons.join("; ")})` : "";
  if (proposal.alternatives.length === 0) {
    return `I could not find a box that fits all of your requirements${why}. You can change a requirement, or ask the shop to take over.`;
  }
  const lines = proposal.alternatives.map(
    (a, i) => `${i + 1}. Replace ${productName(a.fromSku)} with ${productName(a.toSku)}: ${format(cents(a.perBoxMinor))} per box, ${format(cents(a.totalMinor))} in total${a.explanation ? `. ${a.explanation}` : ""}`,
  );
  return [`The box I first chose cannot be made as asked${why}. These options do work:`, ...lines].join("\n");
}

type Step = { logical: number; requests: number; base: number };

/**
 * One customer message, answered once. The steps are fixed in code:
 *   read the message into requirements (the model) -> merge into a new version (code) -> what blocks (code) ->
 *   either word the one question (the model, checked) or propose a box (the model), validate and price it (code), and if it
 *   cannot be made, rank code's own alternatives (the model, checked).
 * At most three questions to the model per turn (the client adds one retry for a bad answer), and at most six tool calls.
 * The reply is claimed first through the unique `reply_to` index, so two requests for one message cannot both answer: the
 * loser gets `ALREADY_ANSWERED` with the winner's reply and writes nothing. A failure of the model for the reading or the
 * proposal ends the turn with one system note, no reply, and the inquiry as it was, so retrying runs the message again.
 */
export async function runIntakeTurn(db: SupabaseClient, deps: TurnDeps, inquiryId: VerifiedInquiryId, messageId: string, ctx: ServiceContext): Promise<TurnResult> {
  const inquiry = await loadInquiry(db, inquiryId);
  if (!inquiry) return fail("INQUIRY_NOT_FOUND");
  if (typeof messageId !== "string" || !UUID.test(messageId)) return fail("INVALID_INPUT");

  const existing = await replyTo(db, messageId);
  if (existing) return { ok: false, code: "ALREADY_ANSWERED", reply: existing };
  if (inquiry.status === "REVIEW_REQUIRED") return fail("ILLEGAL_TRANSITION", "the merchant has this inquiry");

  const conversation = await conversationUpTo(db, inquiryId, messageId);
  if (!conversation) return fail("INVALID_INPUT");

  const messageAt = conversation.createdAt;
  const runsBefore = await countModelRuns(db, inquiryId);
  if (runsBefore >= LIMITS.modelRuns) {
    await handOffWithNote(db, inquiryId, ctx, laterThan(ctx.now, messageAt));
    return fail("LIMIT_REACHED");
  }

  const snapshot = await loadCatalogSnapshot(db, inquiry.merchantId);
  const shop = await loadShopProfile(db, inquiry.merchantId);
  const today = ctx.now.slice(0, 10);
  const latest = await latestRequirements(db, inquiryId);
  const current = latest?.stored ?? emptyStored();
  const step: Step = { logical: 0, requests: 0, base: runsBefore };

  async function ask<T>(kind: ModelKind, prompt: Prompt, jsonSchema: Record<string, unknown>, parse: (raw: unknown) => ParseOutcome<T>): Promise<ModelResult<T>> {
    if (step.logical >= MAX_MODEL_QUESTIONS) throw new Error("model question budget exceeded");
    step.logical += 1;
    let result: ModelResult<T>;
    try {
      result = await deps.model.complete({ kind, messages: prompt.messages, jsonSchema, parse });
    } catch {
      result = { ok: false, failure: "PROVIDER_FAILURE", model: null, detail: "the model call failed", calls: 1 };
    }
    step.requests += result.calls;
    await auditIntake(db, ctx, ctx.actor ?? MODEL_ACTOR, "intake.model_run", inquiryId, {
      model_id: result.model ?? "none",
      prompt_version: prompt.version,
      run: step.base + step.logical,
      status: result.ok ? "ok" : result.failure,
    });
    return result;
  }

  async function outage(failure: "PROVIDER_FAILURE" | "TIMEOUT" | "MALFORMED"): Promise<TurnResult> {
    await systemNote(db, inquiryId, OUTAGE_NOTE, laterThan(ctx.now, messageAt));
    return fail(failure === "MALFORMED" ? "MODEL_OUTPUT_INVALID" : "MODEL_UNAVAILABLE");
  }

  // 1. Read the message.
  const read = await ask<Extraction>(
    "extract",
    buildPrompt("extract", { conversation: conversation.entries, current: current.fields, catalog: catalogForModel(snapshot.catalog), today, shop }),
    jsonSchemaOf(extractionSchema),
    (raw): ParsedExtraction => parseExtraction(raw),
  );
  if (!read.ok) return outage(read.failure);

  // 2. Merge and decide what blocks (code).
  const fields = mergeRequirements(current.fields, read.value, messageId);
  const blocking = blockingFields(fields);
  const asked = current.question?.field ?? null;
  const clarificationsBefore = await clarificationTurns(db, inquiryId);

  let stored: StoredRequirements;
  let text: string;
  let outcomeOf: (replyId: string, version: number) => TurnOutcome;
  let events: InquiryEvent[];

  const first = blocking[0];
  if (first !== undefined && (clarificationsBefore >= LIMITS.clarificationTurns || (asked === first && fields[first].status === "conflicted"))) {
    // Not converging: the merchant takes over.
    const reason: HandOffReason = clarificationsBefore >= LIMITS.clarificationTurns ? "clarification_limit" : "conflict_persists";
    stored = { ...emptyStored(), fields };
    text = HANDOFF_REPLY;
    events = [{ type: "HAND_OFF" }];
    outcomeOf = (replyId, version) => ({ kind: "HANDED_OFF", replyId, version, reason });
  } else if (first !== undefined) {
    // 3a. Ask the one question code chose. The model may reword it; the fixed wording is always there.
    const fallback = fallbackQuestion(first);
    const worded = await ask("ask", buildPrompt("ask", { field: first, fallback, current: fields, conversation: conversation.entries, shop }), jsonSchemaOf(askSchema), (raw) => {
      const parsed = askSchema.safeParse(raw);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, errors: parsed.error.issues.map((i) => i.message) };
    });
    const question = (worded.ok ? acceptQuestion(worded.value.question, first) : null) ?? fallback;
    stored = { ...emptyStored(), fields, question: { field: first, text: question } };
    text = question;
    events = [{ type: "ASK" }];
    outcomeOf = (replyId, version) => ({ kind: "ASKED", replyId, version, field: first, question });
  } else {
    // 3b. Nothing blocks: propose a box, validate and price it in code.
    const boxCount = confirmedBoxCount(fields)!;
    const tools = createToolDispatcher({ ...toolContext(snapshot, fields, today), boxCount });
    const view = tools.call("read_catalog", {});
    if (!view.ok) throw new Error("read_catalog refused");
    const allowed = new Map(view.result.slots.map((s) => [s.id, new Set(s.allowedSkus)]));

    const proposed = await ask("propose", buildPrompt("propose", { catalog: view.result, requirements: fields, boxCount, today, shop }), proposeJsonSchema(view.result.slots), (raw) => {
      const parsed = proposeSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
      const errors = selectionErrors(parsed.data.selections, allowed);
      return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed.data };
    });
    if (!proposed.ok) return outage(proposed.failure);

    const selections = proposed.value.selections;
    const checked = tools.call("validate_configuration", { selections });
    if (!checked.ok) throw new Error(`validate_configuration refused: ${checked.code}`);

    let proposal: Proposal;
    if (checked.result.ok) {
      const { perBoxMinor, totalMinor, boxCount: priced } = checked.result.priced;
      proposal = { selections, status: "VALID", blockers: [], priced: { perBoxMinor, totalMinor, boxCount: priced }, alternatives: [] };
    } else {
      const found = proposeAlternatives(
        { configuration: { boxCount, selections }, catalog: snapshot.catalog, requirements: toCatalogRequirements(fields), stock: snapshot.stock, today },
        { limit: MAX_ALTERNATIVES },
      ).alternatives;
      const blockers = [...new Set(checked.result.blockers.map((b) => b.code))];
      let alternatives: Proposal["alternatives"] = [];
      if (found.length > 0) {
        const ranking = await ask("rank", buildPrompt("rank", { requirements: fields, alternatives: found.map((a, index) => forPrompt(a, index)), shop }), jsonSchemaOf(rankingSchema), (raw) => {
          const parsed = rankingSchema.safeParse(raw);
          return parsed.success ? { ok: true, value: parsed.data } : { ok: false, errors: parsed.error.issues.map((i) => i.message) };
        });
        alternatives = rankAlternatives(found, ranking.ok ? ranking.value : null, amountsOfAlternative).map((r) => ({
          key: `alt-${r.index}`,
          slotId: r.item.slotId,
          fromSku: r.item.fromSku,
          toSku: r.item.toSku,
          perBoxMinor: r.item.priced.perBoxMinor,
          totalMinor: r.item.priced.totalMinor,
          explanation: r.explanation,
        }));
      }
      proposal = { selections, status: "BLOCKED", blockers, priced: null, alternatives };
    }

    const names = new Map(snapshot.catalog.products.map((p) => [p.sku, p.name]));
    stored = { ...emptyStored(), fields, proposal };
    text = proposalText(proposal, (sku) => names.get(sku) ?? sku, boxCount);
    events = [{ type: "CLEAR" }];
    outcomeOf = (replyId, version) => ({ kind: "PROPOSED", replyId, version, proposal });
  }

  // 4. Claim the reply. Only the winner writes the version and moves the inquiry.
  const at = laterThan(ctx.now, messageAt);
  const claimed = await db.from("messages").insert({ inquiry_id: inquiryId, role: "assistant", body: text, reply_to: messageId, created_at: at }).select("id").single();
  if (claimed.error) {
    if (claimed.error.code !== UNIQUE_VIOLATION) throw new Error(`store reply: ${claimed.error.message}`);
    const winner = await replyTo(db, messageId);
    return { ok: false, code: "ALREADY_ANSWERED", ...(winner ? { reply: winner } : {}) };
  }
  const replyId = claimed.data.id as string;

  const saved = await appendRequirements(db, inquiryId, () => stored, messageId);
  if (inquiry.status === "QUOTE_READY") await transitionInquiry(db, inquiryId, { type: "CUSTOMER_CHANGE" }, ctx, MODEL_ACTOR);
  for (const event of events) await transitionInquiry(db, inquiryId, event, ctx, MODEL_ACTOR);

  return { ok: true, value: outcomeOf(replyId, saved.version) };
}

function toolContext(snapshot: { catalog: ToolContext["catalog"]; stock: ToolContext["stock"] }, fields: StoredRequirements["fields"], today: string): ToolContext {
  return { catalog: snapshot.catalog, stock: snapshot.stock, requirements: toCatalogRequirements(fields), boxCount: confirmedBoxCount(fields), today };
}

const forPrompt = (a: Alternative, index: number) => ({ index, slotId: a.slotId, fromSku: a.fromSku, toSku: a.toSku, perBoxMinor: a.priced.perBoxMinor, totalMinor: a.priced.totalMinor });

/** Every problem with a proposal's shape at once, so the one retry can fix them all: an unknown slot, an unknown or disallowed SKU, an unfilled slot. */
function selectionErrors(selections: Record<string, string>, allowed: Map<string, Set<string>>): string[] {
  const errors: string[] = [];
  for (const [slotId, skus] of allowed) {
    const sku = Object.hasOwn(selections, slotId) ? selections[slotId] : undefined;
    if (sku === undefined) errors.push(`slot "${slotId}" has no product`);
    else if (!skus.has(sku)) errors.push(`"${sku}" is not an allowed product for slot "${slotId}"`);
  }
  for (const slotId of Object.keys(selections)) if (!allowed.has(slotId)) errors.push(`"${slotId}" is not a slot of the box`);
  return errors;
}

/** Questions already put to the customer: one per stored version that carries an open question. */
async function clarificationTurns(db: SupabaseClient, inquiryId: string): Promise<number> {
  const rows = await db.from("requirement_versions").select("requirements").eq("inquiry_id", inquiryId);
  if (rows.error) throw new Error(`count questions: ${rows.error.message}`);
  return (rows.data ?? []).filter((r) => (r.requirements as { question?: unknown } | null)?.question != null).length;
}
