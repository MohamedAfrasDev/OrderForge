// Real local Postgres: the one-reply rule that keeps a customer message from being answered twice.
import { describe, expect, it } from "vitest";
import { SQLSTATE, anonClient, must, serviceClient, unique } from "./helpers";

const db = serviceClient();

async function inquiry(): Promise<string> {
  const merchant = must(await db.from("merchants").insert({ slug: unique("im"), name: "Intake test merchant" }).select("id").single(), "merchant");
  return must(await db.from("inquiries").insert({ merchant_id: merchant.id }).select("id").single(), "inquiry").id as string;
}

async function customerMessage(inquiryId: string, body = "I need 20 boxes"): Promise<string> {
  return must(await db.from("messages").insert({ inquiry_id: inquiryId, role: "customer", body }).select("id").single(), "customer message").id as string;
}

const reply = (inquiryId: string, replyTo: string | null, body = "How many boxes?") =>
  db.from("messages").insert({ inquiry_id: inquiryId, role: "assistant", body, reply_to: replyTo });

describe("messages.reply_to: one assistant reply per customer message", () => {
  it("an assistant message can answer a customer message of the same inquiry", async () => {
    const i = await inquiry();
    const q = await customerMessage(i);
    const out = await reply(i, q).select("id, reply_to").single();
    expect(out.error).toBeNull();
    expect(out.data!.reply_to).toBe(q);
  });

  it("a second assistant reply to the same message is rejected", async () => {
    const i = await inquiry();
    const q = await customerMessage(i);
    expect((await reply(i, q)).error).toBeNull();
    const again = await reply(i, q, "A different answer");
    expect(again.error?.code).toBe(SQLSTATE.unique);
    const replies = await db.from("messages").select("id").eq("reply_to", q);
    expect(replies.data).toHaveLength(1);
  });

  it("five replies at once leave exactly one", async () => {
    const i = await inquiry();
    const q = await customerMessage(i);
    const results = await Promise.all(Array.from({ length: 5 }, (_, n) => reply(i, q, `reply ${n}`)));
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === SQLSTATE.unique)).toHaveLength(4);
    expect((await db.from("messages").select("id").eq("reply_to", q)).data).toHaveLength(1);
  });

  it("each customer message can have its own reply", async () => {
    const i = await inquiry();
    const a = await customerMessage(i, "first");
    const b = await customerMessage(i, "second");
    expect((await reply(i, a)).error).toBeNull();
    expect((await reply(i, b)).error).toBeNull();
  });

  it("an assistant message with no reply_to is still allowed (it answers nothing in particular)", async () => {
    const i = await inquiry();
    expect((await reply(i, null)).error).toBeNull();
    expect((await reply(i, null, "another")).error).toBeNull();
  });

  it("only assistant messages can carry reply_to", async () => {
    const i = await inquiry();
    const q = await customerMessage(i);
    for (const role of ["customer", "merchant", "system"]) {
      const out = await db.from("messages").insert({ inquiry_id: i, role, body: "x", reply_to: q });
      expect(out.error?.code, role).toBe(SQLSTATE.check);
    }
  });

  it("a reply must answer a customer message of the same inquiry", async () => {
    const i = await inquiry();
    const other = await inquiry();
    const mine = await customerMessage(i);
    const theirs = await customerMessage(other);
    const assistantReply = must(await reply(i, mine).select("id").single(), "reply");

    expect((await reply(i, theirs)).error?.code).toBe(SQLSTATE.raised); // another inquiry's message
    expect((await reply(other, mine)).error?.code).toBe(SQLSTATE.raised); // from another inquiry
    expect((await reply(i, assistantReply.id as string)).error?.code).toBe(SQLSTATE.raised); // a reply to a reply
    expect((await reply(i, "00000000-0000-4000-8000-00000000dead")).error?.code).toBe("23503"); // no such message
  });

  it("deleting an inquiry removes its messages and replies without complaint", async () => {
    const i = await inquiry();
    const q = await customerMessage(i);
    await reply(i, q);
    expect((await db.from("inquiries").delete().eq("id", i)).error).toBeNull();
    expect((await db.from("messages").select("id").eq("inquiry_id", i)).data).toHaveLength(0);
  });

  it("is not writable by the anon role", async () => {
    const i = await inquiry();
    const q = await customerMessage(i);
    const denied = await anonClient().from("messages").insert({ inquiry_id: i, role: "assistant", body: "x", reply_to: q });
    expect(denied.error?.code).toBe(SQLSTATE.denied);
    expect((await db.from("messages").select("id").eq("reply_to", q)).data).toHaveLength(0);
  });
});
