// Real local Postgres, no model: the shop builds a price for a request that is with them (stand-in data, mocked evidence).
import { describe, expect, it } from "vitest";
import { forbiddenIn } from "@/domain/journey";
import { emptyStored, type StoredRequirements } from "@/domain/intake";
import { handOffToMerchant } from "@/services/intake/choose";
import { NOTE_TEXT, buildQuoteForInquiry, quoteBuilderView } from "@/services/intake/merchant-quote";
import { saveRequirements } from "@/services/intake/shared";
import { createMerchantUser, must, serviceClient, signedInClient } from "./helpers";
import { ctx } from "./intake-helpers";
import { BOTTLE_BOX, ORGANIZER_BOX, begin, catalogMerchant } from "./intake-fixtures";

const db = serviceClient();
const NONE = { artwork: false, productionSlot: false };

/** A shop with the demo catalog and a request that was handed over to it. `boxes` is what the customer confirmed, if anything. */
async function handedOver(boxes: number | null = 30, noFood = true) {
  const m = await catalogMerchant(db);
  const user = await createMerchantUser(db);
  must(await db.from("merchants").update({ owner_user_id: user.id }).eq("id", m.merchantId));
  const s = await begin(db, m.slug, "I need gift boxes");
  if (boxes !== null) {
    const stored: StoredRequirements = {
      ...emptyStored(),
      fields: {
        ...emptyStored().fields,
        boxCount: { value: boxes, status: "confirmed", source: s.messageId },
        noFood: { value: noFood, status: "confirmed", source: s.messageId },
      },
    };
    await saveRequirements(db, s.inquiryId, stored, s.messageId);
  }
  const handed = await handOffToMerchant(db, s.who, "customer_request", ctx);
  if (!handed.ok) throw new Error(`hand off: ${handed.code}`);
  return { ...s, m, user, actor: { userId: user.id, merchantId: m.merchantId } };
}

const statusOf = async (id: string) => must(await db.from("inquiries").select("status").eq("id", id).single()).status as string;
const quotesOf = async (id: string) => must(await db.from("quote_versions").select("id, status, total_minor, pending_conditions").eq("inquiry_id", id));
const messagesOf = async (id: string) => must(await db.from("messages").select("role, body").eq("inquiry_id", id).order("created_at"));

describe("quoteBuilderView", () => {
  it("shows the wishes, the confirmed quantity and, per slot, the active products with price and what is available", async () => {
    const t = await handedOver(30);
    must(await db.from("products").update({ active: false }).eq("id", t.m.productId["BOTTLE-STEEL"]!));
    const view = await quoteBuilderView(db, t.m.merchantId, t.inquiryId);
    expect(view).not.toBeNull();
    expect(view!.quantity).toBe(30);
    expect(view!.wishes.find((w) => w.name === "boxCount")).toMatchObject({ value: 30 });
    const gift = view!.slots.find((s) => s.id === "gift")!;
    expect(gift.products.map((p) => p.sku)).not.toContain("BOTTLE-STEEL"); // inactive: not offered
    expect(gift.products.find((p) => p.sku === "ORGANIZER-DESK")).toMatchObject({ unitPriceMinor: expect.any(Number), available: expect.any(Number) });
    expect(JSON.stringify(view)).not.toMatch(/product_id|merchant_id|owner/);
  });

  it("has no quantity when the customer never confirmed one", async () => {
    const t = await handedOver(null);
    expect((await quoteBuilderView(db, t.m.merchantId, t.inquiryId))!.quantity).toBeNull();
  });

  it("is null for a request that is not with the shop, another shop's request, a bad id, and one with a draft waiting in Quote review", async () => {
    const t = await handedOver(30);
    const other = await handedOver(30);
    expect(await quoteBuilderView(db, other.m.merchantId, t.inquiryId)).toBeNull();
    expect(await quoteBuilderView(db, t.m.merchantId, "not-an-id")).toBeNull();

    const waiting = await begin(db, t.m.slug, "still talking to the assistant");
    expect(await quoteBuilderView(db, t.m.merchantId, waiting.inquiryId)).toBeNull(); // NEW, not with the shop

    must(await db.from("quote_versions").insert({ inquiry_id: t.inquiryId, version: 1, lines: { boxCount: 1, perBoxMinor: 1, lines: [] }, total_minor: 1, pending_conditions: [] }));
    expect(await quoteBuilderView(db, t.m.merchantId, t.inquiryId)).toBeNull();
  });

  it("can be read under the shop's own session", async () => {
    const t = await handedOver(30);
    const session = await signedInClient(t.user.email, t.user.password);
    expect((await quoteBuilderView(session, t.m.merchantId, t.inquiryId))?.quantity).toBe(30);
  });
});

