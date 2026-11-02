// Real local Postgres. Evidence label for this file: local database, not mocked.
import { describe, expect, it } from "vitest";
import { transition, type Operation, type ReservationEvent, type ReservationState } from "@/domain/reservation";
import { codeOf, createChain, must, serviceClient, SQLSTATE } from "./helpers";

const db = serviceClient();

type ReleaseReason = "EXPIRED" | "SUPERSEDED" | "ABANDONED" | "DECLINED" | "VOIDED";
type Variant = { state: ReservationState; op?: Operation; reason?: ReleaseReason };

const REASONS: ReleaseReason[] = ["EXPIRED", "SUPERSEDED", "ABANDONED", "DECLINED", "VOIDED"];
const VARIANTS: Variant[] = [
  { state: "HELD" },
  { state: "PAYMENT_IN_FLIGHT", op: "authorize" },
  { state: "PAYMENT_IN_FLIGHT", op: "capture" },
  { state: "PAYMENT_IN_FLIGHT", op: "void" },
  { state: "AWAITING_CONFIRMATION" },
  { state: "COMMITTED" },
  ...REASONS.map((reason) => ({ state: "RELEASED" as const, reason })),
  { state: "REVIEW_REQUIRED" },
];

const label = (v: Variant) => [v.state, v.op, v.reason].filter(Boolean).join(":");
const columns = (v: Variant) => ({ state: v.state, in_flight_operation: v.op ?? null, release_reason: v.reason ?? null });

/**
 * What the spec's table allows, derived from the TypeScript state machine. The database is stricter in one place the
 * domain does not model: a void settlement may only release with the reason DECLINED or VOIDED.
 */
function legalByTable(from: Variant, to: Variant): boolean {
  if (from.state === to.state) return from.op === to.op && from.reason === to.reason;
  const context = { inFlightOperation: from.op ?? null, releaseReason: from.reason ?? null };
  const events: ReservationEvent[] = [];
  switch (to.state) {
    case "PAYMENT_IN_FLIGHT":
      events.push({ type: "BEGIN", operation: to.op! });
      break;
    case "RELEASED":
      if (from.state === "HELD") events.push({ type: "RELEASE", reason: to.reason! });
      if (from.state === "PAYMENT_IN_FLIGHT" && (to.reason === "DECLINED" || to.reason === "VOIDED")) events.push({ type: "SETTLE", outcome: "VOIDED" });
      events.push({ type: "RESOLVE", target: "RELEASED" });
      break;
    case "HELD":
      events.push({ type: "REHOLD" }, { type: "SETTLE", outcome: "AUTHORIZE_FAILED" }, { type: "RESOLVE", target: "HELD" });
      break;
    case "AWAITING_CONFIRMATION":
      events.push(
        { type: "SETTLE", outcome: "AUTHORIZED" },
        { type: "SETTLE", outcome: "CAPTURE_FAILED" },
        { type: "SETTLE", outcome: "VOID_FAILED" },
        { type: "RESOLVE", target: "AWAITING_CONFIRMATION" },
      );
      break;
    case "COMMITTED":
      events.push({ type: "SETTLE", outcome: "CAPTURED" }, { type: "RESOLVE", target: "COMMITTED" });
      break;
    case "REVIEW_REQUIRED":
      events.push({ type: "SETTLE", outcome: "UNKNOWN" }, { type: "FLAG_REVIEW" });
      break;
  }
  return events.some((event) => transition(from.state, event, context) === to.state);
}

async function reservationIn(v: Variant): Promise<string> {
  const chain = await createChain(db);
  return must(await db.from("reservations").insert({ purchase_id: chain.purchaseId, ...columns(v) }).select("id").single(), `insert ${label(v)}`).id as string;
}

describe("reservation status transitions match the TypeScript table and the spec", () => {
  const pairs = VARIANTS.flatMap((from) => VARIANTS.map((to) => [from, to] as const));

  it.each(pairs.map(([from, to]) => [label(from), label(to), from, to] as const))("%s to %s", async (_f, _t, from, to) => {
    const id = await reservationIn(from);
    const result = await db.from("reservations").update(columns(to)).eq("id", id);
    if (legalByTable(from, to)) expect(codeOf(result), `${label(from)} -> ${label(to)} should be allowed`).toBe("none");
    else expect(codeOf(result), `${label(from)} -> ${label(to)} should be refused`).toBe(SQLSTATE.raised);
  });
});

describe("what the table cannot say", () => {
  it("COMMITTED is final: no column of it can change", async () => {
    const id = await reservationIn({ state: "COMMITTED" });
    for (const patch of [{ expires_at: "2030-01-01T00:00:00Z" }, { review_reason: "x" }, { state_changed_at: "2030-01-01T00:00:00Z" }]) {
      expect(codeOf(await db.from("reservations").update(patch).eq("id", id)), JSON.stringify(patch)).toBe(SQLSTATE.raised);
    }
  });

  it("a HELD reservation can have its expiry changed", async () => {
    const id = await reservationIn({ state: "HELD" });
    expect(codeOf(await db.from("reservations").update({ expires_at: "2030-01-01T00:00:00Z" }).eq("id", id))).toBe("none");
  });

  it("a REVIEW_REQUIRED reservation can be given a review reason", async () => {
    const id = await reservationIn({ state: "REVIEW_REQUIRED" });
    expect(codeOf(await db.from("reservations").update({ review_reason: "outcome unknown after timeout" }).eq("id", id))).toBe("none");
  });

  it("the purchase a reservation belongs to cannot change", async () => {
    const id = await reservationIn({ state: "HELD" });
    const other = await createChain(db);
    expect(codeOf(await db.from("reservations").update({ purchase_id: other.purchaseId }).eq("id", id))).toBe(SQLSTATE.raised);
  });
});

describe("check constraints", () => {
  const insert = async (patch: Record<string, unknown>) => {
    const chain = await createChain(db);
    return codeOf(await db.from("reservations").insert({ purchase_id: chain.purchaseId, ...patch }));
  };

  it("PAYMENT_IN_FLIGHT needs a recorded operation", async () => {
    expect(await insert({ state: "PAYMENT_IN_FLIGHT" })).toBe(SQLSTATE.check);
    expect(await insert({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "authorize" })).toBe("none");
  });

  it("an operation can only be recorded while PAYMENT_IN_FLIGHT", async () => {
    expect(await insert({ state: "HELD", in_flight_operation: "capture" })).toBe(SQLSTATE.check);
  });

  it("RELEASED needs a reason, and only RELEASED may have one", async () => {
    expect(await insert({ state: "RELEASED" })).toBe(SQLSTATE.check);
    expect(await insert({ state: "RELEASED", release_reason: "EXPIRED" })).toBe("none");
    expect(await insert({ state: "HELD", release_reason: "EXPIRED" })).toBe(SQLSTATE.check);
  });

  it("rejects an unknown operation and an unknown reason", async () => {
    expect(await insert({ state: "PAYMENT_IN_FLIGHT", in_flight_operation: "refund" })).toBe(SQLSTATE.check);
    expect(await insert({ state: "RELEASED", release_reason: "BORED" })).toBe(SQLSTATE.check);
  });
});
