# Spec: reservation

Module id: `reservation` · Depends on: `foundation` (done), `quote-approval` (done) · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: **APPROVED on 2 Nov 2026 with the defaults for all six open questions.** Task list approved; build in progress (see tasks/reservation/todo.md). Target window: 7–8 Nov 2026 (brief schedule; it can run in parallel with `ai-intake`). Decisions to confirm: **one all-or-nothing reserve call, an explicit "operation in flight" state that only payments can enter and leave, timers that can only release a plain hold, and a stock invariant that a test can check at any time.**

## 1. Objective

Hold exactly the stock a customer has accepted a quote for, so that two customers can never be promised the same last units, and never give that stock back while money may be moving.

Why: the brief's rules are that code decides stock and that a reservation timer must never release stock while a PayPal operation may be in flight. `quote-approval` decided what the customer agreed to. This module decides whether the merchant can still make it, holds the stock for it, and turns the hold into a permanent stock decrease (capture) or a release (decline, void, expiry). It is the module `payments` drives and `fulfillment` waits on.

**Users of the module:** the checkout step (reserves right after a customer accepts a quote), `payments` (begins and settles every PayPal operation through this module's state machine), the scheduled reconcile route (sweeps expired holds), the merchant (a read-only view of holds and the ones needing attention), the customer (sees how long their items are held).

### The demo path this module must reproduce (brief steps 5 to 7)

| Step | Action | Required result |
|---|---|---|
| A | Reserve 30 boxes with the organizer (30 each of five products) | One reservation `HELD`; `stock.reserved` rises by 30 for each product; available falls by 30 |
| B | Two customers reserve the last 24 bottles at the same instant (13 each) | Exactly one succeeds; the other gets `INSUFFICIENT_STOCK` with needed 13 and available 11; nothing partial is left behind |
| C | Payments begins `authorize`, then the hold timer passes | The sweep does **not** release it; it stays `PAYMENT_IN_FLIGHT` |
| D | Authorization settles | `AWAITING_CONFIRMATION`; stock still held; no timer can release it |
| E | Merchant declines: begin `void`, settle `VOIDED` | `RELEASED`; `reserved` falls back; available is what it was before A |
| F | Merchant accepts: begin `capture`, settle `CAPTURED` | `COMMITTED`; `on_hand` and `reserved` each fall by the reserved quantity; available is unchanged and the stock has really left |
| G | A plain hold passes its expiry | The sweep releases it (`EXPIRED`); stock is available again; a re-hold is possible if stock is still there |
| H | An operation outcome is unknown | `REVIEW_REQUIRED`; stock stays held until someone resolves it with evidence |

### Acceptance criteria
- Steps A to H pass as automated tests against real Postgres, with exact quantities.
- Allocation never exceeds stock: under parallel reservations the sum reserved never exceeds `on_hand`, and a failed reservation changes nothing.
- No code path other than a payments settlement releases or commits a reservation that is `PAYMENT_IN_FLIGHT`, `AWAITING_CONFIRMATION` or `REVIEW_REQUIRED`. A timer can release only `HELD`.
- Every stock change happens exactly once per state transition, even when a call is repeated or two callers race.
- The invariant "reserved equals the quantity of live reservations" can be checked by a query, and holds after every test.

## 2. Assumptions (correct me now or I proceed)

1. **Reserve is a separate step after acceptance**, not part of `accept_quote`. The customer accepts (a purchase exists), then checkout calls `reserveForPurchase`. If stock has gone in between, nothing is held, the purchase simply has no reservation, and the customer is told. Reserving again later is allowed and safe (idempotent). Making accept and reserve one transaction would force `quote-approval` to know about stock, and dependencies point one way.
2. **What is reserved** is derived from the accepted snapshot: for each product, the quote's line quantity times the box count, summed per product (a product in two slots counts twice). SKUs are mapped to products for that merchant. `verifyApprovalBinding` must pass first, so a superseded or tampered quote reserves nothing.
3. **All or nothing.** One call reserves every product or none. Stock rows are locked in product-id order, so two overlapping reservations cannot deadlock.
4. **Hold window:** a `HELD` reservation expires at `now + reservation_hold_minutes`, a merchant rule (default **30**). The window exists to give a customer time to approve in PayPal. It applies to `HELD` only.
5. **Stock accounting.** Reserve: `reserved += q`. Release: `reserved -= q`. Commit: `on_hand -= q` and `reserved -= q` in one statement. The existing `reserved <= on_hand` check stays as a database backstop.
6. **The in-flight rule is structural, not a timer comparison.** Before payments sends anything to PayPal that could move money (`authorize`, `capture`, `void`), it must call `begin_operation`, which moves the reservation into `PAYMENT_IN_FLIGHT` and records which operation. If that call is refused, payments must not contact PayPal. Only a settlement call can leave `PAYMENT_IN_FLIGHT`, and the settlement must name an outcome that fits the recorded operation.
7. **Stale in-flight work goes to a person.** A reservation `PAYMENT_IN_FLIGHT` for longer than `inflight_review_minutes` (rule, default **30**) is moved to `REVIEW_REQUIRED` by the sweep. Its stock stays held. This module cannot ask PayPal anything; reconciliation belongs to `payments`, which runs first in the same scheduled job.
8. **Re-hold after expiry.** A reservation released because its hold *expired* may be taken up again (`RELEASED → HELD`) by `reserveForPurchase`, if the purchase has no active payment attempt and stock is still sufficient. Every other release (declined, voided, superseded, abandoned) is final. This is the one change to the brief's reservation states and is why this spec needs your approval (open question 2).
9. **A superseded quote releases its hold.** A reservation whose purchase's quote is no longer `ACCEPTED` and which is `HELD` is released (`SUPERSEDED`). `quote-approval` reports invalidated purchase ids when it supersedes an accepted quote; the publish action calls `releaseForInvalidatedPurchases`, and the sweep also finds any it missed. If such a reservation is in any other state it goes to `REVIEW_REQUIRED` instead, because money may be involved.
10. **Time is passed in.** Every function takes `now`; nothing in `domain/` or in an RPC reads the clock for a decision.
11. One merchant per call; USD and PayPal details never appear in this module. It stores no amounts, only quantities.

## 3. Interfaces (the contract other modules build against)

Pure parts in `domain/reservation/`; database parts in `services/reservation/`; transitions are Postgres RPCs (service role only), each atomic and idempotent.

```ts
type ReservationState =
  "HELD" | "PAYMENT_IN_FLIGHT" | "AWAITING_CONFIRMATION" | "COMMITTED" | "RELEASED" | "REVIEW_REQUIRED";
type Operation = "authorize" | "capture" | "void";
type SettleOutcome =
  "AUTHORIZED" | "AUTHORIZE_FAILED" | "CAPTURED" | "CAPTURE_FAILED" | "VOIDED" | "VOID_FAILED" | "UNKNOWN";
type ReleaseReason = "EXPIRED" | "SUPERSEDED" | "ABANDONED" | "DECLINED" | "VOIDED";

// Pure
requiredQuantities(snapshot: QuoteSnapshot, skuToProductId): Array<{ productId; quantity }>   // summed per product, integers
transition(from, event, context): ReservationState | { error: "ILLEGAL_TRANSITION" }          // the only state machine
stockInvariant(stockRows, liveReservationLines): Discrepancy[]                                  // empty means consistent

// Services
reserveForPurchase(purchaseId, ctx): Result<{ reservationId; expiresAt; reheld: boolean }>   // idempotent; all or nothing
beginOperation(reservationId, operation, ctx): Result<void>                // call BEFORE any PayPal request
settleOperation(reservationId, outcome, ctx): Result<{ state }>            // after definitive evidence only
releaseHold(reservationId, reason, ctx): Result<void>                       // HELD only
releaseForInvalidatedPurchases(purchaseIds, ctx): Result<{ released; flagged }>
sweepReservations(ctx): { released: n; flaggedForReview: n; orphansReleased: n }
resolveReview(reservationId, target, evidence, actor, ctx): Result<{ state }>   // REVIEW_REQUIRED -> HELD | AWAITING_CONFIRMATION | COMMITTED | RELEASED
readHoldForCustomer(verifiedInquiryId, now): { state; expiresAt } | null
listHoldsForMerchant(db, merchantId): HoldRow[]                                  // read-only
```

Coded results (stable; other modules match on them): `INSUFFICIENT_STOCK` (carries `[{ productId, needed, available }]`), `NOT_FOUND`, `QUOTE_NOT_ACCEPTED` (binding refused; carries the quote-approval code), `HOLD_EXPIRED`, `NOT_HELD`, `OPERATION_IN_FLIGHT`, `NO_OPERATION_IN_FLIGHT`, `OUTCOME_MISMATCH`, `ILLEGAL_TRANSITION`, `PAYMENT_ACTIVE`, `INVALID_INPUT`.

Transition table (also enforced by a database trigger, as for quotes):

| From | Event | To | Stock effect |
|---|---|---|---|
| (none) | reserve | `HELD` | `reserved += q` |
| `HELD` | begin `authorize` | `PAYMENT_IN_FLIGHT` | none |
| `HELD` | release (expired, superseded, abandoned) | `RELEASED` | `reserved -= q` |
| `RELEASED` (reason `EXPIRED`) | re-hold | `HELD` | `reserved += q` |
| `PAYMENT_IN_FLIGHT` (authorize) | `AUTHORIZED` | `AWAITING_CONFIRMATION` | none |
| `PAYMENT_IN_FLIGHT` (authorize) | `AUTHORIZE_FAILED` | `HELD` (hold restarted) | none |
| `AWAITING_CONFIRMATION` | begin `capture` or `void` | `PAYMENT_IN_FLIGHT` | none |
| `PAYMENT_IN_FLIGHT` (capture) | `CAPTURED` | `COMMITTED` | `on_hand -= q`, `reserved -= q` |
| `PAYMENT_IN_FLIGHT` (capture or void) | `CAPTURE_FAILED` or `VOID_FAILED` | `AWAITING_CONFIRMATION` | none |
| `PAYMENT_IN_FLIGHT` (void) | `VOIDED` | `RELEASED` (reason `VOIDED` or `DECLINED`) | `reserved -= q` |
| `PAYMENT_IN_FLIGHT`, `AWAITING_CONFIRMATION` | `UNKNOWN` or stale sweep | `REVIEW_REQUIRED` | none |
| `REVIEW_REQUIRED` | resolve with evidence | `HELD`, `AWAITING_CONFIRMATION`, `COMMITTED` or `RELEASED` | as the target |
| `COMMITTED` | any | refused | |

Rules of the contract:
- **Exactly-once stock effects.** Each stock change is attached to one transition and runs under the reservation's row lock. Repeating a call for the state already reached returns the same result and changes nothing.
- **Reserve is idempotent per purchase** (`reservations.purchase_id` is unique). A second call returns the existing reservation; a call for a purchase whose reservation was released by expiry re-holds it (assumption 8).
- `settleOperation` with an outcome that does not match the recorded operation is refused (`OUTCOME_MISMATCH`), so a `CAPTURED` can never settle a `void`.
- `beginOperation('authorize')` on a `HELD` reservation whose expiry has passed releases it in the same call and returns `HOLD_EXPIRED`, so payments never authorize against stock that may already be gone.
- `sweepReservations` releases only `HELD` rows past `expires_at` (with a conditional update, so a race with `beginOperation` has exactly one winner), flips stale `PAYMENT_IN_FLIGHT` to `REVIEW_REQUIRED`, and handles orphans (assumption 9). It never touches `AWAITING_CONFIRMATION`, `COMMITTED` or `REVIEW_REQUIRED`.

## 4. Database changes (one migration, needs approval with this spec)

`supabase/migrations/0006_reservation.sql`. Existing tables hold most of what is needed; the migration adds columns, guards and the RPCs:

1. **`reservations` columns:** `in_flight_operation text` (`authorize`, `capture`, `void`; a check makes it set exactly while the state is `PAYMENT_IN_FLIGHT`, like `payment_attempts.unknown_operation`), `release_reason text` (the five reasons; set exactly while `RELEASED`), `review_reason text`, and `state_changed_at timestamptz` (used by the stale-in-flight rule).
2. **Transition guard trigger** enforcing the table above, including "`COMMITTED` is final" and "`RELEASED` leaves only for an `EXPIRED` re-hold".
3. **RPCs** (security definer, service role only, `p_now` passed in, results as `jsonb` `{ok, code, ...}`): `reserve_stock`, `begin_operation`, `settle_operation`, `release_hold`, `sweep_reservations`, `resolve_review`, plus `check_stock_invariants()` for tests and for the reconcile heartbeat. Every one locks the reservation row first, then stock rows in product-id order.
4. **A partial unique index is not needed:** `reservations.purchase_id` is already unique.

Applying 0006 to the hosted project is a separate step and needs your explicit yes immediately before it happens.

## 5. Tech stack

No new dependencies. TypeScript strict, Zod 4 for strict inputs, Vitest, Supabase RPC. The scheduled sweep rides the existing `pg_cron` → `/api/cron/reconcile` route; no new scheduler.

## 6. Commands

```
Unit tests:      npm run test                    # includes tests/reservation/**
DB tests:        npm run test:db                 # RPCs, races, invariants, guards, RLS
Typecheck/lint:  npm run typecheck && npm run lint
Migrate local:   supabase migration up           # applies 0006 locally (supabase db reset for a clean check)
E2E:             npm run test:e2e                # includes the hold journey
```

## 7. Project structure

```
domain/reservation/
  types.ts            ReservationState, Operation, SettleOutcome, ReleaseReason, codes
  quantities.ts       requiredQuantities (summed per product, integer only)
  state.ts            transition (the only reservation state machine)
  invariant.ts        stockInvariant
  index.ts            public exports
services/reservation/
  reserve.ts          reserveForPurchase (binding check, quantities, RPC, audit)
  operations.ts       beginOperation, settleOperation, resolveReview
  release.ts          releaseHold, releaseForInvalidatedPurchases
  sweep.ts            sweepReservations (and its wiring into the reconcile handler)
  read.ts             readHoldForCustomer, listHoldsForMerchant
supabase/migrations/0006_reservation.sql
lib/cron/reconcile-handler.ts   gains a `sweepReservations` dependency (runs after payments' reconcile once that exists)
app/merchant/holds/             read-only list of holds and the ones needing attention (cuttable)
components/quote-card.tsx       shows "your items are held until ..." on an accepted quote (cuttable)
tests/reservation/    unit; tests/db/reservation-*.test.ts
```

`domain/reservation` imports only `domain/quote` types, `lib/money`-free integer logic and `zod` (a purity test enforces it, as for the other domains).

## 8. Code style

```ts
// domain/reservation/state.ts, style reference: one table, coded errors, no thrown business outcomes
export function transition(from: ReservationState, event: ReservationEvent): ReservationState | { error: "ILLEGAL_TRANSITION" } {
  const next = TABLE[from]?.[event.type];
  return typeof next === "function" ? (next(event) ?? { error: "ILLEGAL_TRANSITION" }) : (next ?? { error: "ILLEGAL_TRANSITION" });
}
```

Conventions: named exports; no `any`; inputs never mutated; integers only; `now` passed in; every state change goes through `transition` (in TypeScript) and the guard trigger (in the database) and writes an audit event (`reservation_id`, `state`, `from`, `to`, `reason`, `purchase_id` are allowlisted or added deliberately).

## 9. Testing strategy

| Level | What |
|---|---|
| Unit (Vitest) | `requiredQuantities` (a product in two slots counts twice; box count multiplies; integers only); the full transition table, every legal and illegal pair with every operation and outcome; `stockInvariant` finds a seeded discrepancy and passes a consistent state; purity |
| Demo path | Steps A to H with exact quantities against real Postgres |
| Concurrency (database) | Many parallel reservations for the last units: sum reserved never exceeds `on_hand`, successes equal what fits, failures leave no trace; two multi-product reservations with opposite product order never deadlock; five parallel `begin_operation` on one reservation yield one winner; sweep racing `begin_operation` has one winner and never releases an in-flight hold; repeated `settle` and repeated `release` change stock once |
| Invariant | After every database test file, `check_stock_invariants()` returns no discrepancy (reserved equals the quantity on live reservations; `on_hand` fell only by committed quantities) |
| Guards | The trigger rejects every pair outside the table (checked against the TypeScript table), `COMMITTED` edits, `RELEASED` leaving except an expired re-hold, a missing or extra `in_flight_operation` |
| Access | RLS: a merchant reads only their own reservations; the customer view returns only the verified inquiry's hold and no ids or quantities of other data |
| E2E | Customer accepts a quote and sees the hold with its expiry; the merchant holds page lists it; a reservation needing attention is shown |

Brief test rows owned here: *concurrent reservations for the last units (allocation never exceeds stock)*; the invariant *a reservation timer never releases stock while a PayPal operation may be in flight* (tested as: sweep never moves or releases `PAYMENT_IN_FLIGHT`, `AWAITING_CONFIRMATION` or `REVIEW_REQUIRED`). Rows that need a real PayPal operation (*repeated capture click*, *capture times out*, *timeout during void*, *simultaneous confirm and decline*) belong to `payments`, which will call this module's `beginOperation` and `settleOperation`; this module proves the state machine they depend on.

## 10. Boundaries

- **Always:** reserve all or nothing; lock stock rows in product-id order; attach each stock change to exactly one transition under the reservation's row lock; require `verifyApprovalBinding` before reserving; call `beginOperation` before any PayPal request (payments' duty, enforced by the state machine); pass `now`; write an audit event per transition; keep `domain/` pure; run the unit tests before committing; keep result codes stable.
- **Ask first:** adding a dependency; changing a state, the transition table or a release reason; changing the stock accounting; changing the hold or in-flight defaults; adding a table or column beyond 0006; applying 0006 to the hosted database; letting any timer touch a state other than `HELD`.
- **Never:** release or commit a reservation that is in flight other than through a settlement; let a timer release `AWAITING_CONFIRMATION` or `REVIEW_REQUIRED`; reserve from a quote that is not `ACCEPTED` with an intact hash; change stock from application code outside the RPCs; take a quantity from a customer, a model or a browser; call PayPal from this module; skip or remove a failing concurrency or invariant test without approval.

