// Real local Postgres. The customer edits the visible specification; no model is involved.
import { describe, expect, it } from "vitest";
import { blockingFields, emptyStored, storedRequirementsSchema, type StoredRequirements } from "@/domain/intake";
import { editRequirements } from "@/services/intake/edit";
import { requirementsForCustomer } from "@/services/intake/read";
import { latestRequirements, saveRequirements } from "@/services/intake/shared";
import { startInquiry } from "@/services/intake/start";
import { must, serviceClient } from "./helpers";
import { ctx, deps, newMerchant, verifiedFor, versionsOf } from "./intake-helpers";

const db = serviceClient();

async function started() {
  const m = await newMerchant(db);
  const out = await startInquiry(db, deps, m.slug, "I need some boxes", ctx);
  if (!out.ok) throw new Error("start");
  return { inquiryId: out.value.inquiryId, who: await verifiedFor(db, out.value.inquiryId) };
}

/** A version as the pipeline would write it: the model read 20 boxes, no food, a $40 budget from the first message. */
async function withModelVersion(inquiryId: string): Promise<string> {
  const firstMessage = must(await db.from("messages").select("id").eq("inquiry_id", inquiryId).limit(1).single()).id as string;
  const stored: StoredRequirements = {
    ...emptyStored(),
    fields: {
      ...emptyStored().fields,
      boxCount: { value: 20, status: "confirmed", source: firstMessage },
      noFood: { value: true, status: "confirmed", source: firstMessage },
      maxPricePerBoxMinor: { value: 4000, status: "confirmed", source: firstMessage },
      preferences: { value: ["notebooks"], status: "confirmed", source: firstMessage },
    },
  };
  await saveRequirements(db, inquiryId, stored, firstMessage);
  return firstMessage;
}

