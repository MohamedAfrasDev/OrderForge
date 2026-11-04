// Real local Postgres. The turn pipeline with a SCRIPTED model (no network): the demo path steps A to D, one reply per message,
// the caps and the audit of every model run. Scripted answers are hand-written in the real shape, not recorded.
import { describe, expect, it } from "vitest";
import { createFakeModel } from "@/lib/ai";
import { storedRequirementsSchema } from "@/domain/intake";
import { auditIntake, latestRequirements } from "@/services/intake/shared";
import { postCustomerMessage } from "@/services/intake/start";
import { runIntakeTurn } from "@/services/intake/turn";
import { must, serviceClient } from "./helpers";
import { ctx, messagesOf, versionsOf, verifiedFor } from "./intake-helpers";
import { BOTTLE_BOX, ORGANIZER_BOX, begin, catalogMerchant, kindsOf, readA, say } from "./intake-fixtures";

const db = serviceClient();
const statusOf = async (id: string) => must(await db.from("inquiries").select("status").eq("id", id).single()).status as string;
const confirmed = <T>(value: T) => ({ value, status: "confirmed" as const });

describe("demo steps A and C: a full request, read, validated and priced by code", () => {
  it("shows the specification with its sources, asks nothing, and proposes a box that code priced", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "20 welcome boxes, notebooks, no food, our logo, under $40 per box");
    const model = createFakeModel({ answers: { extract: [readA], propose: [{ selections: BOTTLE_BOX }] } });

    const out = await runIntakeTurn(db, { model }, who, messageId, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok || out.value.kind !== "PROPOSED") throw new Error("expected a proposal");

    expect(kindsOf(model.requests)).toEqual(["extract", "propose"]); // no question: nothing blocks
    const [v] = await versionsOf(db, inquiryId);
    expect(v!.source_message_id).toBe(messageId);
    expect(v!.requirements.fields.boxCount).toEqual({ value: 20, status: "confirmed", source: messageId });
    expect(v!.requirements.fields.noFood).toEqual({ value: true, status: "confirmed", source: messageId });
    expect(v!.requirements.fields.maxPricePerBoxMinor).toEqual({ value: 4000, status: "confirmed", source: messageId });
    expect(storedRequirementsSchema.safeParse(v!.requirements).success).toBe(true);

    // 12.00 + 3.00 + 13.00 + 2.00 + 5.00 per box, from the catalog, times 20.
    expect(out.value.proposal).toMatchObject({ status: "VALID", blockers: [], priced: { perBoxMinor: 3500, totalMinor: 70_000, boxCount: 20 }, alternatives: [] });
    expect(await statusOf(inquiryId)).toBe("CONFIGURING");

    const messages = await messagesOf(db, inquiryId);
    expect(messages.map((x) => x.role)).toEqual(["customer", "assistant"]);
    expect(messages[1]!.reply_to).toBe(messageId);
    expect(messages[1]!.body).toContain("$35.00 per box");
    expect(messages[1]!.body).toContain("$700.00");
  });
});

