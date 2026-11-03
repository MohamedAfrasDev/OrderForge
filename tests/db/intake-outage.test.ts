// Real local Postgres, MOCKED provider (the scripted fake). Demo step G: a provider that is down, slow or returns bad output
// keeps the inquiry and every message, offers retry or handoff (a stored note, no reply), and never shows a ready state.
// The retry-then-fallback behaviour of the real HTTP client is covered in tests/intake/openrouter.test.ts; here the port's
// final result is scripted.
import { describe, expect, it } from "vitest";
import { createFakeModel, type FakeStep } from "@/lib/ai";
import type { ModelPort } from "@/lib/ai";
import { latestRequirements } from "@/services/intake/shared";
import { runIntakeTurn } from "@/services/intake/turn";
import { must, serviceClient } from "./helpers";
import { ctx, messagesOf, versionsOf } from "./intake-helpers";
import { ORGANIZER_BOX, begin, catalogMerchant } from "./intake-fixtures";

const db = serviceClient();
const statusOf = async (id: string) => must(await db.from("inquiries").select("status").eq("id", id).single()).status as string;
const confirmed = <T>(value: T) => ({ value, status: "confirmed" as const });
const THIRTY = { boxCount: confirmed(30), noFood: confirmed(true) };

async function expectKept(inquiryId: string, text: string, status: string) {
  const messages = await messagesOf(db, inquiryId);
  expect(messages.map((x) => x.role)).toEqual(["customer", "system"]); // the customer's message, one note, no reply
  expect(messages[0]!.body).toBe(text);
  expect(messages[1]!.body).toMatch(/could not answer just now/);
  expect(await versionsOf(db, inquiryId)).toHaveLength(0);
  expect(await statusOf(inquiryId)).toBe(status);
  expect(must(await db.from("quote_versions").select("id").eq("inquiry_id", inquiryId))).toHaveLength(0);
}

describe("the model fails while reading the message", () => {
  const cases: Array<[string, FakeStep, string]> = [
    ["a provider failure (5xx, rate limit with no fallback left)", { fail: "PROVIDER_FAILURE" }, "MODEL_UNAVAILABLE"],
    ["a timeout", { fail: "TIMEOUT" }, "MODEL_UNAVAILABLE"],
    ["malformed output twice", { fail: "MALFORMED" }, "MODEL_OUTPUT_INVALID"],
    ["JSON that is not an extraction", "I am sorry, I cannot help", "MODEL_OUTPUT_INVALID"],
    ["a value that is not usable (boxCount as text)", { boxCount: { value: "twenty", status: "confirmed" } }, "MODEL_OUTPUT_INVALID"],
  ];
  for (const [name, step, code] of cases) {
    it(`${name}: ${code}, everything kept, nothing invented`, async () => {
      const m = await catalogMerchant(db);
      const text = "30 boxes please, no food";
      const { inquiryId, who, messageId } = await begin(db, m.slug, text);
      const out = await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [step] } }) }, who, messageId, ctx);
      expect(out).toMatchObject({ ok: false, code });
      await expectKept(inquiryId, text, "NEW");
    });
  }

  it("a port that throws is treated as a provider failure", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "30 boxes");
    const broken: ModelPort = { complete: () => Promise.reject(new Error("socket hang up with a secret sk-123 inside")) };
    const out = await runIntakeTurn(db, { model: broken }, who, messageId, ctx);
    expect(out).toMatchObject({ ok: false, code: "MODEL_UNAVAILABLE" });
    expect(JSON.stringify(out)).not.toContain("sk-123");
    await expectKept(inquiryId, "30 boxes", "NEW");
  });

  it("retry: the same message is run again after an outage and then gets its one reply", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "30 boxes, no food");
    expect(await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [{ fail: "TIMEOUT" }] } }) }, who, messageId, ctx)).toMatchObject({ ok: false, code: "MODEL_UNAVAILABLE" });
    const back = createFakeModel({ answers: { extract: [THIRTY], propose: [{ selections: ORGANIZER_BOX }] } });
    expect(await runIntakeTurn(db, { model: back }, who, messageId, ctx)).toMatchObject({ ok: true, value: { kind: "PROPOSED" } });
    const messages = await messagesOf(db, inquiryId);
    expect(messages.filter((x) => x.role === "assistant")).toHaveLength(1);
    expect(messages.filter((x) => x.role === "system")).toHaveLength(1);
  });
});

