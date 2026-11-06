import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_STORE_SLUGS, findDemoStores } from "@/lib/demo-store";
import { createAgentRequest, readAgentRequest, type AgentDeps } from "@/services/agent-requests";
import { CatalogLoadError, loadCatalogSnapshot } from "@/services/catalog/load-snapshot";
import { loadShopProfile } from "@/services/catalog/load-profile";
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
      if (!isDemoStore(slug)) return { ok: false, code: "NOT_FOUND" };
      return createAgentRequest(db, deps, slug, body, ctx());
    },

    async read(requestId, token) {
      return readAgentRequest(db, deps, requestId, token, clock.now());
    },
  };
}