## 11. Success criteria (testable)

- [ ] Demo path A to H passes with exact quantities on real Postgres.
- [ ] Parallel reservations for the last units never over-allocate; a failed reservation changes nothing; opposite-order multi-product reservations do not deadlock.
- [ ] The transition table is complete in TypeScript and the database trigger rejects every other pair, including `COMMITTED` changes and any `RELEASED` exit except an expired re-hold.
- [ ] A sweep never changes `PAYMENT_IN_FLIGHT`, `AWAITING_CONFIRMATION` or `REVIEW_REQUIRED` except stale in-flight to `REVIEW_REQUIRED`, and never releases stock for them; it races safely with `beginOperation`.
- [ ] Repeated or concurrent `reserve`, `settle`, `release` and `resolve` change stock exactly once.
- [ ] `reserveForPurchase` refuses a quote that is superseded, tampered or not accepted, and reserves the per-product sum from the snapshot (a product in two slots counts twice).
- [ ] `check_stock_invariants()` is empty after every database test file and after the full demo path.
- [ ] A superseded quote's `HELD` reservation is released; one in any other state goes to review.
- [ ] RLS and customer-view tests pass: merchants read only their own holds; customers see only their own hold.
- [ ] `domain/reservation` passes the purity test; typecheck, lint, unit, database and E2E tests green locally and in CI.
- [ ] The customer sees the hold and its expiry on an accepted quote, and the merchant holds page works (both cuttable; the state machine, the RPCs and the sweep are not).