describe("demo step D: the same box for 30 boxes is blocked by stock, and code finds the alternatives", () => {
  it("revalidates, blocks the bottle (24 in stock), has the model rank code's list, and keeps only code's figures", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "20 welcome boxes, notebooks, no food, our logo, under $40 per box");
    await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [readA], propose: [{ selections: BOTTLE_BOX }] } }) }, who, messageId, ctx);

    const second = await say(db, inquiryId, "Actually we need 30 boxes");
    const model = createFakeModel({
      answers: {
        extract: [{ boxCount: confirmed(30) }],
        propose: [{ selections: BOTTLE_BOX }],
        rank: [{ ranking: [{ index: 0, explanation: "A desk organizer is useful every day and costs $36.00 per box." }] }],
      },
    });
    const out = await runIntakeTurn(db, { model }, who, second, ctx);
    if (!out.ok || out.value.kind !== "PROPOSED") throw new Error("expected a proposal");

    expect(kindsOf(model.requests)).toEqual(["extract", "propose", "rank"]);
    const { proposal } = out.value;
    expect(proposal.status).toBe("BLOCKED");
    expect(proposal.blockers).toEqual(["INSUFFICIENT_STOCK"]);
    expect(proposal.priced).toBeNull();
    expect(proposal.alternatives).toHaveLength(1); // truffles are food and the customer wants none
    expect(proposal.alternatives[0]).toMatchObject({ slotId: "gift", fromSku: "BOTTLE-STEEL", toSku: "ORGANIZER-DESK", perBoxMinor: 3600, totalMinor: 108_000 });
    expect(proposal.alternatives[0]!.explanation).toBe("A desk organizer is useful every day and costs $36.00 per box.");

    const versions = await versionsOf(db, inquiryId);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]!.requirements.fields.boxCount.value).toBe(20); // never edited
    expect(versions[1]!.requirements.fields.boxCount).toEqual({ value: 30, status: "confirmed", source: second });
    expect(versions[1]!.requirements.fields.noFood.value).toBe(true); // kept from the first message
    expect(await statusOf(inquiryId)).toBe("CONFIGURING");

    const reply = (await messagesOf(db, inquiryId)).find((x) => x.reply_to === second)!;
    expect(reply.body).toContain("Replace Steel water bottle with Desk organizer: $36.00 per box, $1,080.00 in total");
  });

  it("a proposal that can be made at the new quantity stays valid", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "30 boxes, no food");
    const model = createFakeModel({ answers: { extract: [{ boxCount: confirmed(30), noFood: confirmed(true) }], propose: [{ selections: ORGANIZER_BOX }] } });
    const out = await runIntakeTurn(db, { model }, who, messageId, ctx);
    if (!out.ok || out.value.kind !== "PROPOSED") throw new Error("expected a proposal");
    expect(out.value.proposal.priced).toEqual({ perBoxMinor: 3600, totalMinor: 108_000, boxCount: 30 });
    expect(inquiryId).toBeTruthy();
  });

  it("when no alternative exists the customer is told so, with nothing offered, and the inquiry stays open", async () => {
    const m = await catalogMerchant(db);
    must(await db.from("stock").update({ on_hand: 0 }).in("product_id", [m.productId["ORGANIZER-DESK"]!, m.productId["TRUFFLES-BOX"]!]));
    const { inquiryId, who, messageId } = await begin(db, m.slug, "30 boxes, no food");
    const model = createFakeModel({ answers: { extract: [{ boxCount: confirmed(30), noFood: confirmed(true) }], propose: [{ selections: BOTTLE_BOX }] } });
    const out = await runIntakeTurn(db, { model }, who, messageId, ctx);
    if (!out.ok || out.value.kind !== "PROPOSED") throw new Error("expected a proposal");
    expect(out.value.proposal).toMatchObject({ status: "BLOCKED", alternatives: [] });
    expect(kindsOf(model.requests)).toEqual(["extract", "propose"]); // nothing to rank
    expect((await messagesOf(db, inquiryId)).at(-1)!.body).toContain("I could not find a box that fits");
    expect(await statusOf(inquiryId)).toBe("CONFIGURING");
  });
});

