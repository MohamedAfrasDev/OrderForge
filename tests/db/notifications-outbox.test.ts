// Real local Postgres; purchases go through the LOCAL FAKE PayPal and emails through the FAKE email port (mocked evidence). No email is ever sent.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeEmail } from "@/lib/email/fake";
import { createJobForPurchase } from "@/services/fulfillment/create";
import { moveJob } from "@/services/fulfillment/move";
import { MAX_ATTEMPTS, MAX_PER_REQUEST, drainNotifications, type DrainDeps } from "@/services/notifications/drain";
import { enqueueNotifications } from "@/services/notifications/enqueue";
import { decide } from "@/services/payments/decide";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { createMerchantUser, must, serviceClient } from "./helpers";
import { T0 } from "./fulfillment-helpers";
import { takeTo, paypalFor } from "./fulfillment-paid";
import { SECRET } from "./intake-helpers";
import { expectStockConsistentAtEnd } from "./reservation-helpers";

const db = serviceClient();
expectStockConsistentAtEnd(db);

let fake: FakePayPal;
beforeAll(async () => {
  fake = await startFakePayPal();
});
afterAll(async () => {
  await fake.close();
});

const ctx = { now: T0, correlationId: "corr-outbox" };
const BASE = "https://orderforge.example";
const deps = (port: DrainDeps["port"], extra: Partial<DrainDeps> = {}): DrainDeps => ({ port, accessSecret: SECRET, appBaseUrl: BASE, ...extra });
const rowsOf = async (inquiryId: string) => must(await db.from("notifications").select("kind, recipient, status, attempts, dedupe_key, id").eq("inquiry_id", inquiryId).order("dedupe_key"));
const kindsOf = async (inquiryId: string) => (await rowsOf(inquiryId)).map((r) => r.kind as string).sort();

/** A paid-for order at `upTo`, owned by a shop whose owner has a login, with the customer's address on the request. */
async function order(upTo: "accepted" | "authorized" | "captured", customerEmail: string | null = "sam@example.com") {
  const owner = await createMerchantUser(db);
  const p = await takeTo(db, fake, upTo);
  must(await db.from("merchants").update({ owner_user_id: owner.id }).eq("id", p.m.merchantId));
  must(await db.from("inquiries").update({ customer_email: customerEmail }).eq("id", p.inquiryId));
  return { p, owner };
}

describe("enqueueNotifications", () => {
  it("queues the emails the state calls for, once each: a price, an order waiting for the shop, and the saved link", async () => {
    const { p } = await order("authorized");
    expect((await enqueueNotifications(db, ctx)).queued).toBeGreaterThan(0);
    expect(await kindsOf(p.inquiryId)).toEqual(["order_awaiting_ok", "price_ready", "request_started"]);
    const rows = await rowsOf(p.inquiryId);
    expect(rows.every((r) => r.status === "PENDING" && r.attempts === 0)).toBe(true);
    expect(rows.find((r) => r.kind === "order_awaiting_ok")).toMatchObject({ recipient: "shop", dedupe_key: `order_awaiting_ok:${p.purchaseId}` });
    expect(rows.find((r) => r.kind === "price_ready")).toMatchObject({ recipient: "customer", dedupe_key: `price_ready:${p.quoteId}` });
  });

  it("queues nothing more however often it runs, and nothing extra when it runs many times at once", async () => {
    const { p } = await order("authorized");
    await enqueueNotifications(db, ctx);
    const before = await rowsOf(p.inquiryId);
    await enqueueNotifications(db, ctx);
    await Promise.all(Array.from({ length: 6 }, () => enqueueNotifications(db, ctx)));
    expect(await rowsOf(p.inquiryId)).toEqual(before);
  });

  it("queues no customer email for a request with no address, only the shop's", async () => {
    const { p } = await order("authorized", null);
    await enqueueNotifications(db, ctx);
    expect(await kindsOf(p.inquiryId)).toEqual(["order_awaiting_ok"]);
  });

  it("queues the shop's email for a request that is with the shop, and the customer's for the shop's reply", async () => {
    const { p } = await order("accepted");
    must(await db.from("inquiries").update({ status: "REVIEW_REQUIRED" }).eq("id", p.inquiryId));
    must(await db.from("messages").insert({ inquiry_id: p.inquiryId, role: "merchant", body: "PRIVATE-REPLY-TEXT", created_at: T0 }));
    await enqueueNotifications(db, ctx);
    expect(await kindsOf(p.inquiryId)).toEqual(expect.arrayContaining(["request_handed_over", "shop_replied"]));
  });

  it("follows the order: accepted and paid, then ready for pickup", async () => {
    const { p } = await order("captured");
    await enqueueNotifications(db, ctx);
    expect(await kindsOf(p.inquiryId)).toEqual(["order_accepted", "price_ready", "request_started"]);
    expect(await kindsOf(p.inquiryId)).not.toContain("order_awaiting_ok");

    const made = await createJobForPurchase(db, p.purchaseId, ctx);
    if (!made.ok) throw new Error(made.code);
    await enqueueNotifications(db, ctx);
    expect(await kindsOf(p.inquiryId)).not.toContain("ready_for_pickup");
    await moveJob(db, p.actor, made.value.jobId, "PREPARING", {}, ctx);
    await moveJob(db, p.actor, made.value.jobId, "READY_FOR_PICKUP", {}, ctx);
    await enqueueNotifications(db, ctx);
    expect(await kindsOf(p.inquiryId)).toContain("ready_for_pickup");
  });

  it("a declined order is told to the customer", async () => {
    const { p } = await order("authorized");
    await decide(db, { paypal: paypalFor(fake), evidence: "mocked" }, p.actor, p.purchaseId, "declined", { reason: "Cannot make it in time." }, ctx);
    await enqueueNotifications(db, ctx);
    expect(await kindsOf(p.inquiryId)).toEqual(["order_declined", "price_ready", "request_started"]);
  });
});

