// Real local Postgres: migration 0010's checks, the unique key and who can reach the table.
import { describe, expect, it } from "vitest";
import { anonClient, codeOf, createMerchantUser, must, serviceClient, signedInClient, SQLSTATE, unique } from "./helpers";
import { newMerchant } from "./intake-helpers";

const db = serviceClient();
const CHECK = SQLSTATE.check;

async function inquiry(email?: string | null) {
  const m = await newMerchant(db);
  return must(await db.from("inquiries").insert({ merchant_id: m.id, ...(email !== undefined ? { customer_email: email } : {}) }).select("id, merchant_id").single());
}
const row = (inquiryId: string, over: Record<string, unknown> = {}) => ({ inquiry_id: inquiryId, recipient: "customer", kind: "price_ready", dedupe_key: unique("price_ready"), ...over });

describe("inquiries.customer_email", () => {
  it("is optional, and stored as given when it is a lowercase address", async () => {
    expect(must(await db.from("inquiries").select("customer_email").eq("id", (await inquiry()).id).single()).customer_email).toBeNull();
    const withEmail = await inquiry("sam@example.com");
    expect(must(await db.from("inquiries").select("customer_email").eq("id", withEmail.id).single()).customer_email).toBe("sam@example.com");
  });

  it("refuses an address with capitals, spaces, no @, no dot after it, two @, or more than 254 characters", async () => {
    const m = await newMerchant(db);
    const bad = ["Sam@Example.com", "sam @example.com", " sam@example.com", "sam", "sam@", "@example.com", "sam@example", "a@b@c.com", "sam@exa mple.com", `${"a".repeat(250)}@example.com`];
    for (const email of bad) {
      const out = await db.from("inquiries").insert({ merchant_id: m.id, customer_email: email });
      expect(codeOf(out), email).toBe(CHECK);
    }
  });

  it("accepts an address of exactly 254 characters", async () => {
    const local = "a".repeat(254 - "@example.com".length);
    expect((await db.from("inquiries").insert({ merchant_id: (await newMerchant(db)).id, customer_email: `${local}@example.com` })).error).toBeNull();
  });
});

describe("notifications", () => {
  it("starts PENDING with no attempts and no sent time", async () => {
    const i = await inquiry();
    const made = must(await db.from("notifications").insert(row(i.id)).select("status, attempts, sent_at, updated_at, created_at").single());
    expect(made).toMatchObject({ status: "PENDING", attempts: 0, sent_at: null });
  });

  it("refuses an unknown recipient, kind or status, a bad attempt count and an empty or over-long key", async () => {
    const i = await inquiry();
    const bad: Array<Record<string, unknown>> = [
      { recipient: "everyone" },
      { kind: "newsletter" },
      { status: "QUEUED" },
      { attempts: -1 },
      { attempts: 11 },
      { dedupe_key: "" },
      { dedupe_key: "k".repeat(201) },
    ];
    for (const over of bad) expect(codeOf(await db.from("notifications").insert(row(i.id, over))), JSON.stringify(over)).toBe(CHECK);
  });

  it("holds exactly one row per dedupe key, however the second insert is made", async () => {
    const i = await inquiry();
    const key = unique("price_ready:quote");
    must(await db.from("notifications").insert(row(i.id, { dedupe_key: key })));
    expect(codeOf(await db.from("notifications").insert(row(i.id, { dedupe_key: key })))).toBe(SQLSTATE.unique);
    const other = await inquiry();
    expect(codeOf(await db.from("notifications").insert(row(other.id, { dedupe_key: key })))).toBe(SQLSTATE.unique);
    const ignored = await db.from("notifications").upsert(row(i.id, { dedupe_key: key }), { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id");
    expect(ignored.error).toBeNull();
    expect(must(await db.from("notifications").select("id").eq("dedupe_key", key))).toHaveLength(1);
  });

  it("a row is SENT exactly when it has a sent time", async () => {
    const i = await inquiry();
    expect(codeOf(await db.from("notifications").insert(row(i.id, { status: "SENT" })))).toBe(CHECK);
    expect(codeOf(await db.from("notifications").insert(row(i.id, { status: "PENDING", sent_at: "2026-11-05T10:00:00Z" })))).toBe(CHECK);
    expect((await db.from("notifications").insert(row(i.id, { status: "SENT", sent_at: "2026-11-05T10:00:00Z" }))).error).toBeNull();
    expect((await db.from("notifications").insert(row(i.id, { status: "FAILED", attempts: 3 }))).error).toBeNull();
  });

  it("has no column that could hold a message or an address", async () => {
    const cols = must(await db.from("notifications").select("*").limit(1).maybeSingle()) ?? null;
    const made = must(await db.from("notifications").insert(row((await inquiry()).id)).select("*").single());
    expect(Object.keys(made).sort()).toEqual(["attempts", "created_at", "dedupe_key", "id", "inquiry_id", "kind", "recipient", "sent_at", "status", "updated_at"]);
    void cols;
  });

  it("goes away with its inquiry", async () => {
    const i = await inquiry();
    const key = unique("gone");
    must(await db.from("notifications").insert(row(i.id, { dedupe_key: key })));
    must(await db.from("inquiries").delete().eq("id", i.id));
    expect(must(await db.from("notifications").select("id").eq("dedupe_key", key))).toHaveLength(0);
  });

  it("cannot be read or written by a visitor, or by a shop signed in, not even its own", async () => {
    const user = await createMerchantUser(db);
    const m = await newMerchant(db);
    must(await db.from("merchants").update({ owner_user_id: user.id }).eq("id", m.id));
    const mine = must(await db.from("inquiries").insert({ merchant_id: m.id }).select("id").single());
    const key = unique("private");
    must(await db.from("notifications").insert(row(mine.id, { dedupe_key: key })));

    const shop = await signedInClient(user.email, user.password);
    for (const client of [anonClient(), shop]) {
      const read = await client.from("notifications").select("id").eq("dedupe_key", key);
      expect(read.error?.message ?? "").toMatch(/permission denied/);
      expect(codeOf(await client.from("notifications").insert(row(mine.id)))).toBe(SQLSTATE.denied);
      expect((await client.from("notifications").update({ status: "SENT" }).eq("dedupe_key", key)).error?.message ?? "").toMatch(/permission denied/);
      expect((await client.from("notifications").delete().eq("dedupe_key", key)).error?.message ?? "").toMatch(/permission denied/);
    }
    expect(must(await db.from("notifications").select("status").eq("dedupe_key", key)).at(0)?.status).toBe("PENDING");
  });
});
