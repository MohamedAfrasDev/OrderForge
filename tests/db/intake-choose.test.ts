// Real local Postgres, SCRIPTED model for the turn that makes the proposal. Demo step E and the rules around choosing:
// a key never an amount, live revalidation, one draft for a double click, the quote gate, isolation between customers.
import { describe, expect, it } from "vitest";
import { createFakeModel } from "@/lib/ai";
import { chooseConfiguration } from "@/services/intake/choose";
import { editRequirements } from "@/services/intake/edit";
import { latestRequirements } from "@/services/intake/shared";
import { runIntakeTurn } from "@/services/intake/turn";
import { must, serviceClient } from "./helpers";
import { ctx, messagesOf, versionsOf, verifiedFor } from "./intake-helpers";
import { BOTTLE_BOX, begin, catalogMerchant, readA } from "./intake-fixtures";

const db = serviceClient();
const statusOf = async (id: string) => must(await db.from("inquiries").select("status").eq("id", id).single()).status as string;
const quotesOf = async (id: string) => must(await db.from("quote_versions").select("id, status, total_minor, requirement_version_id, pending_conditions").eq("inquiry_id", id));
const confirmed = <T>(value: T) => ({ value, status: "confirmed" as const });

/** Demo step D reached: 30 boxes, the bottle is blocked by stock, and `alt-0` is the desk organizer at $36.00. */
async function blockedAt30() {
  const m = await catalogMerchant(db);
  const s = await begin(db, m.slug, "30 boxes, no food");
  const model = createFakeModel({ answers: { extract: [{ boxCount: confirmed(30), noFood: confirmed(true) }], propose: [{ selections: BOTTLE_BOX }], rank: [{ ranking: [] }] } });
  const out = await runIntakeTurn(db, { model }, s.who, s.messageId, ctx);
  if (!out.ok) throw new Error(`turn: ${out.code}`);
  return { ...s, m };
}

/** A valid proposal for 20 boxes. */
async function validAt20() {
  const m = await catalogMerchant(db);
  const s = await begin(db, m.slug, "20 boxes");
  const model = createFakeModel({ answers: { extract: [readA], propose: [{ selections: BOTTLE_BOX }] } });
  const out = await runIntakeTurn(db, { model }, s.who, s.messageId, ctx);
  if (!out.ok) throw new Error(`turn: ${out.code}`);
  return { ...s, m };
}

describe("demo step E: the customer picks one, and the total is the catalog engine's", () => {
  it("an alternative becomes a published quote: 30 boxes at $36.00 is $1,080.00, and the inquiry is QUOTE_READY", async () => {
    const { inquiryId, who } = await blockedAt30();
    const out = await chooseConfiguration(db, {}, who, "alt-0", ctx);
    expect(out).toMatchObject({ ok: true, value: { status: "QUOTE_READY", boxCount: 30, perBoxMinor: 3600, totalMinor: 108_000 } });

    const quotes = await quotesOf(inquiryId);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ status: "PUBLISHED", total_minor: 108_000, pending_conditions: [] });
    expect(await statusOf(inquiryId)).toBe("QUOTE_READY");

    const versions = await versionsOf(db, inquiryId);
    expect(versions).toHaveLength(2); // the turn's, then the claim
    expect(quotes[0]!.requirement_version_id).toBeTruthy();
    const latest = (await latestRequirements(db, inquiryId))!;
    expect(latest.id).toBe(quotes[0]!.requirement_version_id);
    expect(latest.stored.proposal!.chosen).toBe("alt-0");
    expect(versions[0]!.requirements).not.toHaveProperty("proposal.chosen"); // the first version is never edited

    const last = (await messagesOf(db, inquiryId)).at(-1)!;
    expect(last).toMatchObject({ role: "assistant" });
    expect(last.body).toContain("$1,080.00");
  });

  it("a valid proposal can be chosen by its own key", async () => {
    const { inquiryId, who } = await validAt20();
    expect(await chooseConfiguration(db, {}, who, "proposal", ctx)).toMatchObject({ ok: true, value: { status: "QUOTE_READY", totalMinor: 70_000, perBoxMinor: 3500 } });
    expect((await quotesOf(inquiryId))[0]!.total_minor).toBe(70_000);
  });

  it("records who chose, without any amount from the customer", async () => {
    const { inquiryId, who } = await blockedAt30();
    await chooseConfiguration(db, {}, who, "alt-0", ctx);
    const rows = must(await db.from("audit_events").select("actor, data").eq("entity_id", inquiryId).eq("action", "intake.configuration_chosen"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(`customer:${inquiryId}`);
  });
});