describe("drainNotifications", () => {
  it("sends each email to the right person once, marks it SENT, and puts the notification id on it as the idempotency key", async () => {
    const { p, owner } = await order("authorized");
    must(await db.from("messages").update({ body: "CUSTOMER-SECRET-WORDS" }).eq("inquiry_id", p.inquiryId));
    await enqueueNotifications(db, ctx);
    const port = createFakeEmail();
    const summary = await drainNotifications(db, deps(port), ctx);
    expect(summary.sent).toBeGreaterThanOrEqual(3);

    const rows = await rowsOf(p.inquiryId);
    expect(rows.every((r) => r.status === "SENT")).toBe(true);
    const mine = port.delivered.filter((m) => rows.some((r) => r.id === m.idempotencyKey));
    expect(mine).toHaveLength(3);
    expect(mine.filter((m) => m.to === "sam@example.com")).toHaveLength(2); // saved link, price
    expect(mine.filter((m) => m.to === owner.email)).toHaveLength(1); // the shop's own login address, resolved now
    const price = mine.find((m) => m.subject.includes("prepared your price"))!;
    expect(price.text).toContain("$1,080.00 for 30 boxes");
    expect(price.text).toMatch(new RegExp(`${BASE}/o/[\\w-]+\\.[\\w-]+`));
    expect(mine.find((m) => m.to === owner.email)!.text).toContain(`${BASE}/merchant/decisions`);
    expect(JSON.stringify(mine)).not.toContain("CUSTOMER-SECRET-WORDS"); // no customer free text, ever

    // Running it again sends nothing.
    const again = createFakeEmail();
    await drainNotifications(db, deps(again), ctx);
    expect(again.sent.filter((m) => rows.some((r) => r.id === m.idempotencyKey))).toHaveLength(0);
  });

  it("marks a row SKIPPED when there is nowhere to send it: a shop with no login, or no provider configured", async () => {
    const { p } = await order("authorized");
    must(await db.from("merchants").update({ owner_user_id: null }).eq("id", p.m.merchantId));
    await enqueueNotifications(db, ctx);
    const port = createFakeEmail();
    await drainNotifications(db, deps(port), ctx);
    const rows = await rowsOf(p.inquiryId);
    expect(rows.find((r) => r.kind === "order_awaiting_ok")!.status).toBe("SKIPPED");
    expect(rows.find((r) => r.kind === "price_ready")!.status).toBe("SENT");

    const none = await order("authorized");
    await enqueueNotifications(db, ctx);
    await drainNotifications(db, deps(null), ctx);
    expect((await rowsOf(none.p.inquiryId)).every((r) => r.status === "SKIPPED")).toBe(true);
  });

  it("retries a failure on the next runs and gives up after three attempts, marking it FAILED", async () => {
    const { p } = await order("authorized", null);
    await enqueueNotifications(db, ctx);
    const port = createFakeEmail({ failTimes: Infinity });
    for (let run = 1; run < MAX_ATTEMPTS; run++) {
      await drainNotifications(db, deps(port), ctx);
      const row = (await rowsOf(p.inquiryId))[0]!;
      expect(row).toMatchObject({ status: "PENDING", attempts: run });
    }
    await drainNotifications(db, deps(port), ctx);
    expect((await rowsOf(p.inquiryId))[0]).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS });
    const before = port.sent.length;
    await drainNotifications(db, deps(port), ctx);
    expect(port.sent.length).toBe(before); // a FAILED row is not tried again
  });

  it("a provider that fails twice and then works still delivers, once", async () => {
    const { p } = await order("authorized", null);
    await enqueueNotifications(db, ctx);
    const port = createFakeEmail({ failTimes: 2 });
    for (let run = 0; run < 4; run++) await drainNotifications(db, deps(port), ctx);
    expect((await rowsOf(p.inquiryId))[0]).toMatchObject({ status: "SENT", attempts: 3 });
    expect(port.delivered).toHaveLength(1); // two failures, then one delivery
    expect(new Set(port.sent.map((m) => m.idempotencyKey)).size).toBe(1); // the same key every time, so a provider can drop a repeat
  });

  it("treats a provider that throws, or is too slow, as a failure and carries on with the next row", async () => {
    const a = await order("authorized", null);
    const b = await order("authorized", null);
    await enqueueNotifications(db, ctx);
    const throwing = createFakeEmail({ throwTimes: 1 });
    await expect(drainNotifications(db, deps(throwing), ctx)).resolves.toBeDefined();
    const states = [...(await rowsOf(a.p.inquiryId)), ...(await rowsOf(b.p.inquiryId))].map((r) => `${r.status}:${r.attempts}`);
    expect(states).toContain("SENT:1"); // the other row still went out
    expect(states).toContain("PENDING:1");

    const slow = createFakeEmail({ delayMs: 400 });
    const c = await order("authorized", null);
    await enqueueNotifications(db, ctx);
    await drainNotifications(db, deps(slow, { timeoutMs: 50 }), ctx);
    expect((await rowsOf(c.p.inquiryId))[0]).toMatchObject({ status: "PENDING", attempts: 1 });
  });

  it("never sends more than 8 emails for one request; the rest are SKIPPED", async () => {
    const m = await order("accepted");
    const inquiryId = m.p.inquiryId;
    must(await db.from("notifications").insert(Array.from({ length: 12 }, (_, i) => ({ inquiry_id: inquiryId, recipient: "customer", kind: "shop_replied", dedupe_key: `shop_replied:cap-${inquiryId}-${i}` }))));
    const port = createFakeEmail();
    await drainNotifications(db, deps(port), ctx);
    const rows = await rowsOf(inquiryId);
    expect(rows.filter((r) => r.status === "SENT")).toHaveLength(MAX_PER_REQUEST);
    expect(rows.filter((r) => r.status === "SKIPPED")).toHaveLength(12 - MAX_PER_REQUEST);
  });

  it("several runs at once send each email once", async () => {
    const { p } = await order("captured");
    await enqueueNotifications(db, ctx);
    const port = createFakeEmail({ delayMs: 30 });
    await Promise.all([1, 2, 3, 4].map(() => drainNotifications(db, deps(port), ctx)));
    const rows = await rowsOf(p.inquiryId);
    const keys = port.sent.map((m) => m.idempotencyKey).filter((k) => rows.some((r) => r.id === k));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(rows.length);
    expect(rows.every((r) => r.status === "SENT")).toBe(true);
  });

  it("writes no address, link or message to the audit trail, and nothing to the console", async () => {
    const { p, owner } = await order("authorized");
    await enqueueNotifications(db, ctx);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    await drainNotifications(db, deps(createFakeEmail()), ctx);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    const everything = JSON.stringify([must(await db.from("audit_events").select("*").eq("entity_id", p.inquiryId)), await rowsOf(p.inquiryId)]);
    expect(everything).not.toMatch(/sam@example|\/o\/ey|orderforge\.example/);
    expect(everything).not.toContain(owner.email);
  });
});

