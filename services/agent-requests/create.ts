import type { SupabaseClient } from "@supabase/supabase-js";
import type { Blocker } from "@/domain/catalog/types";
import type { InquiryStatus } from "@/domain/intake";
import { createAgentToken } from "@/lib/access/agent-token";
import { authorizeCustomerLink } from "@/lib/access/inquiry-reads";
import { sha256Hex } from "@/lib/hash";
import { cents, format } from "@/lib/money";
import { CatalogLoadError, loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { editRequirements } from "@/services/intake/edit";
import { appendRequirements, auditIntake, transitionInquiry, type ServiceContext } from "@/services/intake/shared";
import { startInquiry } from "@/services/intake/start";
import { proposalText } from "@/services/intake/turn";
import { proposeForRequest, type AgentProposal } from "./propose";
import { parseAgentBody, type AgentBody, type AgentIssue } from "./schema";

const DAY_MS = 86_400_000;
const DEFAULT_LINK_DAYS = 14;
const ACTOR = "system:agent";

/** Requests one shop takes through the agent interface in 24 hours. A brake on abuse, counted from the audit trail (no table of its own). */
export const DEFAULT_DAILY_CAP_PER_STORE = 200;
const CAP_RETRY_SECONDS = 3600;

/** What an audit line may say about a token: a short fingerprint, never the token. */
export const agentRef = (token: string): string => sha256Hex(token).slice(0, 8);

export type AgentDeps = { accessSecret: string; linkDays?: number; dailyCapPerStore?: number };

export type AgentCreated = {
  requestId: string;
  status: InquiryStatus;
  /** The order-room link a HUMAN opens to choose, accept and pay. The agent can do none of those. */
  humanToken: string;
  /** Lets the agent read this request's proposals again. Read-only; not a customer link. */
  requestToken: string;
  proposalStatus: "VALID" | "BLOCKED";
  proposals: AgentProposal[];
  blockers: Blocker[];
};

export type AgentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "INVALID_INPUT"; issues: AgentIssue[] }
  | { ok: false; code: "RATE_LIMITED"; retryAfterSeconds: number };

/** The first message of the conversation, built by code from the validated values. No text from the agent is ever stored as a message. */
export function firstMessageFor(body: AgentBody): string {
  const parts = [
    `${body.boxCount} ${body.boxCount === 1 ? "box" : "boxes"}`,
    body.noFood ? "no food" : "food is fine",
    body.logoRequired ? "logo needed" : "no logo",
    `budget up to ${format(cents(body.maxPricePerBoxMinor))} per box`,
    ...(body.requestedPickupDate ? [`pickup on or after ${body.requestedPickupDate}`] : []),
  ];
  return `Request sent through the agent interface: ${parts.join(", ")}.`;
}

/**
 * An agent asks a shop for a priced box. The body is strictly validated (five intake fields, nothing else) before anything is written. The
 * request is then an ordinary inquiry: the values are stored as the customer's own confirmed answers, code chooses and prices a box with the
 * catalog engine (no model call), and the proposal is stored the way the order room reads it, so a human who opens `humanToken` sees it and
 * chooses, accepts and pays there. This function never creates a quote, a purchase or any payment row.
 */
