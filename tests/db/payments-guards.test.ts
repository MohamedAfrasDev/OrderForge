// Real local Postgres. Evidence label for this file: local database, not mocked.
import { describe, expect, it } from "vitest";
import { inFlightOperationOf, transition, type AttemptEvent, type AttemptState, type BeginOperation } from "@/domain/payments";
import { codeOf, createChain, must, randomHash, serviceClient, SQLSTATE, unique } from "./helpers";
import { AMOUNT, T0 } from "./payments-helpers";

const db = serviceClient();

type Variant = { state: AttemptState; op?: BeginOperation };

const VARIANTS: Variant[] = [
  { state: "CREATED" },
  { state: "PROVIDER_CREATED" },
  { state: "APPROVED" },
  { state: "AUTHORIZE_IN_FLIGHT" },
  { state: "AUTHORIZED" },
  { state: "CAPTURE_IN_FLIGHT" },
  { state: "CAPTURED" },
  { state: "VOID_IN_FLIGHT" },
  { state: "VOIDED" },
  { state: "EXPIRED" },
  { state: "FAILED" },
  { state: "OUTCOME_UNKNOWN", op: "authorize" },
  { state: "OUTCOME_UNKNOWN", op: "capture" },
  { state: "OUTCOME_UNKNOWN", op: "void" },
  { state: "EXCEPTION" },
];

const label = (v: Variant) => (v.op ? `${v.state}:${v.op}` : v.state);

const NEEDS_ORDER: AttemptState[] = ["PROVIDER_CREATED", "APPROVED", "AUTHORIZE_IN_FLIGHT", "AUTHORIZED", "CAPTURE_IN_FLIGHT", "CAPTURED", "VOID_IN_FLIGHT", "VOIDED"];
const NEEDS_AUTH: AttemptState[] = ["AUTHORIZED", "CAPTURE_IN_FLIGHT", "CAPTURED", "VOID_IN_FLIGHT", "VOIDED"];

type Evidence = { paypal_order_id: string | null; authorization_id: string | null; authorized_at: string | null; capture_id: string | null };

/** Evidence columns for a row in `v`, keeping whatever the source row already carries (these are set once). */
function evidence(v: Variant, source?: Evidence): Evidence {
  const needsAuth = NEEDS_AUTH.includes(v.state) || (v.state === "OUTCOME_UNKNOWN" && v.op !== "authorize");
  const needsOrder = NEEDS_ORDER.includes(v.state) || v.state === "OUTCOME_UNKNOWN";
  return {
    paypal_order_id: source?.paypal_order_id ?? (needsOrder ? unique("ORDER") : null),
    authorization_id: source?.authorization_id ?? (needsAuth ? unique("AUTH") : null),
    authorized_at: source?.authorized_at ?? (needsAuth ? T0 : null),
    capture_id: source?.capture_id ?? (v.state === "CAPTURED" ? unique("CAP") : null),
  };
}

const stateColumns = (v: Variant) => ({ state: v.state, unknown_operation: v.op ?? null, exception_reason: v.state === "EXCEPTION" ? "AMOUNT_MISMATCH" : null });

/** What the spec's table allows, derived from the TypeScript state machine, plus the database's rule that the uncertain operation must be the one in flight. */
function legalByTable(from: Variant, to: Variant): boolean {
  if (from.state === to.state) return from.op === to.op;
  const context = { unknownOperation: from.op ?? null };
  const events: AttemptEvent[] = [];
  switch (to.state) {
    case "PROVIDER_CREATED":
      events.push({ type: "ORDER_CREATED" });
      break;
    case "APPROVED":
      events.push({ type: "APPROVE" }, { type: "SETTLE", outcome: "AUTHORIZE_NOT_DONE" }, { type: "RESOLVE", to: "APPROVED" });
      break;
    case "AUTHORIZE_IN_FLIGHT":
      events.push({ type: "BEGIN", operation: "authorize" });
      break;
    case "CAPTURE_IN_FLIGHT":
      events.push({ type: "BEGIN", operation: "capture" });
      break;
    case "VOID_IN_FLIGHT":
      events.push({ type: "BEGIN", operation: "void" });
      break;
    case "AUTHORIZED":
      events.push({ type: "SETTLE", outcome: "AUTHORIZED" }, { type: "SETTLE", outcome: "CAPTURE_FAILED" }, { type: "SETTLE", outcome: "VOID_FAILED" }, { type: "RESOLVE", to: "AUTHORIZED" });
      break;
    case "CAPTURED":
      events.push({ type: "SETTLE", outcome: "CAPTURED" }, { type: "RESOLVE", to: "CAPTURED" });
      break;
    case "VOIDED":
      events.push({ type: "SETTLE", outcome: "VOIDED" }, { type: "RESOLVE", to: "VOIDED" });
      break;
    case "EXPIRED":
      events.push({ type: "EXPIRE" });
      break;
    case "FAILED":
      events.push({ type: "FAIL" }, { type: "SETTLE", outcome: "AUTHORIZE_FAILED" }, { type: "RESOLVE", to: "FAILED" });
      break;
    case "OUTCOME_UNKNOWN":
      // The recorded operation must be the one that was in flight.
      if (to.op !== inFlightOperationOf(from.state)) return false;
      events.push({ type: "SETTLE", outcome: "UNKNOWN" });
      break;
    case "EXCEPTION":
      events.push({ type: "SETTLE", outcome: "EXCEPTION" }, { type: "FLAG_EXCEPTION" }, { type: "RESOLVE", to: "EXCEPTION" });
      break;
  }
  return events.some((event) => transition(from.state, event, context) === to.state);
}

