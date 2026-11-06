import type { SupabaseClient } from "@supabase/supabase-js";
import type { Blocker } from "@/domain/catalog/types";
import type { InquiryStatus } from "@/domain/intake";
import { createAgentToken } from "@/lib/access/agent-token";
import { authorizeCustomerLink } from "@/lib/access/inquiry-reads";
import { cents, format } from "@/lib/money";
import { CatalogLoadError, loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { editRequirements } from "@/services/intake/edit";
import { appendMessage, appendRequirements, auditIntake, transitionInquiry, type ServiceContext } from "@/services/intake/shared";
import { startInquiry } from "@/services/intake/start";
import { proposalText } from "@/services/intake/turn";
import { proposeForRequest, type AgentProposal } from "./propose";
import { parseAgentBody, type AgentBody, type AgentIssue } from "./schema";

const DAY_MS = 86_400_000;
const DEFAULT_LINK_DAYS = 14;
const ACTOR = "system:agent";

export type AgentDeps = { accessSecret: string; linkDays?: number };

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

export type AgentResult<T> = { ok: true; value: T } | { ok: false; code: "NOT_FOUND" } | { ok: false; code: "INVALID_INPUT"; issues: AgentIssue[] };

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
  await appendMessage(db, inquiryId, "assistant", proposalText(proposed.stored, (sku) => names.get(sku) ?? sku, body.boxCount), ctx);
  const moved = await transitionInquiry(db, inquiryId, { type: "CLEAR" }, ctx, ACTOR);

  const row = await db.from("inquiries").select("access_version").eq("id", inquiryId).single();
  if (row.error) throw new Error(`read access version: ${row.error.message}`);
  const requestToken = createAgentToken({
    requestId: inquiryId,
    version: row.data.access_version as number,
    expiresAt: new Date(Date.parse(ctx.now) + (deps.linkDays ?? DEFAULT_LINK_DAYS) * DAY_MS),
    secret: deps.accessSecret,
  });

  await auditIntake(db, ctx, ACTOR, "intake.agent_request_created", inquiryId, { to: moved.ok ? moved.status : "NEW" });
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