describe("a provider that always fails changes nothing about the order", () => {
  it("pay, accept, prepare and collect still work, with the same results, while every email fails", async () => {
    const { p } = await order("authorized");
    const failing = createFakeEmail({ failTimes: Infinity });
    const tick = async () => {
      await enqueueNotifications(db, ctx);
      await drainNotifications(db, deps(failing), ctx);
    };
    const snapshot = async () => ({
      attempt: must(await db.from("payment_attempts").select("state").eq("purchase_id", p.purchaseId).single()).state,
      quote: must(await db.from("quote_versions").select("status, total_minor, quote_hash").eq("id", p.quoteId).single()),
      stock: must(await db.from("stock").select("product_id, on_hand, reserved").in("product_id", Object.values(p.m.product)).order("product_id")),
    });

    const before = await snapshot();
    await tick();
    expect(await snapshot()).toEqual(before); // looking and failing to send changes no order data

    const decided = await decide(db, { paypal: paypalFor(fake), evidence: "mocked" }, p.actor, p.purchaseId, "accepted", { confirmedConditions: [] }, ctx);
    expect(decided).toMatchObject({ ok: true });
    await tick();
    const made = await createJobForPurchase(db, p.purchaseId, ctx);
    if (!made.ok) throw new Error(made.code);
    await tick();
    for (const step of ["PREPARING", "READY_FOR_PICKUP", "COLLECTED"] as const) {
      expect(await moveJob(db, p.actor, made.value.jobId, step, {}, ctx)).toMatchObject({ ok: true });
      await tick();
    }
    expect(must(await db.from("payment_attempts").select("state").eq("purchase_id", p.purchaseId).single()).state).toBe("CAPTURED");
    expect(must(await db.from("preparation_jobs").select("status").eq("id", made.value.jobId).single()).status).toBe("COLLECTED");
    expect(failing.sent.length).toBeGreaterThan(0);
    expect(failing.delivered).toHaveLength(0);
  });
});
