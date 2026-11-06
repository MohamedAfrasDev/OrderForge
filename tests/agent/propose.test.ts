// The box an agent request gets is chosen and priced by code alone, with the same engine the web flow uses.
import { describe, expect, it } from "vitest";
import type { Catalog, Stock } from "@/domain/catalog/types";
import { proposeForRequest } from "@/services/agent-requests/propose";
import { demoCatalog, demoProducts, demoStock } from "../catalog/fixtures";

type Body = Parameters<typeof proposeForRequest>[0]["body"];
const body = (over: Record<string, unknown> = {}): Body => ({ boxCount: 20, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000, ...over }) as Body;
const run = (b: Body = body(), catalog: Catalog = demoCatalog, stock: Stock = demoStock) => proposeForRequest({ body: b, catalog, stock, today: "2026-11-06" });

describe("proposeForRequest", () => {
  it("20 boxes: the first allowed product per part, priced by code: $35 a box, $700", () => {
    const r = run();
    expect(r.status).toBe("VALID");
    expect(r.blockers).toEqual([]);
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ kind: "BOX", perBoxMinor: 3500, totalMinor: 70000, boxCount: 20, currency: "USD" });
    expect(r.proposals[0]!.lines.map((l) => l.sku)).toEqual(["NB-01", "PN-01", "BOT-01", "CARD-01", "PKG-01"]);
    expect(r.proposals[0]!.lines.map((l) => l.unitPriceMinor)).toEqual([1200, 300, 1300, 200, 500]);
  });

  it("30 boxes: the bottle (24 in stock) is blocked and the organizer is offered: $36 a box, $1,080", () => {
    const r = run(body({ boxCount: 30 }));
    expect(r.status).toBe("BLOCKED");
    expect(r.blockers).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "BOT-01", needed: 30, available: 24 }]);
    const swap = r.proposals.find((p) => p.swap?.toSku === "ORG-01");
    expect(swap).toMatchObject({ kind: "SWAP", perBoxMinor: 3600, totalMinor: 108000, swap: { slotId: "gift", fromSku: "BOT-01", toSku: "ORG-01" } });
  });

  it("every figure is an integer number of cents", () => {
    for (const p of [...run().proposals, ...run(body({ boxCount: 30 })).proposals]) {
      for (const n of [p.perBoxMinor, p.totalMinor, ...p.lines.map((l) => l.unitPriceMinor)]) expect(Number.isInteger(n)).toBe(true);
    }
  });

  it("no food: a food product is never the default choice", () => {
    expect(run().proposals[0]!.lines.some((l) => l.sku === "TRF-01")).toBe(false);
    expect(run().proposals[0]!.lines.find((l) => l.slotId === "gift")!.sku).toBe("BOT-01");
  });

  it("skips an inactive product when choosing", () => {
    const catalog: Catalog = { ...demoCatalog, products: demoProducts.map((p) => (p.sku === "BOT-01" ? { ...p, active: false } : p)) };
    expect(run(body(), catalog).proposals[0]!.lines.find((l) => l.slotId === "gift")!.sku).toBe("ORG-01");
  });

  it("over budget: a coded blocker, and no option is silently over the budget", () => {
    const r = run(body({ maxPricePerBoxMinor: 1000 }));
    expect(r.status).toBe("BLOCKED");
    expect(r.blockers.some((b) => b.code === "OVER_BUDGET")).toBe(true);
    expect(r.proposals).toEqual([]);
  });

  it("a pickup date that is too early is a coded blocker", () => {
    const catalog: Catalog = { ...demoCatalog, rules: { productionLeadDays: 7 } };
    expect(run(body({ requestedPickupDate: "2026-11-07" }), catalog).blockers.some((b) => b.code === "UNSUPPORTED_DATE")).toBe(true);
  });

  it("is deterministic: the same input gives the same answer", () => {
    expect(JSON.stringify(run(body({ boxCount: 30 })))).toBe(JSON.stringify(run(body({ boxCount: 30 }))));
  });

  it("gives the stored form the order room reads: selections, status, code's price, alternatives with keys and no explanation", () => {
    const valid = run().stored;
    expect(valid).toMatchObject({ status: "VALID", blockers: [], priced: { perBoxMinor: 3500, totalMinor: 70000, boxCount: 20 }, alternatives: [] });
    const blocked = run(body({ boxCount: 30 })).stored;
    expect(blocked).toMatchObject({ status: "BLOCKED", priced: null, blockers: ["INSUFFICIENT_STOCK"] });
    expect(blocked.alternatives[0]).toMatchObject({ key: "alt-0", slotId: "gift", fromSku: "BOT-01", toSku: "ORG-01", perBoxMinor: 3600, totalMinor: 108000, explanation: null });
  });
});