describe("the model fails while proposing", () => {
  const cases: Array<[string, FakeStep, string]> = [
    ["a timeout", { fail: "TIMEOUT" }, "MODEL_UNAVAILABLE"],
    ["a provider failure", { fail: "PROVIDER_FAILURE" }, "MODEL_UNAVAILABLE"],
    ["malformed output twice", { fail: "MALFORMED" }, "MODEL_OUTPUT_INVALID"],
    ["an unknown product id", { selections: { ...ORGANIZER_BOX, gift: "NOT-A-REAL-SKU" } }, "MODEL_OUTPUT_INVALID"],
  ];
  for (const [name, step, code] of cases) {
    it(`${name}: ${code}, no proposal and no ready state, and the stage stays where it was`, async () => {
      const m = await catalogMerchant(db);
      const { inquiryId, who, messageId } = await begin(db, m.slug, "30 boxes, no food");
      const out = await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [THIRTY], propose: [step] } }) }, who, messageId, ctx);
      expect(out).toMatchObject({ ok: false, code });
      await expectKept(inquiryId, "30 boxes, no food", "NEW");
    });
  }
});

describe("the model fails while wording a question or ranking: code carries on without it", () => {
  it("a failed ranking still shows code's alternatives, with no explanations", async () => {
    const m = await catalogMerchant(db);
    for (const rank of [{ fail: "TIMEOUT" }, { fail: "PROVIDER_FAILURE" }, { fail: "MALFORMED" }, "not json at all", { ranking: [{ index: "first", explanation: 3 }] }] as FakeStep[]) {
      const { who, messageId } = await begin(db, m.slug, "30 boxes, no food");
      const model = createFakeModel({ answers: { extract: [THIRTY], propose: [{ selections: { ...ORGANIZER_BOX, gift: "BOTTLE-STEEL" } }], rank: [rank] } });
      const out = await runIntakeTurn(db, { model }, who, messageId, ctx);
      if (!out.ok || out.value.kind !== "PROPOSED") throw new Error(`expected a proposal for ${JSON.stringify(rank)}`);
      expect(out.value.proposal.alternatives).toEqual([
        { key: "alt-0", slotId: "gift", fromSku: "BOTTLE-STEEL", toSku: "ORGANIZER-DESK", perBoxMinor: 3600, totalMinor: 108_000, explanation: null },
      ]);
    }
  });

  it("a failed question still asks the fixed question (shown in the stored specification)", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "boxes");
    const model = createFakeModel({ answers: { extract: [{}], ask: [{ fail: "PROVIDER_FAILURE" }] } });
    expect(await runIntakeTurn(db, { model }, who, messageId, ctx)).toMatchObject({ ok: true, value: { kind: "ASKED", question: "How many boxes would you like?" } });
    expect((await latestRequirements(db, inquiryId))!.stored.question).toEqual({ field: "boxCount", text: "How many boxes would you like?" });
  });
});

describe("which model answered is on the record", () => {
  it("a run answered by the fallback model is audited under the fallback's id, a failed run under none when no model answered", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "30 boxes, no food");
    const viaFallback: ModelPort = {
      async complete(request) {
        const parsed = request.parse(request.kind === "extract" ? THIRTY : { selections: ORGANIZER_BOX });
        if (!parsed.ok) return { ok: false, failure: "MALFORMED", model: "openai/gpt-oss-120b", detail: "bad", calls: 2 };
        return { ok: true, value: parsed.value as never, model: "openai/gpt-oss-120b", calls: 2 };
      },
    };
    await runIntakeTurn(db, { model: viaFallback }, who, messageId, ctx);
    const ran = must(await db.from("audit_events").select("data").eq("entity_id", inquiryId).eq("action", "intake.model_run").order("id"));
    expect(ran.map((r) => (r.data as { model_id: string }).model_id)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);

    const none = await begin(db, m.slug, "30 boxes");
    const dead: ModelPort = { complete: async () => ({ ok: false, failure: "PROVIDER_FAILURE", model: null, detail: "down", calls: 1 }) };
    await runIntakeTurn(db, { model: dead }, none.who, none.messageId, ctx);
    const failed = must(await db.from("audit_events").select("data").eq("entity_id", none.inquiryId).eq("action", "intake.model_run"));
    expect(failed.map((r) => r.data)).toEqual([{ inquiry_id: none.inquiryId, model_id: "none", prompt_version: "intake.v1", run: 1, status: "PROVIDER_FAILURE" }]);
  });
});