describe("demo step B: one question about exactly the blocking field", () => {
  it("no quantity: asks how many, in the model's words when they pass the check; nothing is proposed", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "welcome boxes, notebooks, no food, our logo");
    const withoutQuantity = { ...readA, boxCount: undefined };
    const model = createFakeModel({ answers: { extract: [withoutQuantity], ask: [{ question: "How many boxes do you need?" }] } });
    const out = await runIntakeTurn(db, { model }, who, messageId, ctx);
    expect(out).toMatchObject({ ok: true, value: { kind: "ASKED", field: "boxCount", question: "How many boxes do you need?" } });
    expect(kindsOf(model.requests)).toEqual(["extract", "ask"]);
    expect(await statusOf(inquiryId)).toBe("CLARIFYING");
    const stored = (await latestRequirements(db, inquiryId))!.stored;
    expect(stored.question).toEqual({ field: "boxCount", text: "How many boxes do you need?" });
    expect(stored.proposal).toBeNull();
    expect((await messagesOf(db, inquiryId)).at(-1)!.body).toBe("How many boxes do you need?");
  });

  it("a budget given two ways: asks which budget is meant, and only that", async () => {
    const m = await catalogMerchant(db);
    const { who, messageId } = await begin(db, m.slug, "20 boxes, under $40 per box, or maybe about $60");
    const model = createFakeModel({
      answers: {
        extract: [{ boxCount: confirmed(20), maxPricePerBoxMinor: { value: 6000, status: "conflicted" } }],
        ask: [{ question: "Which budget per box did you mean, the lower or the higher one?" }],
      },
    });
    const out = await runIntakeTurn(db, { model }, who, messageId, ctx);
    expect(out).toMatchObject({ ok: true, value: { kind: "ASKED", field: "maxPricePerBoxMinor" } });
  });

  it("uses the fixed question when the model's wording fails the check or the model is unavailable", async () => {
    const m = await catalogMerchant(db);
    const bad = await begin(db, m.slug, "boxes please");
    const worded = createFakeModel({ answers: { extract: [{}], ask: [{ question: "Is a budget of $50 and 12 boxes right?" }] } });
    expect(await runIntakeTurn(db, { model: worded }, bad.who, bad.messageId, ctx)).toMatchObject({ ok: true, value: { kind: "ASKED", question: "How many boxes would you like?" } });

    const down = await begin(db, m.slug, "boxes please");
    const outage = createFakeModel({ answers: { extract: [{}], ask: [{ fail: "TIMEOUT" }] } });
    expect(await runIntakeTurn(db, { model: outage }, down.who, down.messageId, ctx)).toMatchObject({ ok: true, value: { kind: "ASKED", question: "How many boxes would you like?" } });
  });
});