async function attemptIn(v: Variant): Promise<{ id: string; evidence: Evidence }> {
  const chain = await createChain(db);
  const ev = evidence(v);
  const row = must(
    await db
      .from("payment_attempts")
      .insert({ purchase_id: chain.purchaseId, amount_minor: AMOUNT, quote_hash: chain.quoteHash, ...stateColumns(v), ...ev })
      .select("id")
      .single(),
    `insert ${label(v)}`,
  );
  return { id: row.id as string, evidence: ev };
}

describe("payment attempt transitions match the TypeScript table and the spec", () => {
  const pairs = VARIANTS.flatMap((from) => VARIANTS.map((to) => [from, to] as const));

  it.each(pairs.map(([from, to]) => [label(from), label(to), from, to] as const))("%s to %s", async (_f, _t, from, to) => {
    const source = await attemptIn(from);
    const result = await db
      .from("payment_attempts")
      .update({ ...stateColumns(to), ...evidence(to, source.evidence) })
      .eq("id", source.id);
    if (legalByTable(from, to)) expect(codeOf(result), `${label(from)} -> ${label(to)} should be allowed`).toBe("none");
    else expect(codeOf(result), `${label(from)} -> ${label(to)} should be refused`).toBe(SQLSTATE.raised);
  });
});

describe("what the table cannot say", () => {
  it.each(["CAPTURED", "VOIDED", "EXPIRED", "FAILED", "EXCEPTION"] as const)("%s is final: no column of it can change", async (state) => {
    const a = await attemptIn({ state });
    for (const patch of [{ failure_code: "later" }, { approve_url: "https://www.paypal.com/x" }, { authorization_expires_at: "2030-01-01T00:00:00Z" }, { state_changed_at: "2030-01-01T00:00:00Z" }]) {
      expect(codeOf(await db.from("payment_attempts").update(patch).eq("id", a.id)), `${state} ${JSON.stringify(patch)}`).toBe(SQLSTATE.raised);
    }
  });

  it.each([
    ["the amount", { amount_minor: 1 }],
    ["the quote hash", { quote_hash: randomHash() }],
  ])("%s of an attempt never changes, in any state", async (_name, patch) => {
    for (const state of ["CREATED", "APPROVED", "AUTHORIZED"] as const) {
      const a = await attemptIn({ state });
      expect(codeOf(await db.from("payment_attempts").update(patch).eq("id", a.id)), state).toBe(SQLSTATE.raised);
    }
  });

  it("an attempt cannot be moved to another purchase", async () => {
    const a = await attemptIn({ state: "CREATED" });
    const other = await createChain(db);
    expect(codeOf(await db.from("payment_attempts").update({ purchase_id: other.purchaseId }).eq("id", a.id))).toBe(SQLSTATE.raised);
  });

  it("the PayPal ids are set once and never replaced", async () => {
    const authorized = await attemptIn({ state: "AUTHORIZED" });
    expect(codeOf(await db.from("payment_attempts").update({ paypal_order_id: unique("ORDER") }).eq("id", authorized.id))).toBe(SQLSTATE.raised);
    expect(codeOf(await db.from("payment_attempts").update({ authorization_id: unique("AUTH") }).eq("id", authorized.id))).toBe(SQLSTATE.raised);
    expect(codeOf(await db.from("payment_attempts").update({ authorized_at: "2030-01-01T00:00:00Z" }).eq("id", authorized.id))).toBe(SQLSTATE.raised);
  });

  it("within one state the uncertain operation cannot change", async () => {
    const a = await attemptIn({ state: "OUTCOME_UNKNOWN", op: "authorize" });
    expect(codeOf(await db.from("payment_attempts").update({ unknown_operation: "capture" }).eq("id", a.id))).toBe(SQLSTATE.raised);
  });

  it("a live attempt can have its approval link and failure note set", async () => {
    const a = await attemptIn({ state: "PROVIDER_CREATED" });
    expect(codeOf(await db.from("payment_attempts").update({ approve_url: "https://www.sandbox.paypal.com/checkoutnow?token=Z" }).eq("id", a.id))).toBe("none");
  });
});

