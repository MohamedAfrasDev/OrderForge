import { describe, expect, it } from "vitest";
import type { Catalog } from "@/domain/catalog";
import { cents } from "@/lib/money";
import { MAX_TOOL_CALLS, TOOL_NAMES, createToolDispatcher } from "@/services/intake/tools";

const product = (sku: string, price: number, isFood = false) => ({ id: `id-${sku}`, sku, name: sku, category: "x", unitPriceMinor: cents(price), isFood, active: true });
const catalog: Catalog = {
  products: [product("A", 1000), product("B", 1500), product("FOOD", 500, true)],
  slots: [{ id: "main", label: "Main", quantity: 1, allowedSkus: ["A", "B", "FOOD"] }],
  rules: { productionLeadDays: 0 },
};
const base = { catalog, stock: { "id-A": 100, "id-B": 5, "id-FOOD": 100 }, requirements: { noFood: true, logoRequired: false }, boxCount: 10, today: "2026-11-03" };

describe("the turn's tool dispatcher", () => {
  it("offers exactly three read-only tools", () => {
    expect([...TOOL_NAMES]).toEqual(["read_catalog", "validate_configuration", "calculate_quote"]);
  });

  it("refuses every name outside the allowlist, including the ones code runs itself", () => {
    for (const name of ["create_quote_draft", "request_merchant_review", "start_checkout", "publish_quote", "set_price", "__proto__", ""]) {
      expect(createToolDispatcher(base).call(name, {}), name).toEqual({ ok: false, code: "UNKNOWN_TOOL" });
    }
  });

  it("read_catalog shows what the model may see and takes no arguments", () => {
    const tools = createToolDispatcher(base);
    const out = tools.call("read_catalog", {});
    expect(out.ok && JSON.stringify(out.result)).not.toContain("id-A");
    expect(tools.call("read_catalog", { sku: "A" })).toEqual({ ok: false, code: "INVALID_ARGS" });
  });

  it("validate_configuration uses the quantity and requirements code fixed, and nothing the caller sends", () => {
    const tools = createToolDispatcher(base);
    const food = tools.call("validate_configuration", { selections: { main: "FOOD" } });
    expect(food.ok && !food.result.ok && food.result.blockers.map((b) => b.code)).toEqual(["FOOD_NOT_ALLOWED"]);
    const short = tools.call("validate_configuration", { selections: { main: "B" } });
    expect(short.ok && !short.result.ok && short.result.blockers[0]).toMatchObject({ code: "INSUFFICIENT_STOCK", needed: 10, available: 5 });
    const good = tools.call("validate_configuration", { selections: { main: "A" } });
    expect(good.ok && good.result.ok && good.result.priced.totalMinor).toBe(10_000);
    for (const args of [{ selections: { main: "A" }, boxCount: 1 }, { selections: { main: "A" }, price: 1 }, { selections: { main: "A" }, requirements: {} }, { selections: ["A"] }, null, "A"]) {
      expect(createToolDispatcher(base).call("validate_configuration", args), JSON.stringify(args)).toEqual({ ok: false, code: "INVALID_ARGS" });
    }
  });

  it("calculate_quote prices through the catalog engine, and a bad selection is a refusal not a crash", () => {
    const tools = createToolDispatcher(base);
    const out = tools.call("calculate_quote", { selections: { main: "A" } });
    expect(out.ok && out.result.totalMinor).toBe(10_000);
    expect(tools.call("calculate_quote", { selections: { main: "NOPE" } })).toEqual({ ok: false, code: "INVALID_ARGS" });
    expect(tools.call("calculate_quote", { selections: { nope: "A" } })).toEqual({ ok: false, code: "INVALID_ARGS" });
  });

  it("without a confirmed quantity nothing is validated or priced", () => {
    const tools = createToolDispatcher({ ...base, boxCount: null });
    expect(tools.call("validate_configuration", { selections: { main: "A" } })).toEqual({ ok: false, code: "NO_QUANTITY" });
    expect(tools.call("calculate_quote", { selections: { main: "A" } })).toEqual({ ok: false, code: "NO_QUANTITY" });
  });

  it("allows six calls in a turn; the seventh is refused and does nothing, and refused calls count", () => {
    const tools = createToolDispatcher(base);
    for (let i = 0; i < MAX_TOOL_CALLS; i++) expect(tools.call("read_catalog", {}).ok).toBe(true);
    expect(tools.call("read_catalog", {})).toEqual({ ok: false, code: "TOOL_LIMIT" });
    expect(tools.used).toBe(MAX_TOOL_CALLS + 1);

    const probing = createToolDispatcher(base);
    for (let i = 0; i < MAX_TOOL_CALLS; i++) probing.call("start_checkout", {});
    expect(probing.call("read_catalog", {})).toEqual({ ok: false, code: "TOOL_LIMIT" });
  });
});