describe("one reply per customer message", () => {
  it("asking again after an answer returns the first reply and calls the model no more", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "30 boxes, no food");
    const answers = { extract: [{ boxCount: confirmed(30), noFood: confirmed(true) }], propose: [{ selections: ORGANIZER_BOX }] };
    const first = createFakeModel({ answers });
    const done = await runIntakeTurn(db, { model: first }, who, messageId, ctx);
    expect(done.ok).toBe(true);

    const again = createFakeModel({ answers });
    const out = await runIntakeTurn(db, { model: again }, who, messageId, ctx);
    expect(out).toMatchObject({ ok: false, code: "ALREADY_ANSWERED", reply: { body: (await messagesOf(db, inquiryId)).at(-1)!.body } });
    expect(again.requests).toHaveLength(0);
    expect((await messagesOf(db, inquiryId)).filter((x) => x.role === "assistant")).toHaveLength(1);
    expect(await versionsOf(db, inquiryId)).toHaveLength(1);
  });

  it("five requests for the same message at once leave one reply and one version", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "30 boxes, no food");
    const script = () => createFakeModel({ answers: { extract: [{ boxCount: confirmed(30), noFood: confirmed(true) }], propose: [{ selections: ORGANIZER_BOX }] } });
    const results = await Promise.all(Array.from({ length: 5 }, () => runIntakeTurn(db, { model: script() }, who, messageId, ctx)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "ALREADY_ANSWERED")).toHaveLength(4);
    expect((await messagesOf(db, inquiryId)).filter((x) => x.role === "assistant")).toHaveLength(1);
    expect(await versionsOf(db, inquiryId)).toHaveLength(1);
    expect(await statusOf(inquiryId)).toBe("CONFIGURING");
  });

  it("a message id that is not a customer message of this inquiry is refused without calling the model", async () => {
    const m = await catalogMerchant(db);
    const a = await begin(db, m.slug, "one");
    const b = await begin(db, m.slug, "two");
    const model = createFakeModel({ answers: { extract: [{}] } });
    expect(await runIntakeTurn(db, { model }, a.who, b.messageId, ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await runIntakeTurn(db, { model }, a.who, "not-a-uuid", ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await runIntakeTurn(db, { model }, a.who, "00000000-0000-4000-8000-00000000dead", ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const ghost = await verifiedFor(db, a.inquiryId);
    must(await db.from("inquiries").delete().eq("id", a.inquiryId));
    expect(await runIntakeTurn(db, { model }, ghost, a.messageId, ctx)).toMatchObject({ ok: false, code: "INQUIRY_NOT_FOUND" });
    expect(model.requests).toHaveLength(0);
  });

  it("an inquiry with the merchant is not run again; one with a quote ready goes back to configuring on a new message", async () => {
    const m = await catalogMerchant(db);
    const held = await begin(db, m.slug, "30 boxes");
    must(await db.from("inquiries").update({ status: "REVIEW_REQUIRED" }).eq("id", held.inquiryId));
    const idle = createFakeModel({ answers: {} });
    expect(await runIntakeTurn(db, { model: idle }, held.who, held.messageId, ctx)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(idle.requests).toHaveLength(0);

    const ready = await begin(db, m.slug, "30 boxes, no food");
    must(await db.from("inquiries").update({ status: "QUOTE_READY" }).eq("id", ready.inquiryId));
    const model = createFakeModel({ answers: { extract: [{ boxCount: confirmed(30), noFood: confirmed(true) }], propose: [{ selections: ORGANIZER_BOX }] } });
    expect((await runIntakeTurn(db, { model }, ready.who, ready.messageId, ctx)).ok).toBe(true);
    expect(await statusOf(ready.inquiryId)).toBe("CONFIGURING");
  });
});

describe("demo step H and the caps: a conversation that does not converge goes to the merchant", () => {
  const unanswered = { extract: [{}], ask: [{ fail: "TIMEOUT" }] };

  it("after three questions a fourth would-be question hands the inquiry over, with the specification attached", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "boxes");
    const turns = [messageId, await say(db, inquiryId, "hello?"), await say(db, inquiryId, "any boxes"), await say(db, inquiryId, "just boxes")];
    for (const id of turns.slice(0, 3)) {
      expect(await runIntakeTurn(db, { model: createFakeModel({ answers: unanswered }) }, who, id, ctx)).toMatchObject({ ok: true, value: { kind: "ASKED" } });
    }
    expect(await statusOf(inquiryId)).toBe("CLARIFYING");
    const out = await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [{}] } }) }, who, turns[3]!, ctx);
    expect(out).toMatchObject({ ok: true, value: { kind: "HANDED_OFF", reason: "clarification_limit" } });
    expect(await statusOf(inquiryId)).toBe("REVIEW_REQUIRED");
    expect((await latestRequirements(db, inquiryId))!.stored.question).toBeNull();
  });

  it("a field that is still conflicted after it was asked about goes to the merchant", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "20 boxes, under $40 or about $60");
    const conflicted = { extract: [{ boxCount: confirmed(20), maxPricePerBoxMinor: { value: 6000, status: "conflicted" as const } }], ask: [{ fail: "TIMEOUT" }] };
    expect(await runIntakeTurn(db, { model: createFakeModel({ answers: conflicted }) }, who, messageId, ctx)).toMatchObject({ ok: true, value: { kind: "ASKED" } });
    const next = await say(db, inquiryId, "I do not know, one or the other");
    const out = await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [{ maxPricePerBoxMinor: { value: 6000, status: "conflicted" } }] } }) }, who, next, ctx);
    expect(out).toMatchObject({ ok: true, value: { kind: "HANDED_OFF", reason: "conflict_persists" } });
    expect(await statusOf(inquiryId)).toBe("REVIEW_REQUIRED");
  });

  it("twenty model runs is the limit: the inquiry is handed over with one note and the model is not called", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "30 boxes");
    for (let run = 1; run <= 20; run++) await auditIntake(db, ctx, "system:test", "intake.model_run", inquiryId, { run });
    const model = createFakeModel({ answers: { extract: [{}] } });
    expect(await runIntakeTurn(db, { model }, who, messageId, ctx)).toMatchObject({ ok: false, code: "LIMIT_REACHED" });
    expect(model.requests).toHaveLength(0);
    expect(await statusOf(inquiryId)).toBe("REVIEW_REQUIRED");
    expect((await messagesOf(db, inquiryId)).filter((x) => x.role === "system")).toHaveLength(1);
    const again = await postCustomerMessage(db, who, "still there?", ctx);
    expect(again.ok).toBe(true); // the customer can still write; the merchant reads it
  });
});