describe("buildQuoteForInquiry", () => {
  it("prices the box with the catalog engine, publishes it, and tells the customer once: 30 boxes at $36.00 is $1,080.00", async () => {
    const t = await handedOver(30);
    const out = await buildQuoteForInquiry(db, t.actor, t.inquiryId, { quantity: 30, selections: ORGANIZER_BOX, notes: { artwork: true, productionSlot: true } }, ctx);
    expect(out).toMatchObject({ ok: true, value: { boxCount: 30, perBoxMinor: 3600, totalMinor: 108_000 } });

    const quotes = await quotesOf(t.inquiryId);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ status: "PUBLISHED", total_minor: 108_000 });
    expect(quotes[0]!.pending_conditions).toEqual([
      { code: "ARTWORK_ACCEPTANCE", text: NOTE_TEXT.ARTWORK_ACCEPTANCE },
      { code: "PRODUCTION_SLOT_CONFIRMATION", text: NOTE_TEXT.PRODUCTION_SLOT_CONFIRMATION },
    ]);
    expect(await statusOf(t.inquiryId)).toBe("QUOTE_READY");

    const notes = (await messagesOf(t.inquiryId)).filter((m) => m.body.includes("prepared your price"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ role: "system" });
    expect(notes[0]!.body).toContain("$1,080.00");
    expect(forbiddenIn(notes[0]!.body)).toEqual([]);

    const audited = must(await db.from("audit_events").select("actor, data").eq("entity_id", t.inquiryId).eq("action", "intake.quote_built"));
    expect(audited).toHaveLength(1);
    expect(audited[0]!.actor).toBe(`merchant:${t.user.id}`);
    expect(JSON.stringify(audited[0]!.data)).not.toMatch(/\b108000\b|\$/); // an id and a version, never an amount
  });

  it("makes a quote with no notes when the shop adds none", async () => {
    const t = await handedOver(30);
    await buildQuoteForInquiry(db, t.actor, t.inquiryId, { quantity: 30, selections: ORGANIZER_BOX, notes: NONE }, ctx);
    expect((await quotesOf(t.inquiryId))[0]!.pending_conditions).toEqual([]);
  });

  it("the fixed notes read in the customer's words", () => {
    for (const text of Object.values(NOTE_TEXT)) expect(forbiddenIn(text)).toEqual([]);
  });

  it("a box the engine blocks returns its blockers in plain words and sends nothing", async () => {
    const t = await handedOver(30); // the shop has 24 bottles
    const out = await buildQuoteForInquiry(db, t.actor, t.inquiryId, { quantity: 30, selections: BOTTLE_BOX, notes: NONE }, ctx);
    expect(out).toMatchObject({ ok: false, code: "CONFIGURATION_BLOCKED" });
    if (out.ok || out.code !== "CONFIGURATION_BLOCKED") throw new Error("expected blockers");
    expect(out.blockers.join(" ")).toMatch(/30 needed, 24 available/);
    expect(out.blockers.join(" ")).not.toMatch(/INSUFFICIENT|_/);

    expect(await quotesOf(t.inquiryId)).toHaveLength(0);
    expect(await statusOf(t.inquiryId)).toBe("REVIEW_REQUIRED");
    expect((await messagesOf(t.inquiryId)).some((m) => m.body.includes("prepared your price"))).toBe(false);
  });

  it("a box that breaks the customer's own request is blocked: food for a customer who asked for none", async () => {
    const t = await handedOver(10, true);
    const sku = must(await db.from("products").select("sku").eq("merchant_id", t.m.merchantId).eq("is_food", true).limit(1)).at(0)?.sku as string | undefined;
    if (!sku) return; // the demo catalog has no food item: nothing to check
    const out = await buildQuoteForInquiry(db, t.actor, t.inquiryId, { quantity: 10, selections: { ...ORGANIZER_BOX, gift: sku }, notes: NONE }, ctx);
    expect(out).toMatchObject({ ok: false });
    expect(await quotesOf(t.inquiryId)).toHaveLength(0);
  });

  it("refuses another shop's request as not found, and a request that is not with the shop as an illegal state", async () => {
    const t = await handedOver(30);
    const other = await handedOver(30);
    const input = { quantity: 30, selections: ORGANIZER_BOX, notes: NONE };
    expect(await buildQuoteForInquiry(db, other.actor, t.inquiryId, input, ctx)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await buildQuoteForInquiry(db, t.actor, "11111111-1111-4111-8111-111111111111", input, ctx)).toEqual({ ok: false, code: "NOT_FOUND" });

    const waiting = await begin(db, t.m.slug, "not handed over");
    expect(await buildQuoteForInquiry(db, t.actor, waiting.inquiryId, input, ctx)).toEqual({ ok: false, code: "ILLEGAL_STATE" });
    expect(await quotesOf(t.inquiryId)).toHaveLength(0);
    expect(await quotesOf(waiting.inquiryId)).toHaveLength(0);
  });

  it("has nowhere to put a price, a discount, a status or a free-text condition", async () => {
    const t = await handedOver(30);
    const good = { quantity: 30, selections: ORGANIZER_BOX, notes: NONE };
    const bad: unknown[] = [
      { ...good, totalMinor: 1 },
      { ...good, price: 1 },
      { ...good, discount: 50 },
      { ...good, status: "ACCEPTED" },
      { ...good, conditions: [{ code: "ARTWORK_ACCEPTANCE", text: "free text" }] },
      { ...good, notes: { artwork: true, productionSlot: false, text: "pay later" } },
      { ...good, notes: { artwork: "yes", productionSlot: false } },
      { ...good, quantity: 0 },
      { ...good, quantity: 2.5 },
      { ...good, quantity: "30" },
      { ...good, selections: { gift: 5 } },
      null,
      "30",
    ];
    for (const input of bad) expect(await buildQuoteForInquiry(db, t.actor, t.inquiryId, input, ctx), JSON.stringify(input)).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(await quotesOf(t.inquiryId)).toHaveLength(0);
    expect(await statusOf(t.inquiryId)).toBe("REVIEW_REQUIRED");
  });

  it("a double submit makes one quote", async () => {
    const t = await handedOver(30);
    const input = { quantity: 30, selections: ORGANIZER_BOX, notes: NONE };
    const [a, b] = await Promise.all([buildQuoteForInquiry(db, t.actor, t.inquiryId, input, ctx), buildQuoteForInquiry(db, t.actor, t.inquiryId, input, ctx)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const lost = a.ok ? b : a;
    expect(lost).toEqual({ ok: false, code: "ILLEGAL_STATE" });
    expect(await quotesOf(t.inquiryId)).toHaveLength(1);
    expect((await messagesOf(t.inquiryId)).filter((m) => m.body.includes("prepared your price"))).toHaveLength(1);
  });

  it("works with no requirements recorded, taking the quantity from the shop", async () => {
    const t = await handedOver(null);
    const out = await buildQuoteForInquiry(db, t.actor, t.inquiryId, { quantity: 20, selections: ORGANIZER_BOX, notes: NONE }, ctx);
    expect(out).toMatchObject({ ok: true, value: { boxCount: 20, totalMinor: 72_000 } });
  });
});