describe("check constraints", () => {
  const insert = async (patch: Record<string, unknown>) => {
    const chain = await createChain(db);
    return codeOf(await db.from("payment_attempts").insert({ purchase_id: chain.purchaseId, amount_minor: AMOUNT, quote_hash: chain.quoteHash, ...patch }));
  };

  it.each(NEEDS_ORDER)("%s needs the PayPal order id", async (state) => {
    const base = { state, ...(state === "AUTHORIZE_IN_FLIGHT" ? {} : {}) };
    const withoutOrder = { ...base, ...(NEEDS_AUTH.includes(state) ? { authorization_id: unique("AUTH"), authorized_at: T0 } : {}), ...(state === "CAPTURED" ? { capture_id: unique("CAP") } : {}) };
    expect(await insert(withoutOrder)).toBe(SQLSTATE.check);
  });

  it.each(NEEDS_AUTH)("%s needs the authorization id", async (state) => {
    expect(await insert({ state, paypal_order_id: unique("ORDER"), ...(state === "CAPTURED" ? { capture_id: unique("CAP") } : {}) })).toBe(SQLSTATE.check);
  });

  it("CAPTURED needs the capture id: nothing can be marked paid without one", async () => {
    expect(await insert({ state: "CAPTURED", paypal_order_id: unique("ORDER"), authorization_id: unique("AUTH"), authorized_at: T0 })).toBe(SQLSTATE.check);
    expect(await insert({ state: "CAPTURED", paypal_order_id: unique("ORDER"), authorization_id: unique("AUTH"), authorized_at: T0, capture_id: unique("CAP") })).toBe("none");
  });

  it("an authorization id and its time come together", async () => {
    expect(await insert({ state: "CREATED", authorization_id: unique("AUTH") })).toBe(SQLSTATE.check);
    expect(await insert({ state: "CREATED", authorized_at: T0 })).toBe(SQLSTATE.check);
  });

  it("EXCEPTION needs a reason, and only EXCEPTION may have one", async () => {
    expect(await insert({ state: "EXCEPTION" })).toBe(SQLSTATE.check);
    expect(await insert({ state: "EXCEPTION", exception_reason: "AMOUNT_MISMATCH" })).toBe("none");
    expect(await insert({ state: "CREATED", exception_reason: "AMOUNT_MISMATCH" })).toBe(SQLSTATE.check);
    expect(await insert({ state: "EXCEPTION", exception_reason: "BORED" })).toBe(SQLSTATE.check);
  });

  it.each(["ORDER_MISMATCH", "AUTHORIZATION_MISMATCH", "STATUS_NOT_AS_EXPECTED", "AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "PAYEE_MISMATCH", "EVIDENCE_MISSING"])(
    "accepts the exception reason %s",
    async (reason) => {
      expect(await insert({ state: "EXCEPTION", exception_reason: reason })).toBe("none");
    },
  );

  it("the approval link must be an https PayPal address", async () => {
    expect(await insert({ approve_url: "https://www.sandbox.paypal.com/checkoutnow?token=1" })).toBe("none");
    for (const url of ["http://www.paypal.com/x", "https://evilpaypal.com/x", "https://paypal.com@evil.example.com/", "ftp://paypal.com/x"]) {
      expect(await insert({ approve_url: url }), url).toBe(SQLSTATE.check);
    }
  });

  it("a failure code is 1 to 64 characters", async () => {
    expect(await insert({ state: "FAILED", failure_code: "ORDER_REFUSED" })).toBe("none");
    expect(await insert({ state: "FAILED", failure_code: "" })).toBe(SQLSTATE.check);
    expect(await insert({ state: "FAILED", failure_code: "x".repeat(65) })).toBe(SQLSTATE.check);
  });
});
