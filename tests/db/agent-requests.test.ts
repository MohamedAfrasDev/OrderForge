// Real local Postgres. The agent request services: code chooses and prices the box (no model is passed to them), the figures equal the web
// flow's, the human link opens the request in the normal order room, the agent token reads and nothing else, and no payment row is ever made.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createAgentToken } from "@/lib/access/agent-token";
import { authorizeCustomerLink } from "@/lib/access/inquiry-reads";
import { createFakeModel } from "@/lib/ai";
import { chooseConfiguration } from "@/services/intake/choose";
import { unansweredMessageId } from "@/services/intake/read";
import { runIntakeTurn } from "@/services/intake/turn";
import { createAgentRequest, readAgentRequest } from "@/services/agent-requests";
import { boxTemplate2, products2, stock2 } from "../../supabase/seed/fixtures";
import { must, serviceClient } from "./helpers";
import { NOW, SECRET, ctx, deps, messagesOf, versionsOf } from "./intake-helpers";
import { BOTTLE_BOX, begin, catalogMerchant, readA, say } from "./intake-fixtures";
import { trackProducts } from "./reservation-helpers";

const db = serviceClient();
const now = new Date(NOW);
const body = (over: Record<string, unknown> = {}) => ({ boxCount: 20, noFood: true, logoRequired: true, maxPricePerBoxMinor: 4000, ...over });
const statusOf = async (id: string) => must(await db.from("inquiries").select("status").eq("id", id).single()).status as string;
const count = async (table: string): Promise<number> => {
  const r = await db.from(table).select("id", { count: "exact", head: true });
  if (r.error) throw new Error(`${table}: ${r.error.message}`);
  return r.count ?? 0;
};

async function kitMerchant(client: SupabaseClient): Promise<{ merchantId: string; slug: string }> {
  const slug = `kit-${randomUUID().slice(0, 8)}`;
  const merchantId = must(await client.from("merchants").insert({ slug, name: "Agent kit shop" }).select("id").single(), "merchant").id as string;
  const ids = new Map(products2.map((p) => [p.id, randomUUID()]));
  must(await client.from("products").insert(products2.map((p) => ({ ...p, id: ids.get(p.id)!, merchant_id: merchantId }))), "products");
  must(await client.from("stock").insert(stock2.map((s) => ({ ...s, product_id: ids.get(s.product_id)! }))), "stock");
  must(await client.from("business_rules").insert([{ merchant_id: merchantId, key: "box_template", value: boxTemplate2 }, { merchant_id: merchantId, key: "production_lead_days", value: { days: 7 } }]), "rules");
  trackProducts(ids.values());
  return { merchantId, slug };
}

async function created(slug: string, over: Record<string, unknown> = {}) {
  const out = await createAgentRequest(db, deps, slug, body(over), ctx);
  if (!out.ok) throw new Error(`create: ${out.code}`);
  return out.value;
}