describe("editRequirements", () => {
  it("with nothing recorded yet, writes version 1 from the customer's own entries", async () => {
    const { inquiryId, who } = await started();
    const out = await editRequirements(db, who, { boxCount: 25, logoRequired: true }, ctx);
    expect(out).toMatchObject({ ok: true, value: { version: 1 } });
    const [v] = await versionsOf(db, inquiryId);
    expect(v!.requirements.fields.boxCount).toEqual({ value: 25, status: "confirmed", source: "customer_edit" });
    expect(v!.requirements.fields.logoRequired).toEqual({ value: true, status: "confirmed", source: "customer_edit" });
    expect(v!.requirements.fields.noFood).toEqual({ value: null, status: "unknown", source: null });
    expect(v!.source_message_id).toBeNull();
  });

  it("builds on the latest version: edited fields are confirmed edits, the rest is kept as it was, and older versions never change", async () => {
    const { inquiryId, who } = await started();
    const msg = await withModelVersion(inquiryId);
    const out = await editRequirements(db, who, { boxCount: 30, requestedPickupDate: "2026-12-01" }, ctx);
    expect(out).toMatchObject({ ok: true, value: { version: 2 } });

    const versions = await versionsOf(db, inquiryId);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]!.requirements.fields.boxCount).toEqual({ value: 20, status: "confirmed", source: msg });
    const f = versions[1]!.requirements.fields;
    expect(f.boxCount).toEqual({ value: 30, status: "confirmed", source: "customer_edit" });
    expect(f.requestedPickupDate).toEqual({ value: "2026-12-01", status: "confirmed", source: "customer_edit" });
    expect(f.noFood).toEqual({ value: true, status: "confirmed", source: msg });
    expect(f.maxPricePerBoxMinor).toEqual({ value: 4000, status: "confirmed", source: msg });
    expect(f.preferences).toEqual({ value: ["notebooks"], status: "confirmed", source: msg });
  });

  it("null clears a field back to not specified, and clearing the quantity makes it block again", async () => {
    const { inquiryId, who } = await started();
    await withModelVersion(inquiryId);
    await editRequirements(db, who, { maxPricePerBoxMinor: null, boxCount: null }, ctx);
    const latest = await latestRequirements(db, inquiryId);
    expect(latest!.stored.fields.maxPricePerBoxMinor).toEqual({ value: null, status: "unknown", source: "customer_edit" });
    expect(blockingFields(latest!.stored.fields)).toContain("boxCount");
  });

  it("trims and keeps preferences as the customer wrote them", async () => {
    const { inquiryId, who } = await started();
    await editRequirements(db, who, { preferences: ["  notebooks ", "pens"] }, ctx);
    expect((await latestRequirements(db, inquiryId))!.stored.fields.preferences.value).toEqual(["notebooks", "pens"]);
  });

  it("refuses anything that is not a valid specification, creating no version", async () => {
    const { inquiryId, who } = await started();
    const bad: unknown[] = [
      { boxCount: 0 },
      { boxCount: 2.5 },
      { boxCount: "20" },
      { maxPricePerBoxMinor: 3999.5 },
      { maxPricePerBoxMinor: -1 },
      { requestedPickupDate: "2026-02-30" },
      { requestedPickupDate: "next friday" },
      { noFood: "yes" },
      { preferences: Array.from({ length: 11 }, (_, i) => `p${i}`) },
      { preferences: [""] },
      { price: 1 },
      { totalMinor: 100 },
      { boxCount: 20, discountPercent: 90 },
      {},
      null,
      "boxCount=20",
    ];
    for (const edits of bad) expect(await editRequirements(db, who, edits as never, ctx), JSON.stringify(edits)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await versionsOf(db, inquiryId)).toHaveLength(0);
  });

  it("five edits at once all land as consecutive versions, none lost", async () => {
    const { inquiryId, who } = await started();
    const results = await Promise.all([10, 20, 30, 40, 50].map((boxCount) => editRequirements(db, who, { boxCount }, ctx)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await versionsOf(db, inquiryId)).map((v) => v.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it("stores a document that reads back through the strict schema", async () => {
    const { inquiryId, who } = await started();
    await editRequirements(db, who, { boxCount: 20, noFood: true }, ctx);
    const [v] = await versionsOf(db, inquiryId);
    expect(storedRequirementsSchema.safeParse(v!.requirements).success).toBe(true);
  });

  it("audits the edit without the values", async () => {
    const { inquiryId, who } = await started();
    await editRequirements(db, who, { preferences: ["a very private wish"] }, ctx);
    const audit = must(await db.from("audit_events").select("action, data").eq("entity", "inquiry").eq("entity_id", inquiryId).eq("action", "intake.requirements_edited"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("private wish");
  });

  it("editing after a quote was ready sends the inquiry back to CONFIGURING; with the merchant it stays with the merchant", async () => {
    const a = await started();
    must(await db.from("inquiries").update({ status: "QUOTE_READY" }).eq("id", a.inquiryId));
    await editRequirements(db, a.who, { boxCount: 40 }, ctx);
    expect(must(await db.from("inquiries").select("status").eq("id", a.inquiryId).single()).status).toBe("CONFIGURING");

    const b = await started();
    must(await db.from("inquiries").update({ status: "REVIEW_REQUIRED" }).eq("id", b.inquiryId));
    await editRequirements(db, b.who, { boxCount: 40 }, ctx);
    expect(must(await db.from("inquiries").select("status").eq("id", b.inquiryId).single()).status).toBe("REVIEW_REQUIRED");
  });

  it("an inquiry that does not exist is INQUIRY_NOT_FOUND", async () => {
    const ghost = "00000000-0000-4000-8000-00000000dead" as Parameters<typeof editRequirements>[1];
    expect(await editRequirements(db, ghost, { boxCount: 5 }, ctx)).toMatchObject({ ok: false, code: "INQUIRY_NOT_FOUND" });
  });
});

describe("requirementsForCustomer", () => {
  it("is null until something has been recorded", async () => {
    const { who } = await started();
    expect(await requirementsForCustomer(db, who)).toBeNull();
  });

  it("shows each field in a fixed order with its status and where it came from, and no ids", async () => {
    const { inquiryId, who } = await started();
    await withModelVersion(inquiryId);
    await editRequirements(db, who, { boxCount: 30 }, ctx);
    const view = await requirementsForCustomer(db, who);
    expect(view!.version).toBe(2);
    expect(view!.fields.map((f) => f.name)).toEqual(["boxCount", "noFood", "logoRequired", "maxPricePerBoxMinor", "requestedPickupDate", "preferences"]);
    expect(view!.fields.find((f) => f.name === "boxCount")).toMatchObject({ value: 30, status: "confirmed", source: "edit" });
    expect(view!.fields.find((f) => f.name === "noFood")).toMatchObject({ value: true, status: "confirmed", source: "message" });
    expect(view!.fields.find((f) => f.name === "logoRequired")).toMatchObject({ value: null, status: "unknown", source: null });
    expect(view!.question).toBeNull();
    expect(view!.proposal).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it("each customer sees only their own specification", async () => {
    const a = await started();
    const b = await started();
    await editRequirements(db, a.who, { boxCount: 11 }, ctx);
    await editRequirements(db, b.who, { boxCount: 22 }, ctx);
    expect((await requirementsForCustomer(db, a.who))!.fields[0]!.value).toBe(11);
    expect((await requirementsForCustomer(db, b.who))!.fields[0]!.value).toBe(22);
  });
});