describe("what the pipeline asks a provider for", () => {
  it("sends schemas a strict structured-output grammar accepts, and a proposal schema built from the catalog's own slots", async () => {
    const m = await catalogMerchant(db);
    const { who, messageId } = await begin(db, m.slug, "30 boxes, no food");
    const inner = createFakeModel({ answers: { extract: [{ boxCount: confirmed(30), noFood: confirmed(true) }], propose: [{ selections: BOTTLE_BOX }], rank: [{ ranking: [] }] } });
    const sent: Array<{ kind: string; jsonSchema: Record<string, unknown> }> = [];
    const spy = { complete: (request: Parameters<typeof inner.complete>[0]) => (sent.push({ kind: request.kind, jsonSchema: request.jsonSchema }), inner.complete(request)) };
    await runIntakeTurn(db, { model: spy as never }, who, messageId, ctx);

    expect(sent.map((s) => s.kind)).toEqual(["extract", "propose", "rank"]);
    const keys = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keys) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
    for (const s of sent) expect(keys(s.jsonSchema).filter((k) => ["propertyNames", "patternProperties", "$ref", "$defs"].includes(k)), s.kind).toEqual([]);
    const propose = sent.find((s) => s.kind === "propose")!.jsonSchema as { properties: { selections: { properties: Record<string, { enum: string[] }> } } };
    expect(Object.keys(propose.properties.selections.properties).sort()).toEqual(["card", "gift", "notebook", "packaging", "pen"]);
    expect(propose.properties.selections.properties.gift!.enum).toEqual(["BOTTLE-STEEL", "ORGANIZER-DESK", "TRUFFLES-BOX"]);
  });
});

describe("the bounds on one turn and the record of each run", () => {
  it("the worst turn (read, propose, rank) asks the model three times and no more", async () => {
    const m = await catalogMerchant(db);
    const { who, messageId } = await begin(db, m.slug, "30 boxes, no food");
    const model = createFakeModel({
      answers: { extract: [{ boxCount: confirmed(30), noFood: confirmed(true) }], propose: [{ selections: BOTTLE_BOX }], rank: [{ ranking: [] }] },
    });
    expect((await runIntakeTurn(db, { model }, who, messageId, ctx)).ok).toBe(true);
    expect(model.requests).toHaveLength(3);
  });

  it("audits each run with the model id, prompt version and run number, and keeps customer text out of the record", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "my secret handle is zebra-77, 30 boxes please");
    const model = createFakeModel({ model: "openai/gpt-oss-120b", answers: { extract: [{ boxCount: confirmed(30), noFood: confirmed(true) }], propose: [{ selections: ORGANIZER_BOX }] } });
    await runIntakeTurn(db, { model }, who, messageId, ctx);
    const runs = must(await db.from("audit_events").select("data").eq("entity", "inquiry").eq("entity_id", inquiryId).eq("action", "intake.model_run").order("id"));
    expect(runs.map((r) => r.data)).toEqual([
      { inquiry_id: inquiryId, model_id: "openai/gpt-oss-120b", prompt_version: "intake.v1", run: 1, status: "ok" },
      { inquiry_id: inquiryId, model_id: "openai/gpt-oss-120b", prompt_version: "intake.v1", run: 2, status: "ok" },
    ]);
    expect(JSON.stringify(runs)).not.toContain("zebra-77");
  });
});