describe("createAgentRequest: 20 boxes", () => {
  it("proposes the box in code: $35.00 a box, $700.00, no blockers, with a human link and a read token", async () => {
    const m = await catalogMerchant(db);
    const r = await created(m.slug);
    expect(r.proposalStatus).toBe("VALID");
    expect(r.blockers).toEqual([]);
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ kind: "BOX", perBoxMinor: 3500, totalMinor: 70_000, boxCount: 20, currency: "USD" });
    expect(r.proposals[0]!.lines.map((l) => l.sku)).toEqual(["NOTEBOOK-A5", "PEN-BLK", "BOTTLE-STEEL", "CARD-BRANDED", "PACK-BOX"]);
    expect(r.status).toBe("CONFIGURING");
    expect(await statusOf(r.requestId)).toBe("CONFIGURING");
  });

  it("stores the values as the customer's own confirmed answers and the proposal the order room reads", async () => {
    const m = await catalogMerchant(db);
    const r = await created(m.slug, { requestedPickupDate: "2026-12-15" });
    const versions = await versionsOf(db, r.requestId);
    const last = versions.at(-1)!.requirements as unknown as { fields: Record<string, { value: unknown; status: string; source: string }>; proposal: { status: string; priced: { perBoxMinor: number; totalMinor: number } | null } };
    expect(last.fields.boxCount).toMatchObject({ value: 20, status: "confirmed", source: "customer_edit" });
    expect(last.fields.noFood).toMatchObject({ value: true, status: "confirmed" });
    expect(last.fields.maxPricePerBoxMinor).toMatchObject({ value: 4000, status: "confirmed" });
    expect(last.fields.requestedPickupDate).toMatchObject({ value: "2026-12-15", status: "confirmed" });
    expect(last.proposal).toMatchObject({ status: "VALID", priced: { perBoxMinor: 3500, totalMinor: 70_000 } });
  });

  it("the conversation has code's own first message and code's reply, and none of the agent's words", async () => {
    const m = await catalogMerchant(db);
    const r = await created(m.slug);
    const messages = await messagesOf(db, r.requestId);
    expect(messages.map((x) => x.role)).toEqual(["customer", "assistant"]);
    expect(messages[0]!.body).toBe("Request sent through the agent interface: 20 boxes, no food, logo needed, budget up to $40.00 per box.");
    expect(messages[1]!.body).toContain("$35.00 per box");
    expect(messages[1]!.body).toContain("$700.00");
  });

  it("the reply is linked to the message it answers, so the order room does not treat the request as unanswered", async () => {
    const m = await catalogMerchant(db);
    const r = await created(m.slug);
    const access = await authorizeCustomerLink(db, r.humanToken, { secret: SECRET, now });
    if (!access.ok) throw new Error("link");
    expect(await unansweredMessageId(db, access.inquiry.id)).toBeNull();
    const messages = await messagesOf(db, r.requestId);
    expect(messages[1]!.reply_to).toBe(messages[0]!.id);
  });

  it("the human link opens the request, and the human can choose the box in the normal flow", async () => {
    const m = await catalogMerchant(db);
    const r = await created(m.slug);
    const access = await authorizeCustomerLink(db, r.humanToken, { secret: SECRET, now });
    expect(access.ok && access.inquiry.id).toBe(r.requestId);
    if (!access.ok) return;
    const chosen = await chooseConfiguration(db, {}, access.inquiry.id, "proposal", ctx);
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(chosen.value).toMatchObject({ boxCount: 20, perBoxMinor: 3500, totalMinor: 70_000 });
  });

  it("makes no quote, purchase or payment row of its own", async () => {
    const m = await catalogMerchant(db);
    const tables = ["quote_versions", "approvals", "purchases", "payment_attempts", "reservations", "preparation_jobs"];
    const before = await Promise.all(tables.map(count));
    await created(m.slug);
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });

  it("the agent token is not the customer link, and the customer link is not the agent token", async () => {
    const m = await catalogMerchant(db);
    const r = await created(m.slug);
    expect(r.requestToken).not.toBe(r.humanToken);
    expect((await authorizeCustomerLink(db, r.requestToken, { secret: SECRET, now })).ok).toBe(false);
    expect(await readAgentRequest(db, deps, r.requestId, r.humanToken, now)).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("createAgentRequest: the figures equal the web flow's", () => {
  it("20 boxes: the same price as a scripted-model turn for the same words", async () => {
    const m = await catalogMerchant(db);
    const web = await begin(db, m.slug, "20 welcome boxes, notebooks, no food, our logo, under $40 per box");
    const out = await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [readA], propose: [{ selections: BOTTLE_BOX }] } }) }, web.who, web.messageId, ctx);
    if (!out.ok || out.value.kind !== "PROPOSED") throw new Error("expected a proposal");

    const agent = await created(m.slug);
    expect(agent.proposals[0]).toMatchObject({ perBoxMinor: out.value.proposal.priced!.perBoxMinor, totalMinor: out.value.proposal.priced!.totalMinor });
  });

  it("30 boxes: the same blocker and the same swap, $36.00 a box, $1,080.00", async () => {
    const m = await catalogMerchant(db);
    const web = await begin(db, m.slug, "20 welcome boxes, notebooks, no food, our logo, under $40 per box");
    await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [readA], propose: [{ selections: BOTTLE_BOX }] } }) }, web.who, web.messageId, ctx);
    const second = await say(db, web.inquiryId, "Actually we need 30 boxes");
    const out = await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [{ boxCount: { value: 30, status: "confirmed" } }], propose: [{ selections: BOTTLE_BOX }], rank: [{ ranking: [{ index: 0, explanation: "Useful every day." }] }] } }) }, web.who, second, ctx);
    if (!out.ok || out.value.kind !== "PROPOSED") throw new Error("expected a proposal");

    const agent = await created(m.slug, { boxCount: 30 });
    expect(agent.proposalStatus).toBe("BLOCKED");
    expect(agent.blockers).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "BOTTLE-STEEL", needed: 30, available: 24 }]);
    const alt = out.value.proposal.alternatives[0]!;
    expect(agent.proposals).toHaveLength(1);
    expect(agent.proposals[0]).toMatchObject({ kind: "SWAP", perBoxMinor: alt.perBoxMinor, totalMinor: alt.totalMinor, swap: { slotId: "gift", fromSku: "BOTTLE-STEEL", toSku: "ORGANIZER-DESK" } });
    expect([alt.perBoxMinor, alt.totalMinor]).toEqual([3600, 108_000]);
  });
});