describe("a key is not an amount", () => {
  it("anything but a key of this proposal is refused and creates nothing", async () => {
    const { inquiryId, who } = await blockedAt30();
    const bad: unknown[] = ["alt-9", "alt-", "alt-0 ", "ALT-0", "proposal", "3600", "1", "$1", "alt-0; drop table quotes", "", 0, 3600, null, undefined, { key: "alt-0" }, ["alt-0"]];
    for (const key of bad) expect(await chooseConfiguration(db, {}, who, key, ctx), JSON.stringify(key)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await quotesOf(inquiryId)).toHaveLength(0);
    expect(await statusOf(inquiryId)).toBe("CONFIGURING");
    expect(await versionsOf(db, inquiryId)).toHaveLength(1);
  });

  it("the plain proposal cannot be chosen while it is blocked", async () => {
    const { inquiryId, who } = await blockedAt30();
    expect(await chooseConfiguration(db, {}, who, "proposal", ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await quotesOf(inquiryId)).toHaveLength(0);
  });
});

describe("a proposal that no longer holds is stale", () => {
  it("less stock than the box needs", async () => {
    const { inquiryId, who, m } = await blockedAt30();
    must(await db.from("stock").update({ on_hand: 10 }).eq("product_id", m.productId["ORGANIZER-DESK"]!));
    expect(await chooseConfiguration(db, {}, who, "alt-0", ctx)).toMatchObject({ ok: false, code: "PROPOSAL_STALE", cause: "INSUFFICIENT_STOCK" });
    expect(await quotesOf(inquiryId)).toHaveLength(0);
    expect(await statusOf(inquiryId)).toBe("CONFIGURING");
    expect((await latestRequirements(db, inquiryId))!.stored.proposal!.chosen ?? null).toBeNull(); // nothing claimed
  });

  it("a price that moved since it was shown", async () => {
    const { inquiryId, who, m } = await blockedAt30();
    must(await db.from("products").update({ unit_price_minor: 1500 }).eq("id", m.productId["ORGANIZER-DESK"]!));
    expect(await chooseConfiguration(db, {}, who, "alt-0", ctx)).toMatchObject({ ok: false, code: "PROPOSAL_STALE", cause: "the price changed" });
    expect(await quotesOf(inquiryId)).toHaveLength(0);
  });

  it("the customer edited the specification after the proposal was made", async () => {
    const { inquiryId, who } = await blockedAt30();
    await editRequirements(db, who, { boxCount: 25 }, ctx);
    expect(await chooseConfiguration(db, {}, who, "alt-0", ctx)).toMatchObject({ ok: false, code: "PROPOSAL_STALE" });
    expect(await quotesOf(inquiryId)).toHaveLength(0);
  });

  it("no proposal yet, or the wrong stage", async () => {
    const m = await catalogMerchant(db);
    const fresh = await begin(db, m.slug, "hello");
    expect(await chooseConfiguration(db, {}, fresh.who, "alt-0", ctx)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" }); // NEW
    must(await db.from("inquiries").update({ status: "CONFIGURING" }).eq("id", fresh.inquiryId));
    expect(await chooseConfiguration(db, {}, fresh.who, "alt-0", ctx)).toMatchObject({ ok: false, code: "PROPOSAL_STALE" });
  });
});

describe("a double click makes one quote", () => {
  it("five choices at once: one wins, the rest are refused, and there is one draft", async () => {
    const { inquiryId, who } = await blockedAt30();
    const results = await Promise.all(Array.from({ length: 5 }, () => chooseConfiguration(db, {}, who, "alt-0", ctx)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "ILLEGAL_TRANSITION")).toHaveLength(4);
    expect(await quotesOf(inquiryId)).toHaveLength(1);
    expect(await statusOf(inquiryId)).toBe("QUOTE_READY");
  });

  it("choosing again afterwards is refused, not a second quote", async () => {
    const { inquiryId, who } = await blockedAt30();
    await chooseConfiguration(db, {}, who, "alt-0", ctx);
    expect(await chooseConfiguration(db, {}, who, "alt-0", ctx)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await quotesOf(inquiryId)).toHaveLength(1);
  });
});

describe("the quote gate", () => {
  it("a mandatory unresolved condition holds the draft for the merchant: REVIEW_REQUIRED, not published, one note", async () => {
    const { inquiryId, who } = await blockedAt30();
    const deps = { conditionsFor: () => [{ code: "UNSUPPORTED_CUSTOMIZATION" as const, text: "Gold foil lid is not in the catalog." }] };
    expect(await chooseConfiguration(db, deps, who, "alt-0", ctx)).toMatchObject({ ok: true, value: { status: "REVIEW_REQUIRED", totalMinor: 108_000 } });
    const quotes = await quotesOf(inquiryId);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.status).toBe("DRAFT");
    expect(await statusOf(inquiryId)).toBe("REVIEW_REQUIRED");
    expect((await messagesOf(db, inquiryId)).filter((x) => x.role === "system")).toHaveLength(1);
  });

  it("a condition that is only disclosed does not hold it: the quote is published with the condition on it", async () => {
    const { inquiryId, who } = await validAt20();
    const deps = { conditionsFor: () => [{ code: "ARTWORK_ACCEPTANCE" as const, text: "Artwork to be accepted." }] };
    expect(await chooseConfiguration(db, deps, who, "proposal", ctx)).toMatchObject({ ok: true, value: { status: "QUOTE_READY" } });
    const [q] = await quotesOf(inquiryId);
    expect(q).toMatchObject({ status: "PUBLISHED", pending_conditions: [{ code: "ARTWORK_ACCEPTANCE", text: "Artwork to be accepted." }] });
  });
});

describe("isolation", () => {
  it("another customer's inquiry has no proposal to choose from, whatever key they send, and one that does not exist is not found", async () => {
    const a = await blockedAt30();
    const m = await catalogMerchant(db);
    const b = await begin(db, m.slug, "I want some boxes");
    must(await db.from("inquiries").update({ status: "CONFIGURING" }).eq("id", b.inquiryId));
    expect(await chooseConfiguration(db, {}, b.who, "alt-0", ctx)).toMatchObject({ ok: false, code: "PROPOSAL_STALE" });
    expect(await quotesOf(b.inquiryId)).toHaveLength(0);
    expect(await quotesOf(a.inquiryId)).toHaveLength(0);

    const ghost = await verifiedFor(db, b.inquiryId);
    must(await db.from("inquiries").delete().eq("id", b.inquiryId));
    expect(await chooseConfiguration(db, {}, ghost, "alt-0", ctx)).toMatchObject({ ok: false, code: "INQUIRY_NOT_FOUND" });
  });
});
