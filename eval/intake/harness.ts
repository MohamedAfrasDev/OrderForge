// Runs a scenario through the REAL intake pipeline (the same services the app uses) against a database the caller passes in
// (the local Supabase stack, never a hosted one), with whatever model port the caller passes in: the real OpenRouter client for
// the manual run, a replay of recorded answers for CI. Nothing here knows which.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Catalog } from "@/domain/catalog";
import { FIELD_NAMES, type BlockingField, type FieldName } from "@/domain/intake";
import { authorizeCustomerLink, type VerifiedInquiryId } from "@/lib/access/inquiry-reads";
import type { ModelKind, ModelPort } from "@/lib/ai";
import { cents } from "@/lib/money";
import { latestRequirements } from "@/services/intake/shared";
import { postCustomerMessage, startInquiry } from "@/services/intake/start";
import { runIntakeTurn } from "@/services/intake/turn";
import { boxTemplate, products, stock } from "../../supabase/seed/fixtures";
import { judgeTurn, type Observed, type Verdict } from "./score";
import type { Scenario } from "./scenarios";

export const EVAL_NOW = "2026-11-04T10:00:00.000Z";
const SECRET = "eval-secret-with-enough-length-0000";

/** One question the pipeline put to the model and what came back: the parsed answer, or the way it failed. */
export type RecordedCall = { kind: ModelKind; model: string | null; answer?: unknown; failure?: string; detail?: string };

export type TurnRun = { say: string; calls: RecordedCall[]; observed: Observed; verdict: Verdict };
export type ScenarioRun = { id: string; turns: TurnRun[] };

/** Wraps a model port and keeps what it was asked and what it answered, in order. */
export function recording(inner: ModelPort): ModelPort & { drain(): RecordedCall[] } {
  let calls: RecordedCall[] = [];
  return {
    async complete(request) {
      const result = await inner.complete(request);
      calls.push(result.ok ? { kind: request.kind, model: result.model, answer: result.value } : { kind: request.kind, model: result.model, failure: result.failure, detail: result.detail });
      return result;
    },
    drain() {
      const out = calls;
      calls = [];
      return out;
    },
  };
}

/** A merchant of its own with the demo catalog, so scenarios never share a shelf. */
export async function newStore(db: SupabaseClient, onHand: Record<string, number> = {}): Promise<{ merchantId: string; slug: string; catalog: Catalog }> {
  const slug = `eval-${randomUUID().slice(0, 8)}`;
  const merchant = await db.from("merchants").insert({ slug, name: "Evaluation store" }).select("id").single();
  if (merchant.error) throw new Error(`merchant: ${merchant.error.message}`);
  const merchantId = merchant.data.id as string;
  const ids = new Map(products.map((p) => [p.id, randomUUID()]));
  const skuOf = new Map(products.map((p) => [p.id, p.sku]));
  const inserted = await db.from("products").insert(products.map((p) => ({ ...p, id: ids.get(p.id)!, merchant_id: merchantId })));
  if (inserted.error) throw new Error(`products: ${inserted.error.message}`);
  const stocked = await db.from("stock").insert(stock.map((s) => ({ ...s, product_id: ids.get(s.product_id)!, on_hand: onHand[skuOf.get(s.product_id)!] ?? s.on_hand })));
  if (stocked.error) throw new Error(`stock: ${stocked.error.message}`);
  const rules = await db.from("business_rules").insert([
    { merchant_id: merchantId, key: "box_template", value: boxTemplate },
    { merchant_id: merchantId, key: "production_lead_days", value: { days: 7 } },
  ]);
  if (rules.error) throw new Error(`rules: ${rules.error.message}`);

  const catalog: Catalog = {
    products: products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, category: p.category, unitPriceMinor: cents(p.unit_price_minor), isFood: p.is_food, active: true })),
    slots: boxTemplate.slots.map((s) => ({ ...s, customization: "customization" in s ? ("logo" as const) : undefined })),
    rules: { productionLeadDays: 7 },
  };
  return { merchantId, slug, catalog };
}

async function observe(db: SupabaseClient, inquiryId: string, result: Awaited<ReturnType<typeof runIntakeTurn>>): Promise<Observed> {
  const latest = await latestRequirements(db, inquiryId);
  const status = await db.from("inquiries").select("status").eq("id", inquiryId).single();
  const messages = await db.from("messages").select("role, body, reply_to").eq("inquiry_id", inquiryId).order("created_at", { ascending: false });
  const reply = (messages.data ?? []).find((m) => m.role === "assistant" && m.reply_to !== null)?.body as string | undefined;

  const fields = Object.fromEntries(FIELD_NAMES.map((n: FieldName) => [n, { value: latest?.stored.fields[n].value ?? null, status: latest?.stored.fields[n].status ?? "unknown" }])) as Observed["fields"];
  const base = { fields, proposal: latest?.stored.proposal ?? null, inquiryStatus: status.data?.status as string };
  if (!result.ok) return { ...base, outcome: "FAILED", code: result.code, reply: null, proposal: null };
  const out = result.value;
  if (out.kind === "ASKED") return { ...base, outcome: "ASKED", askedField: out.field as BlockingField, reply: reply ?? null, proposal: null };
  if (out.kind === "HANDED_OFF") return { ...base, outcome: "HANDED_OFF", reply: reply ?? null, proposal: null };
  return { ...base, outcome: "PROPOSED", reply: reply ?? null };
}

/** Plays a scenario's customer messages in order and judges every turn. */
export async function runScenario(db: SupabaseClient, scenario: Scenario, model: ModelPort & { drain(): RecordedCall[] }): Promise<ScenarioRun> {
  const store = await newStore(db, scenario.onHand);
  const ctx = (n: number) => ({ now: new Date(Date.parse(EVAL_NOW) + n * 1000).toISOString(), correlationId: `eval-${scenario.id}` });
  const turns: TurnRun[] = [];

  let inquiryId = "";
  let who: VerifiedInquiryId | null = null;
  for (const [n, turn] of scenario.turns.entries()) {
    let messageId: string;
    if (n === 0) {
      const started = await startInquiry(db, { accessSecret: SECRET }, store.slug, turn.say, ctx(n));
      if (!started.ok) throw new Error(`start ${scenario.id}: ${started.code}`);
      inquiryId = started.value.inquiryId;
      const access = await authorizeCustomerLink(db, started.value.accessToken, { secret: SECRET, now: new Date(EVAL_NOW) });
      if (!access.ok) throw new Error(`link ${scenario.id}`);
      who = access.inquiry.id;
      const first = await db.from("messages").select("id").eq("inquiry_id", inquiryId).eq("role", "customer").limit(1).single();
      messageId = first.data!.id as string;
    } else {
      const posted = await postCustomerMessage(db, who!, turn.say, ctx(n));
      if (!posted.ok) throw new Error(`post ${scenario.id}: ${posted.code}`);
      messageId = posted.value.messageId;
    }
    const result = await runIntakeTurn(db, { model }, who!, messageId, ctx(n));
    const observed = await observe(db, inquiryId, result);
    turns.push({ say: turn.say, calls: model.drain(), observed, verdict: judgeTurn(turn.expect, observed, store.catalog) });
  }
  return { id: scenario.id, turns };
}

