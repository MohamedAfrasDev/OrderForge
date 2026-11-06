import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_STORE_SLUGS, findDemoStores } from "@/lib/demo-store";
import { audit } from "@/lib/audit";
import { agentRef, createAgentRequest, readAgentRequest, type AgentDeps } from "@/services/agent-requests";
import { CatalogLoadError, loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { loadShopProfile } from "@/services/catalog/load-profile";
import { auditInsertFor } from "@/services/reservation/shared";
import type { AgentApiService, StoreInfo, StoreLite } from "./handlers";

/**
 * The real service behind the handlers. The API serves only the demo shops (every shop here is synthetic data); any other address is
 * NOT_FOUND, the same answer as one that does not exist.
 */
export function createAgentApiService(
  db: SupabaseClient,
  deps: AgentDeps,
  clock: { now: () => Date; correlationId: () => string },
  demoSlugs: readonly string[] = DEMO_STORE_SLUGS,
): AgentApiService {
  const isDemoStore = (slug: unknown): slug is string => typeof slug === "string" && demoSlugs.includes(slug);
  const ctx = () => ({ now: clock.now().toISOString(), correlationId: clock.correlationId() });

  /**
   * One audit line per create or read. It names the shop (a public slug), a coded outcome and a short fingerprint of the token, never the
   * token itself, the caller's address or anything the agent sent.
   */
  async function record(action: string, entityId: string, data: Record<string, unknown>): Promise<void> {
    await audit(auditInsertFor(db), { actor: "system:agent", action, entity: "agent_api", entityId, correlationId: clock.correlationId(), data });
  }

  async function lite(slug: string, name: string): Promise<StoreLite> {
    const merchant = await db.from("merchants").select("id").eq("slug", slug).single();
    if (merchant.error) throw new Error(`load merchant: ${merchant.error.message}`);
    const profile = await loadShopProfile(db, merchant.data.id as string);
    return { slug, name, kind: profile.productKind };
  }

  return {
    async listStores() {
      const found = await findDemoStores(db, demoSlugs);
      return Promise.all(found.map((s) => lite(s.slug, s.name)));
    },

    async describeStore(slug): Promise<StoreInfo | null> {
      if (!isDemoStore(slug)) return null;
      const [store] = await findDemoStores(db, [slug]);
      if (!store) return null;
      const merchant = await db.from("merchants").select("id").eq("slug", slug).single();
      if (merchant.error) throw new Error(`load merchant: ${merchant.error.message}`);
      try {
        const { catalog } = await loadCatalogSnapshot(db, merchant.data.id as string);
        return { ...(await lite(slug, store.name)), parts: catalog.slots.map((s) => ({ id: s.id, label: s.label })) };
      } catch (e) {
        if (e instanceof CatalogLoadError) return null;
        throw e;
      }
    },

    async create(slug, body) {
      // A create that works is audited inside createAgentRequest (with the new request); the rest are audited here.
      const store = isDemoStore(slug) ? slug : "(other)";
      const out = isDemoStore(slug) ? await createAgentRequest(db, deps, slug, body, ctx()) : ({ ok: false, code: "NOT_FOUND" } as const);
      if (!out.ok) await record("agent.request_refused", store, { store, outcome: out.code });
      return out;
    },

    async read(requestId, token) {
      const out = await readAgentRequest(db, deps, requestId, token, clock.now());
      const known = typeof requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId);
      await record("agent.request_read", known ? requestId : "invalid", { outcome: out.ok ? "ok" : out.code, agent_ref: typeof token === "string" && token ? agentRef(token) : "none" });
      return out;
    },
  };
}
