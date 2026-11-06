// The agent API can never pay, accept, publish a price or touch fulfilment. This reads the import graph: starting from every file of the
// agent API, no chain of imports may reach a payment, PayPal, fulfilment, quote-publishing or merchant-side module. If someone adds such an
// import, even through a helper, this fails and names the chain.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { importsOf } from "../catalog/purity.test";

const ROOTS = ["services/agent-requests", "lib/agent-api", "app/api/agent"];
const SINGLE_FILES = ["lib/access/agent-token.ts"];

/** Modules the agent API must never reach. */
const FORBIDDEN: Array<{ why: string; test: (file: string) => boolean }> = [
  { why: "payments", test: (f) => f.startsWith("services/payments/") || f.startsWith("lib/payments/") },
  { why: "PayPal", test: (f) => f.startsWith("lib/paypal/") },
  { why: "fulfilment", test: (f) => f.startsWith("services/fulfillment/") },
  { why: "publishing, accepting or drafting a quote", test: (f) => ["services/quote/publish.ts", "services/quote/accept.ts", "services/quote/create-draft.ts"].includes(f) },
  { why: "choosing a box into a quote, or building one as the shop", test: (f) => ["services/intake/choose.ts", "services/intake/merchant-quote.ts", "services/intake/merchant.ts"].includes(f) },
  { why: "the shop's catalog editing", test: (f) => f === "services/catalog/edit.ts" },
  { why: "the shop's session", test: (f) => f.startsWith("lib/access/require-merchant") || f === "lib/access/merchant.ts" },
];
const ADMIN = "lib/supabase/admin.ts";
const WIRING = "lib/agent-api/wiring.ts";

const norm = (p: string) => p.replace(/\\/g, "/");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [norm(full)] : [];
  });
}

function resolve(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = posix.normalize(posix.join(dirname(from), spec));
  else return null; // a package or a node: module
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return norm(candidate);
  }
  return null;
}

const importsFrom = (file: string): string[] => importsOf(readFileSync(file, "utf8")).flatMap((s) => resolve(s, file) ?? []);

/** Every file reachable from `entries`, each with the chain of imports that reaches it. */
function reachable(entries: string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>(entries.map((e) => [e, [e]]));
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const dep of importsFrom(file)) {
      if (seen.has(dep)) continue;
      seen.set(dep, [...seen.get(file)!, dep]);
      queue.push(dep);
    }
  }
  return seen;
}

const entries = [...ROOTS.flatMap(walk), ...SINGLE_FILES];

describe("the agent API has no path to payment", () => {
  it("finds the API's files (so this test cannot pass by looking at nothing)", () => {
    expect(entries.length).toBeGreaterThanOrEqual(14);
    for (const must of ["services/agent-requests/create.ts", "services/agent-requests/read.ts", "lib/agent-api/handlers.ts", "app/api/agent/v1/stores/[slug]/requests/route.ts", "lib/access/agent-token.ts"]) {
      expect(entries, must).toContain(must);
    }
  });

  it("resolves imports (the graph reaches into shared code, so a forbidden import would be seen)", () => {
    const graph = reachable(entries);
    expect(graph.has("services/catalog/load-snapshot.ts")).toBe(true);
    expect(graph.has("domain/catalog/validate.ts")).toBe(true);
    expect(graph.size).toBeGreaterThan(entries.length + 10);
  });

  it.each(FORBIDDEN.map((f) => [f.why, f] as const))("no chain of imports reaches %s", (_why, rule) => {
    const hits = [...reachable(entries)].filter(([file]) => rule.test(file));
    expect(hits.map(([file, chain]) => `${file} via ${chain.join(" -> ")}`)).toEqual([]);
  });

  it("the admin database client is imported only by the wiring file, and nothing else the API contains or reaches imports it", () => {
    const importers = [...reachable(entries).keys()].filter((file) => importsFrom(file).includes(ADMIN));
    expect(importers).toEqual([WIRING]);
  });

  it("the route files are thin: they import only the handlers and the wiring", () => {
    for (const file of entries.filter((f) => f.startsWith("app/api/agent/"))) {
      const specs = importsOf(readFileSync(file, "utf8"));
      expect(specs.filter((s) => !["@/lib/agent-api/handlers", "@/lib/agent-api/wiring"].includes(s)), file).toEqual([]);
    }
  });

  it("the analysis does notice a forbidden import (a planted file that imports the payment service is caught)", () => {
    const planted = "services/agent-requests/__planted__.ts";
    const graph = (() => {
      // The same walk, with one extra edge that does not exist on disk.
      const seen = reachable(entries);
      seen.set("services/payments/decide.ts", [planted, "services/payments/decide.ts"]);
      return seen;
    })();
    expect([...graph].some(([file]) => FORBIDDEN[0]!.test(file))).toBe(true);
  });
});
