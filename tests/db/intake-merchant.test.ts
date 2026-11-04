// Real local Postgres, with real merchant sessions: what a merchant sees of handed-over inquiries, and replying to them.
import { describe, expect, it } from "vitest";
import { getCustomerMessages } from "@/lib/access/inquiry-reads";
import { handOffToMerchant } from "@/services/intake/choose";
import { editRequirements } from "@/services/intake/edit";
import { listInquiriesForMerchant } from "@/services/intake/read";
import { replyAsMerchant } from "@/services/intake/merchant";
import { startInquiry } from "@/services/intake/start";
import { anonClient, createMerchantUser, must, serviceClient, signedInClient, unique } from "./helpers";
import { ctx, deps, verifiedFor } from "./intake-helpers";

const db = serviceClient();

async function merchantWithSession() {
  const user = await createMerchantUser(db);
  const slug = unique("mm").toLowerCase();
  const merchant = must(await db.from("merchants").insert({ slug, name: "Intake merchant", owner_user_id: user.id }).select("id").single(), "merchant");
  return { merchantId: merchant.id as string, slug, userId: user.id, session: await signedInClient(user.email, user.password) };
}

type Seller = Awaited<ReturnType<typeof merchantWithSession>>;

/** A customer inquiry on this merchant's store, handed over. */
async function handedOver(m: Seller, text = "I need some boxes", at = ctx.now) {
  const started = await startInquiry(db, deps, m.slug, text, ctx);
  if (!started.ok) throw new Error("start");
  const who = await verifiedFor(db, started.value.inquiryId);
  const out = await handOffToMerchant(db, who, "customer_request", { ...ctx, now: at });
  if (!out.ok) throw new Error("handoff");
  return { inquiryId: started.value.inquiryId, who };
}

const actorOf = (m: Seller) => ({ userId: m.userId, merchantId: m.merchantId });

describe("listInquiriesForMerchant (under the merchant's own session)", () => {
  it("lists the handed-over inquiries with the whole conversation and the specification, and nothing else", async () => {
    const m = await merchantWithSession();
    const one = await handedOver(m, "20 boxes with a logo");
    await editRequirements(db, one.who, { boxCount: 20, logoRequired: true }, ctx);

    // Not handed over: a new one, and one the customer is still working on.
    await startInquiry(db, deps, m.slug, "still talking to the assistant", ctx);

    const list = await listInquiriesForMerchant(m.session, m.merchantId);
    expect(list.map((i) => i.inquiryId)).toEqual([one.inquiryId]);
    const [i] = list;
    expect(i!.messages.map((x) => [x.role, x.body.slice(0, 12)])).toEqual([["customer", "20 boxes wit"], ["system", "You asked th"]]);
    expect(i!.fields.find((f) => f.name === "boxCount")).toMatchObject({ value: 20, status: "confirmed", source: "edit" });
    expect(i!.fields.find((f) => f.name === "logoRequired")).toMatchObject({ value: true });
    expect(i!.fields.find((f) => f.name === "noFood")).toMatchObject({ value: null, status: "unknown" });
  });

  it("an inquiry handed over before anything was recorded is listed with an empty specification", async () => {
    const m = await merchantWithSession();
    const one = await handedOver(m);
    const [i] = await listInquiriesForMerchant(m.session, m.merchantId);
    expect(i!.inquiryId).toBe(one.inquiryId);
    expect(i!.fields).toEqual([]);
    expect(i!.question).toBeNull();
  });

  it("lists the most recently handed over first", async () => {
    const m = await merchantWithSession();
    const older = await handedOver(m, "older");
    await new Promise((r) => setTimeout(r, 25));
    const newer = await handedOver(m, "newer");
    expect((await listInquiriesForMerchant(m.session, m.merchantId)).map((i) => i.inquiryId)).toEqual([newer.inquiryId, older.inquiryId]);
  });

  it("another merchant sees nothing of it, even when asking for this merchant's id; a visitor with no session sees nothing", async () => {
    const owner = await merchantWithSession();
    const other = await merchantWithSession();
    await handedOver(owner, "private to the owner");

    expect(await listInquiriesForMerchant(other.session, owner.merchantId)).toEqual([]);
    expect(await listInquiriesForMerchant(other.session, other.merchantId)).toEqual([]);
    await expect(listInquiriesForMerchant(anonClient(), owner.merchantId)).rejects.toThrow(/permission denied/);
  });
});

