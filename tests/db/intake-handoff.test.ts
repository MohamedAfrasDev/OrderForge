// Real local Postgres. Demo step H and the customer's own request: handing the inquiry to the merchant.
import { describe, expect, it } from "vitest";
import { createFakeModel } from "@/lib/ai";
import { handOffToMerchant } from "@/services/intake/choose";
import { runIntakeTurn } from "@/services/intake/turn";
import { must, serviceClient } from "./helpers";
import { ctx, messagesOf, verifiedFor } from "./intake-helpers";
import { begin, catalogMerchant } from "./intake-fixtures";

const db = serviceClient();
const statusOf = async (id: string) => must(await db.from("inquiries").select("status").eq("id", id).single()).status as string;
const notes = async (id: string) => (await messagesOf(db, id)).filter((x) => x.role === "system");

describe("handOffToMerchant", () => {
  for (const from of ["NEW", "CLARIFYING", "CONFIGURING"]) {
    it(`from ${from}: REVIEW_REQUIRED with one note, and every message kept`, async () => {
      const m = await catalogMerchant(db);
      const { inquiryId, who } = await begin(db, m.slug, "I need boxes");
      if (from !== "NEW") must(await db.from("inquiries").update({ status: from }).eq("id", inquiryId));
      expect(await handOffToMerchant(db, who, "customer_request", ctx)).toEqual({ ok: true, value: { changed: true } });
      expect(await statusOf(inquiryId)).toBe("REVIEW_REQUIRED");
      const messages = await messagesOf(db, inquiryId);
      expect(messages.map((x) => x.role)).toEqual(["customer", "system"]);
      expect(messages[1]!.body).toMatch(/asked the merchant to take over/);
    });
  }

  it("repeating it changes nothing and adds nothing, even five at once", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who } = await begin(db, m.slug, "I need boxes");
    const results = await Promise.all(Array.from({ length: 5 }, () => handOffToMerchant(db, who, "customer_request", ctx)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.value.changed)).toHaveLength(1);
    expect(await notes(inquiryId)).toHaveLength(1);
    expect(await handOffToMerchant(db, who, "customer_request", ctx)).toEqual({ ok: true, value: { changed: false } });
    expect(await notes(inquiryId)).toHaveLength(1);
  });

  it("a failure handoff says so, and the reason (not the customer's text) is audited", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who } = await begin(db, m.slug, "my private note: zebra-77");
    await handOffToMerchant(db, who, "failure", ctx);
    expect((await notes(inquiryId))[0]!.body).toMatch(/could not continue/);
    const rows = must(await db.from("audit_events").select("data").eq("entity_id", inquiryId).eq("action", "intake.handed_off"));
    expect(rows.map((r) => r.data)).toEqual([{ inquiry_id: inquiryId, reason: "failure" }]);
    expect(JSON.stringify(rows)).not.toContain("zebra-77");
  });

  it("with a quote ready the customer keeps the quote: no handoff", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who } = await begin(db, m.slug, "boxes");
    must(await db.from("inquiries").update({ status: "QUOTE_READY" }).eq("id", inquiryId));
    expect(await handOffToMerchant(db, who, "customer_request", ctx)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await statusOf(inquiryId)).toBe("QUOTE_READY");
    expect(await notes(inquiryId)).toHaveLength(0);
  });

  it("refuses an unknown reason and an inquiry that does not exist", async () => {
    const m = await catalogMerchant(db);
    const { inquiryId, who } = await begin(db, m.slug, "boxes");
    expect(await handOffToMerchant(db, who, "because" as never, ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await statusOf(inquiryId)).toBe("NEW");
    const ghost = await verifiedFor(db, inquiryId);
    must(await db.from("inquiries").delete().eq("id", inquiryId));
    expect(await handOffToMerchant(db, ghost, "customer_request", ctx)).toMatchObject({ ok: false, code: "INQUIRY_NOT_FOUND" });
  });

  it("after a handoff the assistant no longer answers: the merchant has the inquiry", async () => {
    const m = await catalogMerchant(db);
    const { who, messageId } = await begin(db, m.slug, "boxes");
    await handOffToMerchant(db, who, "customer_request", ctx);
    const model = createFakeModel({ answers: { extract: [{}] } });
    expect(await runIntakeTurn(db, { model }, who, messageId, ctx)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(model.requests).toHaveLength(0);
  });
});
