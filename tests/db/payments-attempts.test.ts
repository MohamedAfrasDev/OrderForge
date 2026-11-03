// Real local Postgres. Evidence label for this file: local database, not mocked.
import { describe, expect, it } from "vitest";
import { anonClient, codeOf, createChain, must, randomHash, serviceClient, SQLSTATE, unique } from "./helpers";
import { AMOUNT, T0, attemptRow, createAttempt, failAttempt, markApproved, newPurchase, pay, recordOrder } from "./payments-helpers";

const db = serviceClient();
const unknown = () => "00000000-0000-4000-8000-000000000000";

describe("payment_create_attempt", () => {
  it("creates a CREATED attempt for the accepted amount and quote hash", async () => {
    const chain = await newPurchase(db);
    const r = await createAttempt(db, chain);
    expect(r).toMatchObject({ ok: true, already: false, state: "CREATED" });
    expect(await attemptRow(db, r.attempt_id!)).toMatchObject({
      state: "CREATED",
      amount_minor: AMOUNT,
      currency: "USD",
      quote_hash: chain.quoteHash,
      paypal_order_id: null,
      authorization_id: null,
      capture_id: null,
    });
    expect(new Date((await attemptRow(db, r.attempt_id!)).state_changed_at).toISOString()).toBe(T0);
  });

  it("is idempotent for the same purchase, amount and hash", async () => {
    const chain = await newPurchase(db);
    const first = await createAttempt(db, chain);
    const again = await createAttempt(db, chain);
    expect(again).toMatchObject({ ok: true, already: true, attempt_id: first.attempt_id, state: "CREATED" });
    expect(must(await db.from("payment_attempts").select("id").eq("purchase_id", chain.purchaseId))).toHaveLength(1);
  });

  it("five simultaneous creates make one attempt", async () => {
    const chain = await newPurchase(db);
    const results = await Promise.all(Array.from({ length: 5 }, () => createAttempt(db, chain)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.attempt_id)).size).toBe(1);
    expect(results.filter((r) => r.already === false)).toHaveLength(1);
  });

  it("takes the amount and hash only from the accepted quote: any other value is refused and creates nothing", async () => {
    const chain = await newPurchase(db);
    for (const over of [{ p_amount_minor: 1 }, { p_amount_minor: AMOUNT + 1 }, { p_amount_minor: 0 }, { p_amount_minor: -5 }, { p_quote_hash: randomHash() }, { p_quote_hash: "not-a-hash" }]) {
      expect(await createAttempt(db, chain, over), JSON.stringify(over)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(must(await db.from("payment_attempts").select("id").eq("purchase_id", chain.purchaseId))).toHaveLength(0);
  });

  it("reports an unknown purchase as NOT_FOUND", async () => {
    expect(await pay(db, "payment_create_attempt", { p_purchase_id: unknown(), p_amount_minor: AMOUNT, p_quote_hash: randomHash(), p_now: T0 })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it.each(["PROVIDER_CREATED", "APPROVED"])("returns the existing active attempt in %s instead of making a second", async (target) => {
    const chain = await newPurchase(db);
    const a = await createAttempt(db, chain);
    await recordOrder(db, a.attempt_id!, unique("ORDER"));
    if (target === "APPROVED") await markApproved(db, a.attempt_id!);
    expect(await createAttempt(db, chain)).toMatchObject({ ok: true, already: true, attempt_id: a.attempt_id, state: target });
  });

  it("refuses ATTEMPT_ACTIVE while the earlier attempt is OUTCOME_UNKNOWN, even for the same quote", async () => {
    const chain = await newPurchase(db);
    must(await db.from("payment_attempts").insert({ purchase_id: chain.purchaseId, amount_minor: AMOUNT, quote_hash: chain.quoteHash, state: "OUTCOME_UNKNOWN", unknown_operation: "capture", paypal_order_id: unique("ORDER"), authorization_id: unique("AUTH"), authorized_at: T0 }));
    expect(await createAttempt(db, chain)).toMatchObject({ ok: false, code: "ATTEMPT_ACTIVE", state: "OUTCOME_UNKNOWN" });
  });

  it.each(["VOIDED", "EXPIRED", "FAILED", "CAPTURED"] as const)("allows a new attempt once the earlier one is %s", async (terminal) => {
    const chain = await newPurchase(db);
    const evidence: Record<string, unknown> =
      terminal === "VOIDED" || terminal === "CAPTURED"
        ? { paypal_order_id: unique("ORDER"), authorization_id: unique("AUTH"), authorized_at: T0, ...(terminal === "CAPTURED" ? { capture_id: unique("CAP") } : {}) }
        : {};
    must(await db.from("payment_attempts").insert({ purchase_id: chain.purchaseId, amount_minor: AMOUNT, quote_hash: chain.quoteHash, state: terminal, ...evidence }));
    const r = await createAttempt(db, chain);
    expect(r).toMatchObject({ ok: true, already: false, state: "CREATED" });
  });

  it("refuses ATTEMPT_ACTIVE while an EXCEPTION is still on file: a person must deal with it first", async () => {
    const chain = await newPurchase(db);
    must(await db.from("payment_attempts").insert({ purchase_id: chain.purchaseId, amount_minor: AMOUNT, quote_hash: chain.quoteHash, state: "EXCEPTION", exception_reason: "AMOUNT_MISMATCH" }));
    expect(await createAttempt(db, chain)).toMatchObject({ ok: false, code: "ATTEMPT_ACTIVE" });
  });
});

describe("payment_record_order", () => {
  it("moves CREATED to PROVIDER_CREATED with the order id and the approval link", async () => {
    const chain = await newPurchase(db);
    const a = await createAttempt(db, chain);
    const orderId = unique("ORDER");
    const url = "https://www.sandbox.paypal.com/checkoutnow?token=ABC";
    expect(await recordOrder(db, a.attempt_id!, orderId, url)).toMatchObject({ ok: true, already: false, state: "PROVIDER_CREATED" });
    expect(await attemptRow(db, a.attempt_id!)).toMatchObject({ state: "PROVIDER_CREATED", paypal_order_id: orderId, approve_url: url });
  });

  it("is a no-op when the same order is recorded again, and refuses a different order", async () => {
    const chain = await newPurchase(db);
    const a = await createAttempt(db, chain);
    const orderId = unique("ORDER");
    await recordOrder(db, a.attempt_id!, orderId);
    expect(await recordOrder(db, a.attempt_id!, orderId)).toMatchObject({ ok: true, already: true, state: "PROVIDER_CREATED" });
    expect(await recordOrder(db, a.attempt_id!, unique("OTHER"))).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect((await attemptRow(db, a.attempt_id!)).paypal_order_id).toBe(orderId);
  });

  it("accepts a missing approval link: the service decides what to do without one", async () => {
    const a = await createAttempt(db, await newPurchase(db));
    expect(await recordOrder(db, a.attempt_id!, unique("ORDER"), null)).toMatchObject({ ok: true });
    expect((await attemptRow(db, a.attempt_id!)).approve_url).toBeNull();
  });

  it.each([
    ["an http link", "http://www.sandbox.paypal.com/checkoutnow"],
    ["another host", "https://evil.example.com/paypal.com"],
    ["a look-alike host", "https://evilpaypal.com/checkoutnow"],
    ["a user-info trick", "https://paypal.com@evil.example.com/"],
    ["a link with whitespace", "https://www.paypal.com/check out"],
    ["a javascript link", "javascript:alert(1)"],
  ])("refuses %s as an approval link and leaves the attempt untouched", async (_name, url) => {
    const a = await createAttempt(db, await newPurchase(db));
    const r = await recordOrder(db, a.attempt_id!, unique("ORDER"), url);
    expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await attemptRow(db, a.attempt_id!)).toMatchObject({ state: "CREATED", paypal_order_id: null, approve_url: null });
  });

  it("accepts both the sandbox and the plain paypal.com hosts", async () => {
    for (const url of ["https://www.sandbox.paypal.com/checkoutnow?token=X", "https://paypal.com/checkoutnow?token=X", "https://www.paypal.com/checkoutnow?token=X"]) {
      const a = await createAttempt(db, await newPurchase(db));
      expect((await recordOrder(db, a.attempt_id!, unique("ORDER"), url)).ok, url).toBe(true);
    }
  });

  it("refuses a malformed order id, an unknown attempt, and an attempt past CREATED", async () => {
    const a = await createAttempt(db, await newPurchase(db));
    expect(await recordOrder(db, a.attempt_id!, "bad id with spaces")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await recordOrder(db, a.attempt_id!, "")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await recordOrder(db, unknown(), unique("ORDER"))).toMatchObject({ ok: false, code: "NOT_FOUND" });

    await failAttempt(db, a.attempt_id!);
    expect(await recordOrder(db, a.attempt_id!, unique("ORDER"))).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });

  it("refuses an order id that another attempt already uses, without changing the attempt", async () => {
    const orderId = unique("ORDER");
    const first = await createAttempt(db, await newPurchase(db));
    await recordOrder(db, first.attempt_id!, orderId);
    const second = await createAttempt(db, await newPurchase(db));
    expect(await recordOrder(db, second.attempt_id!, orderId)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await attemptRow(db, second.attempt_id!)).state).toBe("CREATED");
  });
});

describe("payment_mark_approved", () => {
  it("moves PROVIDER_CREATED to APPROVED, and a repeat is a no-op", async () => {
    const a = await createAttempt(db, await newPurchase(db));
    await recordOrder(db, a.attempt_id!, unique("ORDER"));
    expect(await markApproved(db, a.attempt_id!)).toMatchObject({ ok: true, already: false, state: "APPROVED" });
    expect(await markApproved(db, a.attempt_id!)).toMatchObject({ ok: true, already: true, state: "APPROVED" });
    expect((await attemptRow(db, a.attempt_id!)).state).toBe("APPROVED");
  });

  it("refuses an attempt with no order yet, and an unknown attempt", async () => {
    const a = await createAttempt(db, await newPurchase(db));
    expect(await markApproved(db, a.attempt_id!)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(await markApproved(db, unknown())).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("five simultaneous approvals leave it approved once", async () => {
    const a = await createAttempt(db, await newPurchase(db));
    await recordOrder(db, a.attempt_id!, unique("ORDER"));
    const results = await Promise.all(Array.from({ length: 5 }, () => markApproved(db, a.attempt_id!)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.already === false)).toHaveLength(1);
  });
});

describe("payment_fail", () => {
  it.each(["CREATED", "PROVIDER_CREATED", "APPROVED"])("fails an attempt in %s with a code, and a repeat is a no-op", async (from) => {
    const a = await createAttempt(db, await newPurchase(db));
    if (from !== "CREATED") await recordOrder(db, a.attempt_id!, unique("ORDER"));
    if (from === "APPROVED") await markApproved(db, a.attempt_id!);
    expect(await failAttempt(db, a.attempt_id!, "ORDER_REFUSED")).toMatchObject({ ok: true, already: false, state: "FAILED" });
    expect(await failAttempt(db, a.attempt_id!, "ORDER_REFUSED")).toMatchObject({ ok: true, already: true });
    expect(await attemptRow(db, a.attempt_id!)).toMatchObject({ state: "FAILED", failure_code: "ORDER_REFUSED" });
  });

  it("refuses a blank or overlong code, an unknown attempt, and an attempt that is already authorized", async () => {
    const a = await createAttempt(db, await newPurchase(db));
    expect(await failAttempt(db, a.attempt_id!, "  ")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await failAttempt(db, a.attempt_id!, "x".repeat(65))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await failAttempt(db, unknown())).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await attemptRow(db, a.attempt_id!)).state).toBe("CREATED");

    const chain = await newPurchase(db);
    const row = must(
      await db
        .from("payment_attempts")
        .insert({ purchase_id: chain.purchaseId, amount_minor: AMOUNT, quote_hash: chain.quoteHash, state: "AUTHORIZED", paypal_order_id: unique("ORDER"), authorization_id: unique("AUTH"), authorized_at: T0 })
        .select("id")
        .single(),
    );
    expect(await failAttempt(db, row.id as string)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });
});

describe("function privileges", () => {
  it.each([
    ["payment_create_attempt", { p_purchase_id: unknown(), p_amount_minor: AMOUNT, p_quote_hash: "a".repeat(64), p_now: T0 }],
    ["payment_record_order", { p_attempt_id: unknown(), p_order_id: "X", p_approve_url: null, p_now: T0 }],
    ["payment_mark_approved", { p_attempt_id: unknown(), p_now: T0 }],
    ["payment_fail", { p_attempt_id: unknown(), p_failure_code: "X", p_now: T0 }],
  ])("%s cannot be called by the anon role", async (fn, args) => {
    expect(codeOf(await anonClient().rpc(fn, args))).toBe(SQLSTATE.denied);
    expect(typeof (await createChain(db)).purchaseId).toBe("string");
  });
});