describe("replyAsMerchant", () => {
  it("stores a merchant message after the conversation, which the customer reads; the audit says who, not what", async () => {
    const m = await merchantWithSession();
    const { inquiryId, who } = await handedOver(m);
    expect(await replyAsMerchant(db, actorOf(m), inquiryId, "  We can do that. Which colour?  ", ctx)).toEqual({ ok: true, value: undefined });

    const seen = await getCustomerMessages(db, who);
    expect(seen.map((x) => x.role)).toEqual(["customer", "system", "merchant"]);
    expect(seen.at(-1)!.body).toBe("We can do that. Which colour?");

    const rows = must(await db.from("audit_events").select("actor, data").eq("entity_id", inquiryId).eq("action", "intake.merchant_replied"));
    expect(rows).toEqual([{ actor: `merchant:${m.userId}`, data: { inquiry_id: inquiryId } }]);
    expect(JSON.stringify(rows)).not.toContain("colour");

    const [listed] = await listInquiriesForMerchant(m.session, m.merchantId);
    expect(listed!.messages.at(-1)).toMatchObject({ role: "merchant", body: "We can do that. Which colour?" });
  });

  it("refuses an empty, over-long or NUL-carrying reply and stores nothing", async () => {
    const m = await merchantWithSession();
    const { inquiryId, who } = await handedOver(m);
    for (const body of ["", "   ", "x".repeat(4001), "a\u0000b", 5, null, undefined]) {
      expect(await replyAsMerchant(db, actorOf(m), inquiryId, body, ctx), String(body).slice(0, 10)).toMatchObject({ ok: false });
    }
    expect((await getCustomerMessages(db, who)).filter((x) => x.role === "merchant")).toHaveLength(0);
  });

  it("only the merchant who owns the inquiry can reply; another merchant gets the same answer as for no inquiry at all", async () => {
    const owner = await merchantWithSession();
    const other = await merchantWithSession();
    const { inquiryId, who } = await handedOver(owner);
    expect(await replyAsMerchant(db, actorOf(other), inquiryId, "hello", ctx)).toMatchObject({ ok: false, code: "INQUIRY_NOT_FOUND" });
    expect(await replyAsMerchant(db, actorOf(owner), "00000000-0000-4000-8000-00000000dead", "hello", ctx)).toMatchObject({ ok: false, code: "INQUIRY_NOT_FOUND" });
    expect(await replyAsMerchant(db, actorOf(owner), "not-a-uuid", "hello", ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await getCustomerMessages(db, who)).filter((x) => x.role === "merchant")).toHaveLength(0);
  });

  it("only while the inquiry is with the merchant", async () => {
    const m = await merchantWithSession();
    const started = await startInquiry(db, deps, m.slug, "still with the assistant", ctx);
    if (!started.ok) throw new Error("start");
    expect(await replyAsMerchant(db, actorOf(m), started.value.inquiryId, "hello", ctx)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });

  it("two replies in a row both land, in order", async () => {
    const m = await merchantWithSession();
    const { inquiryId, who } = await handedOver(m);
    await replyAsMerchant(db, actorOf(m), inquiryId, "first", ctx);
    await replyAsMerchant(db, actorOf(m), inquiryId, "second", ctx);
    expect((await getCustomerMessages(db, who)).filter((x) => x.role === "merchant").map((x) => x.body)).toEqual(["first", "second"]);
  });
});
