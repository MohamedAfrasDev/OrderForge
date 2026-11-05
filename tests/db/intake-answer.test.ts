// Real local Postgres, SCRIPTED model. Answering by tapping a choice or typing into a line: the answer is the customer's own confirmed
// edit, the assistant carries on from it once, and nothing a browser sends can name a different edit than the one the code offers.
import { describe, expect, it } from "vitest";
import { createFakeModel } from "@/lib/ai";
import { answerWithChoice, applyEdits } from "@/services/intake/answer";
import { latestRequirements } from "@/services/intake/shared";
import { postCustomerMessage } from "@/services/intake/start";
import { runIntakeTurn } from "@/services/intake/turn";
import { must, serviceClient } from "./helpers";
import { ctx, messagesOf, versionsOf } from "./intake-helpers";
import { BOTTLE_BOX, begin, catalogMerchant } from "./intake-fixtures";

const db = serviceClient();
const confirmed = <T>(value: T) => ({ value, status: "confirmed" as const });
const statusOf = async (id: string) => must(await db.from("inquiries").select("status").eq("id", id).single()).status as string;

/** An inquiry the assistant has asked "how many boxes?" about, as the first turn leaves it. */
async function askedAboutQuantity() {
  const m = await catalogMerchant(db);
  const s = await begin(db, m.slug, "No food, our logo, under $40 per box");
  const model = createFakeModel({ answers: { extract: [{ noFood: confirmed(true), logoRequired: confirmed(true), maxPricePerBoxMinor: confirmed(4000) }], ask: [{ fail: "TIMEOUT" }] } });
  const out = await runIntakeTurn(db, { model }, s.who, s.messageId, ctx);
  if (!out.ok || out.value.kind !== "ASKED") throw new Error("expected a question");
  return s;
}

const proposing = () => createFakeModel({ answers: { extract: [{}, {}, {}, {}, {}], propose: Array.from({ length: 5 }, () => ({ selections: BOTTLE_BOX })), rank: [{ ranking: [] }] } });

