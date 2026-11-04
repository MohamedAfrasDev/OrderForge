// Real local Postgres. What the order room reads: product names instead of codes, and which message "Try again" would re-run.
import { describe, expect, it } from "vitest";
import { createFakeModel } from "@/lib/ai";
import { requirementsForCustomer, unansweredMessageId } from "@/services/intake/read";
import { runIntakeTurn } from "@/services/intake/turn";
import { serviceClient } from "./helpers";
import { ctx } from "./intake-helpers";
import { BOTTLE_BOX, begin, catalogMerchant, say } from "./intake-fixtures";

const db = serviceClient();
const confirmed = <T>(value: T) => ({ value, status: "confirmed" as const });

describe("requirementsForCustomer: names, not codes", () => {
  it("carries a name for every product the proposal mentions, and nothing the customer must not see", async () => {
    const m = await catalogMerchant(db);
    const { who, messageId } = await begin(db, m.slug, "30 boxes, no food");
    const model = createFakeModel({ answers: { extract: [{ boxCount: confirmed(30), noFood: confirmed(true) }], propose: [{ selections: BOTTLE_BOX }], rank: [{ ranking: [] }] } });
    await runIntakeTurn(db, { model }, who, messageId, ctx);

    const view = (await requirementsForCustomer(db, who))!;
    expect(view.productNames["BOTTLE-STEEL"]).toBe("Steel water bottle");
    expect(view.productNames["ORGANIZER-DESK"]).toBe("Desk organizer");
    for (const sku of Object.values(view.proposal!.selections)) expect(view.productNames[sku]).toBeTruthy();
    expect(JSON.stringify(view)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/); // still no ids
    expect(JSON.stringify(view)).not.toMatch(/on_hand|reserved/);
  });
});

describe("unansweredMessageId: what Try again re-runs", () => {
  it("is the newest customer message nobody answered, and null when every message has its reply", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who, messageId } = await begin(db, m.slug, "hello");
    expect(await unansweredMessageId(db, who)).toBe(messageId);

    await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [{}], ask: [{ fail: "TIMEOUT" }] } }) }, who, messageId, ctx);
    expect(await unansweredMessageId(db, who)).toBeNull();

    const second = await say(db, inquiryId, "30 boxes");
    expect(await unansweredMessageId(db, who)).toBe(second);
    const third = await say(db, inquiryId, "no food");
    expect(await unansweredMessageId(db, who)).toBe(third);
  });

  it("a failed turn leaves its message unanswered, because the outage note is not a reply", async () => {
    const m = await catalogMerchant(db);
    const { who, messageId } = await begin(db, m.slug, "30 boxes");
    await runIntakeTurn(db, { model: createFakeModel({ answers: { extract: [{ fail: "PROVIDER_FAILURE" }] } }) }, who, messageId, ctx);
    expect(await unansweredMessageId(db, who)).toBe(messageId);
  });
});