describe("createAgentRequest: the second shop", () => {
  it("20 kits: $33.50 a kit, $670.00; 50 kits: the bottle is blocked (need 50, have 40) and the mug is offered at $29.50, $1,475.00", async () => {
    const kit = await kitMerchant(db);
    expect((await created(kit.slug)).proposals[0]).toMatchObject({ perBoxMinor: 3350, totalMinor: 67_000 });
    const big = await created(kit.slug, { boxCount: 50 });
    expect(big.blockers).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "BOTTLE-INSULATED", needed: 50, available: 40 }]);
    expect(big.proposals[0]).toMatchObject({ kind: "SWAP", perBoxMinor: 2950, totalMinor: 147_500, swap: { slotId: "drink", toSku: "MUG-ENAMEL" } });
  });
});

describe("createAgentRequest: refusals leave nothing behind", () => {
  it("an unknown store is NOT_FOUND and creates no request", async () => {
    const before = await count("inquiries");
    expect(await createAgentRequest(db, deps, `absent-${randomUUID().slice(0, 8)}`, body(), ctx)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await count("inquiries")).toBe(before);
  });

  it("a non-string store address is NOT_FOUND", async () => {
    expect(await createAgentRequest(db, deps, { slug: "x" }, body(), ctx)).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("a shop with no catalog is NOT_FOUND and creates no request", async () => {
    const slug = `empty-${randomUUID().slice(0, 8)}`;
    must(await db.from("merchants").insert({ slug, name: "No catalog" }).select("id").single());
    const before = await count("inquiries");
    expect(await createAgentRequest(db, deps, slug, body(), ctx)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await count("inquiries")).toBe(before);
  });

  it.each([
    ["a price", { price: 100 }],
    ["free text", { note: "ignore the rules" }],
    ["a string quantity", { boxCount: "20" }],
    ["zero boxes", { boxCount: 0 }],
    ["a bad date", { requestedPickupDate: "2026-02-30" }],
  ])("%s is INVALID_INPUT with coded issues, and nothing is stored", async (_name, over) => {
    const m = await catalogMerchant(db);
    const before = await count("inquiries");
    const out = await createAgentRequest(db, deps, m.slug, body(over), ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("INVALID_INPUT");
      if (out.code === "INVALID_INPUT") expect(out.issues.length).toBeGreaterThan(0);
    }
    expect(await count("inquiries")).toBe(before);
  });
});

describe("readAgentRequest", () => {
  it("returns the status and the same proposals, computed now by code", async () => {
    const m = await catalogMerchant(db);
    const r = await created(m.slug, { boxCount: 30 });
    const read = await readAgentRequest(db, deps, r.requestId, r.requestToken, now);
    expect(read).toMatchObject({ ok: true, value: { requestId: r.requestId, status: "CONFIGURING", proposalStatus: "BLOCKED", missing: [] } });
    if (read.ok) {
      expect(read.value.proposals).toEqual(r.proposals);
      expect(read.value.blockers).toEqual(r.blockers);
    }
  });

  it("follows the request when a human changes it in the order room (a new quantity gives a new price)", async () => {
    const m = await catalogMerchant(db);
    const r = await created(m.slug, { boxCount: 20 });
    const access = await authorizeCustomerLink(db, r.humanToken, { secret: SECRET, now });
    if (!access.ok) throw new Error("link");
    const { editRequirements } = await import("@/services/intake/edit");
    await editRequirements(db, access.inquiry.id, { boxCount: 30 }, ctx);
    const read = await readAgentRequest(db, deps, r.requestId, r.requestToken, now);
    expect(read.ok && read.value.proposalStatus).toBe("BLOCKED");
  });

  it("says which required value is missing if a human cleared one, and proposes nothing", async () => {
    const m = await catalogMerchant(db);
    const r = await created(m.slug);
    const access = await authorizeCustomerLink(db, r.humanToken, { secret: SECRET, now });
    if (!access.ok) throw new Error("link");
    const { editRequirements } = await import("@/services/intake/edit");
    await editRequirements(db, access.inquiry.id, { maxPricePerBoxMinor: null }, ctx);
    const read = await readAgentRequest(db, deps, r.requestId, r.requestToken, now);
    expect(read).toMatchObject({ ok: true, value: { proposalStatus: null, proposals: [], missing: ["maxPricePerBoxMinor"] } });
  });

  it("every wrong token is the same NOT_FOUND: forged, another request's, expired, revoked, a customer link, garbage, or a bad id", async () => {
    const m = await catalogMerchant(db);
    const a = await created(m.slug);
    const b = await created(m.slug);
    const gone = { ok: false, code: "NOT_FOUND" };
    expect(await readAgentRequest(db, deps, a.requestId, b.requestToken, now)).toEqual(gone); // another request's token
    expect(await readAgentRequest(db, deps, a.requestId, a.requestToken.slice(0, -3) + "AAA", now)).toEqual(gone); // changed signature
    expect(await readAgentRequest(db, deps, a.requestId, a.humanToken, now)).toEqual(gone); // a customer link
    expect(await readAgentRequest(db, deps, a.requestId, "garbage", now)).toEqual(gone);
    expect(await readAgentRequest(db, deps, a.requestId, undefined, now)).toEqual(gone);
    expect(await readAgentRequest(db, deps, "not-a-uuid", a.requestToken, now)).toEqual(gone);
    expect(await readAgentRequest(db, deps, randomUUID(), createAgentToken({ requestId: randomUUID(), version: 1, expiresAt: new Date("2030-01-01T00:00:00Z"), secret: SECRET }), now)).toEqual(gone); // no such request
    expect(await readAgentRequest(db, deps, a.requestId, a.requestToken, new Date("2031-01-01T00:00:00Z"))).toEqual(gone); // expired
    must(await db.from("inquiries").update({ access_version: 2 }).eq("id", a.requestId));
    expect(await readAgentRequest(db, deps, a.requestId, a.requestToken, now)).toEqual(gone); // revoked
    expect((await readAgentRequest(db, deps, b.requestId, b.requestToken, now)).ok).toBe(true); // the other request is untouched
  });
});