describe("applyEdits", () => {
  it("records the customer's own confirmed answer, announces it with a numbered message, and the assistant answers once", async () => {
    const { inquiryId, who } = await askedAboutQuantity();
    const out = await applyEdits(db, { model: proposing() }, who, { boxCount: 20 }, ctx);
    expect(out).toMatchObject({ ok: true, value: { turn: "ANSWERED" } });

    const latest = (await latestRequirements(db, inquiryId))!;
    expect(latest.stored.fields.boxCount).toEqual({ value: 20, status: "confirmed", source: "customer_edit" });
    expect(latest.stored.proposal).toMatchObject({ status: "VALID", priced: { perBoxMinor: 3500, totalMinor: 70_000, boxCount: 20 } });
    expect(await statusOf(inquiryId)).toBe("CONFIGURING");

    const messages = await messagesOf(db, inquiryId);
    const announce = messages.filter((m) => m.role === "customer" && /^I updated my requirements \(change \d+\)\.$/.test(m.body));
    expect(announce).toHaveLength(1);
    expect(messages.filter((m) => m.reply_to === announce[0]!.id)).toHaveLength(1);
  });

  it("with the shop, the edit is kept but no message is posted and the assistant stays out of it", async () => {
    const { inquiryId, who } = await askedAboutQuantity();
    must(await db.from("inquiries").update({ status: "REVIEW_REQUIRED" }).eq("id", inquiryId));
    const model = proposing();
    const before = (await messagesOf(db, inquiryId)).length;
    expect(await applyEdits(db, { model }, who, { boxCount: 20 }, ctx)).toMatchObject({ ok: true, value: { turn: "SKIPPED" } });
    expect(model.requests).toHaveLength(0);
    expect((await messagesOf(db, inquiryId)).length).toBe(before);
    expect((await latestRequirements(db, inquiryId))!.stored.fields.boxCount.value).toBe(20);
  });

  it("refuses anything that is not a valid answer: nothing saved, nothing posted, no model call", async () => {
    const { inquiryId, who } = await askedAboutQuantity();
    const model = proposing();
    const versions = (await versionsOf(db, inquiryId)).length;
    const messages = (await messagesOf(db, inquiryId)).length;
    for (const edits of [{ boxCount: 0 }, { boxCount: 2.5 }, { price: 1 }, { boxCount: 20, discountPercent: 90 }, {}, { requestedPickupDate: "2026-02-30" }]) {
      expect(await applyEdits(db, { model }, who, edits as never, ctx), JSON.stringify(edits)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect((await versionsOf(db, inquiryId)).length).toBe(versions);
    expect((await messagesOf(db, inquiryId)).length).toBe(messages);
    expect(model.requests).toHaveLength(0);
  });

  it("when the assistant fails after the edit, the edit is kept and the failure is reported, not hidden", async () => {
    const { inquiryId, who } = await askedAboutQuantity();
    const model = createFakeModel({ answers: { extract: [{ fail: "TIMEOUT" }] } });
    expect(await applyEdits(db, { model }, who, { boxCount: 20 }, ctx)).toMatchObject({ ok: true, value: { turn: "FAILED", code: "MODEL_UNAVAILABLE" } });
    expect((await latestRequirements(db, inquiryId))!.stored.fields.boxCount.value).toBe(20);
  });
});

describe("answerWithChoice: a tap names a choice, and the code decides what it means", () => {
  it("applies the offered choice as the customer's confirmed answer and the assistant carries on", async () => {
    const { inquiryId, who } = await askedAboutQuantity();
    // Offered for "how many boxes": 10, 20, 50. Index 1 is "20 boxes".
    expect(await answerWithChoice(db, { model: proposing() }, who, "boxCount", 1, ctx)).toMatchObject({ ok: true, value: { turn: "ANSWERED" } });
    expect((await latestRequirements(db, inquiryId))!.stored.fields.boxCount).toEqual({ value: 20, status: "confirmed", source: "customer_edit" });
  });

  it("refuses a field that is not the open question, a choice that is not offered, and a question that is not open", async () => {
    const { inquiryId, who } = await askedAboutQuantity();
    const model = proposing();
    for (const [field, index] of [["noFood", 0], ["maxPricePerBoxMinor", 0], ["boxCount", -1], ["boxCount", 3], ["boxCount", 1.5], ["boxCount", "1"], ["price", 0]] as const) {
      expect(await answerWithChoice(db, { model }, who, field as never, index as never, ctx), `${field} ${index}`).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(model.requests).toHaveLength(0);

    // Once answered there is no open question, so the same tap is no longer valid (a stale button).
    await applyEdits(db, { model: proposing() }, who, { boxCount: 20 }, ctx);
    expect(await answerWithChoice(db, { model }, who, "boxCount", 1, ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await latestRequirements(db, inquiryId))!.stored.fields.boxCount.value).toBe(20);
  });

  it("a clearing choice (no limit on the budget) clears the field instead of setting one", async () => {
    const m = await catalogMerchant(db);
    const s = await begin(db, m.slug, "20 boxes, under $40 or about $60");
    const asked = createFakeModel({ answers: { extract: [{ boxCount: confirmed(20), maxPricePerBoxMinor: { value: 6000, status: "conflicted" as const } }], ask: [{ fail: "TIMEOUT" }] } });
    const out = await runIntakeTurn(db, { model: asked }, s.who, s.messageId, ctx);
    if (!out.ok || out.value.kind !== "ASKED") throw new Error("expected a question");
    // Offered: the guess first ("Yes, up to $60.00 a box"), the presets that are not the guess ($25, $40), then "No limit" last.
    expect(await answerWithChoice(db, { model: proposing() }, s.who, "maxPricePerBoxMinor", 3, ctx)).toMatchObject({ ok: true });
    expect((await latestRequirements(db, s.inquiryId))!.stored.fields.maxPricePerBoxMinor).toEqual({ value: null, status: "unknown", source: "customer_edit" });
  });
});

describe("a tap and a message at once", () => {
  it("every customer message gets exactly one reply and no edit is lost", async () => {
    const { inquiryId, who } = await askedAboutQuantity();
    const typed = await postCustomerMessage(db, who, "Also, make it nice please", { ...ctx, now: new Date(Date.parse(ctx.now) + 5000).toISOString() });
    if (!typed.ok) throw new Error("post");
    const model = proposing();
    await Promise.all([
      applyEdits(db, { model }, who, { boxCount: 20 }, ctx),
      runIntakeTurn(db, { model }, who, typed.value.messageId, ctx),
    ]);
    const messages = await messagesOf(db, inquiryId);
    const customer = messages.filter((m) => m.role === "customer");
    for (const c of customer) expect(messages.filter((m) => m.reply_to === c.id).length, c.body).toBeLessThanOrEqual(1);
    expect((await latestRequirements(db, inquiryId))!.stored.fields.boxCount.value).toBe(20);
  });

  it("five taps at once all land, each announced and answered once", async () => {
    const { inquiryId, who } = await askedAboutQuantity();
    const model = proposing();
    const results = await Promise.all([10, 20, 30, 40, 50].map((boxCount) => applyEdits(db, { model }, who, { boxCount }, ctx)));
    expect(results.every((r) => r.ok)).toBe(true);
    const messages = await messagesOf(db, inquiryId);
    const announced = messages.filter((m) => /^I updated my requirements \(change \d+\)\.$/.test(m.body));
    expect(announced).toHaveLength(5);
    expect(new Set(announced.map((m) => m.body)).size).toBe(5); // each numbered differently, so none is read as a double submit
    for (const a of announced) expect(messages.filter((m) => m.reply_to === a.id).length).toBeLessThanOrEqual(1);
    expect((await versionsOf(db, inquiryId)).length).toBeGreaterThanOrEqual(6);
  });
});