## 12. Task outline (becomes `tasks/reservation/` after approval)

1. Types, `requiredQuantities`, `transition`, `stockInvariant`, with tests and the purity test.
2. Migration 0006 locally: columns, guard trigger, `reserve_stock`, `release_hold`, with the concurrency, deadlock and guard tests.
3. `begin_operation`, `settle_operation`, `resolve_review`, with the operation and outcome tests.
4. `sweep_reservations` and `check_stock_invariants`, with the timer-versus-in-flight race tests; wire the sweep into the reconcile handler.
5. Services: `reserveForPurchase` (binding, quantities, audit), operations, release, `releaseForInvalidatedPurchases`.
6. Customer hold line and merchant holds page, with their E2E tests (cuttable).
7. Checkpoint: criteria review, hosted migration (with approval), record.

## 13. Open questions (defaults apply if you just say "approved")

1. **Hold window:** 30 minutes (`reservation_hold_minutes`). Change it?
2. **Re-hold after expiry:** allow `RELEASED → HELD` only when the release reason was `EXPIRED`, otherwise a customer who is slow in PayPal is stuck with an accepted quote and no hold. This is a change to the brief's state list. Agree, or make every release final and require a new quote?
3. **Stale in-flight:** move to `REVIEW_REQUIRED` after 30 minutes (`inflight_review_minutes`), stock stays held. Change it?
4. **Reserve after accept, not inside it:** a failed reserve leaves the purchase without a reservation and the customer is told; they can retry or the merchant issues a new quote. Agree, or do you want accept and reserve fused (that would put stock knowledge into `quote-approval`)?
5. **Migration 0006:** may I write it and apply it to local Supabase on approval? Hosted stays a separate yes.
6. **UI scope:** customer hold line plus a read-only merchant holds page, both cuttable. Keep both?