export async function createAgentRequest(db: SupabaseClient, deps: AgentDeps, slug: unknown, rawBody: unknown, ctx: ServiceContext): Promise<AgentResult<AgentCreated>> {
  const parsed = parseAgentBody(rawBody);
  if (!parsed.ok) return { ok: false, code: "INVALID_INPUT", issues: parsed.issues };
  const body = parsed.value;
  if (typeof slug !== "string") return { ok: false, code: "NOT_FOUND" };

  const merchant = await db.from("merchants").select("id").eq("slug", slug).maybeSingle();
  if (merchant.error) throw new Error(`load merchant: ${merchant.error.message}`);
  if (!merchant.data) return { ok: false, code: "NOT_FOUND" };

  // The daily cap, counted from the audit trail: requests this shop took through this interface in the last 24 hours.
  const cap = deps.dailyCapPerStore ?? DEFAULT_DAILY_CAP_PER_STORE;
  const since = new Date(Date.parse(ctx.now) - DAY_MS).toISOString();
  const used = await db.from("audit_events").select("id", { count: "exact", head: true }).eq("action", "intake.agent_request_created").eq("data->>store", slug).gte("created_at", since);
  if (used.error) throw new Error(`count agent requests: ${used.error.message}`);
  if ((used.count ?? 0) >= cap) return { ok: false, code: "RATE_LIMITED", retryAfterSeconds: CAP_RETRY_SECONDS };

  // Read the catalog first, so a shop that cannot take requests leaves nothing behind.
  let snapshot;
  try {
    snapshot = await loadCatalogSnapshot(db, merchant.data.id as string);
  } catch (error) {
    if (error instanceof CatalogLoadError) return { ok: false, code: "NOT_FOUND" };
    throw error;
  }

  const started = await startInquiry(db, { accessSecret: deps.accessSecret, linkDays: deps.linkDays }, slug, firstMessageFor(body), ctx);
  if (!started.ok) return { ok: false, code: "NOT_FOUND" };
  const { inquiryId, accessToken } = started.value;

  const access = await authorizeCustomerLink(db, accessToken, { secret: deps.accessSecret, now: new Date(ctx.now) });
  if (!access.ok) throw new Error("a link just made was not accepted");
  const edits = {
    boxCount: body.boxCount,
    noFood: body.noFood,
    logoRequired: body.logoRequired,
    maxPricePerBoxMinor: body.maxPricePerBoxMinor,
    ...(body.requestedPickupDate ? { requestedPickupDate: body.requestedPickupDate } : {}),
  };
  const edited = await editRequirements(db, access.inquiry.id, edits, ctx);
  if (!edited.ok) throw new Error(`the validated values were refused: ${edited.code}`);

  const proposed = proposeForRequest({ body, catalog: snapshot.catalog, stock: snapshot.stock, today: ctx.now.slice(0, 10) });
  await appendRequirements(db, inquiryId, (latest) => ({ schema: latest!.stored.schema, fields: latest!.stored.fields, proposal: proposed.stored, question: null }), null);
  const names = new Map(snapshot.catalog.products.map((p) => [p.sku, p.name]));
  // The reply is linked to the message it answers, as the assistant's replies are, so the order room does not treat the request as unanswered
  // (it would show a stalled header and offer to run the assistant again).
  const first = await db.from("messages").select("id, created_at").eq("inquiry_id", inquiryId).eq("role", "customer").order("created_at").limit(1).single();
  if (first.error) throw new Error(`load first message: ${first.error.message}`);
  const replyAt = new Date(Math.max(Date.parse(ctx.now), Date.parse(first.data.created_at as string) + 1)).toISOString();
  const reply = await db.from("messages").insert({
    inquiry_id: inquiryId,
    role: "assistant",
    body: proposalText(proposed.stored, (sku) => names.get(sku) ?? sku, body.boxCount),
    reply_to: first.data.id,
    created_at: replyAt,
  });
  if (reply.error) throw new Error(`store reply: ${reply.error.message}`);
  const moved = await transitionInquiry(db, inquiryId, { type: "CLEAR" }, ctx, ACTOR);

  const row = await db.from("inquiries").select("access_version").eq("id", inquiryId).single();
  if (row.error) throw new Error(`read access version: ${row.error.message}`);
  const requestToken = createAgentToken({
    requestId: inquiryId,
    version: row.data.access_version as number,
    expiresAt: new Date(Date.parse(ctx.now) + (deps.linkDays ?? DEFAULT_LINK_DAYS) * DAY_MS),
    secret: deps.accessSecret,
  });

  await auditIntake(db, ctx, ACTOR, "intake.agent_request_created", inquiryId, { to: moved.ok ? moved.status : "NEW", store: slug, agent_ref: agentRef(requestToken) });
  return {
    ok: true,
    value: {
      requestId: inquiryId,
      status: moved.ok ? moved.status : "NEW",
      humanToken: accessToken,
      requestToken,
      proposalStatus: proposed.status,
      proposals: proposed.proposals,
      blockers: proposed.blockers,
    },
  };
}
