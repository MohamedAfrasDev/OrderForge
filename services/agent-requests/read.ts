import type { SupabaseClient } from "@supabase/supabase-js";
import type { Blocker } from "@/domain/catalog/types";
import { confirmedBoxCount, type InquiryStatus } from "@/domain/intake";
import { verifyAgentToken } from "@/lib/access/agent-token";
import { CatalogLoadError, loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { latestRequirements } from "@/services/intake/shared";
import type { AgentDeps, AgentResult } from "./create";
import { proposeForRequest, type AgentProposal } from "./propose";
import type { AgentBody } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentRequestView = {
  requestId: string;
  /** Where the request is, as the shop's own system names it (for example CONFIGURING, QUOTE_READY, REVIEW_REQUIRED). */
  status: InquiryStatus;
  /** Computed now, by code, from the request's current confirmed values and the shop's current stock. Null when a required value is missing. */
  proposalStatus: "VALID" | "BLOCKED" | null;
  proposals: AgentProposal[];
  blockers: Blocker[];
  /** The required values that are not set (a human may have cleared one in the order room). */
  missing: string[];
};

const confirmed = <T>(f: { value: T | null; status: string } | undefined): T | undefined => (f && f.status === "confirmed" && f.value !== null ? f.value : undefined);

/**
 * What an agent may read about the request it made, with the token it was given. Anything wrong (a malformed, expired, revoked, forged or
 * mismatched token, a customer link, another request's token, a request that does not exist) is the same NOT_FOUND, so the answer says nothing
 * about whether a request exists. Read-only: it writes nothing, and the token grants nothing else.
 */
export async function readAgentRequest(db: SupabaseClient, deps: AgentDeps, requestId: unknown, token: unknown, now: Date = new Date()): Promise<AgentResult<AgentRequestView>> {
  const notFound = { ok: false, code: "NOT_FOUND" } as const;
  if (typeof requestId !== "string" || !UUID.test(requestId) || typeof token !== "string") return notFound;

  const signed = verifyAgentToken(token, { secret: deps.accessSecret, now });
  if (!signed.ok || signed.requestId !== requestId) return notFound;

  const row = await db.from("inquiries").select("id, status, merchant_id, access_version").eq("id", requestId).maybeSingle();
  if (row.error) throw new Error(`read request: ${row.error.message}`);
  if (!row.data || row.data.access_version !== signed.version) return notFound;

  const latest = await latestRequirements(db, requestId);
  const fields = latest?.stored.fields;
  const boxCount = fields ? confirmedBoxCount(fields) : undefined;
  const values = {
    boxCount: boxCount ?? undefined,
    noFood: confirmed<boolean>(fields?.noFood),
    logoRequired: confirmed<boolean>(fields?.logoRequired),
    maxPricePerBoxMinor: confirmed<number>(fields?.maxPricePerBoxMinor),
    requestedPickupDate: confirmed<string>(fields?.requestedPickupDate),
  };
  const missing = (["boxCount", "noFood", "logoRequired", "maxPricePerBoxMinor"] as const).filter((k) => values[k] === undefined);
  const status = row.data.status as InquiryStatus;
  if (missing.length > 0) return { ok: true, value: { requestId, status, proposalStatus: null, proposals: [], blockers: [], missing } };

  let snapshot;
  try {
    snapshot = await loadCatalogSnapshot(db, row.data.merchant_id as string);
  } catch (error) {
    if (error instanceof CatalogLoadError) return notFound;
    throw error;
  }
  const body = values as unknown as AgentBody;
  const proposed = proposeForRequest({ body, catalog: snapshot.catalog, stock: snapshot.stock, today: now.toISOString().slice(0, 10) });
  return { ok: true, value: { requestId, status, proposalStatus: proposed.status, proposals: proposed.proposals, blockers: proposed.blockers, missing: [] } };
}
