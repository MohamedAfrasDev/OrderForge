# Tasks: reservation

Spec: [doc/spec/SPEC-reservation.md](../../doc/spec/SPEC-reservation.md) · Plan: [plan.md](plan.md)
Status: APPROVED 2 Nov 2026; T1 and T2 built (0006 applied to local only), T3 to T7 open. Tick a box only after its Verify step passes. Every task is test first.

## Phase A: pure logic (no database, no network)

- [x] **T1 Types, quantities, transition table, stock invariant, purity**
  - Acceptance: `ReservationState`, `Operation`, `SettleOutcome`, `ReleaseReason` and the result codes exist. `requiredQuantities`
    turns a quote snapshot and a SKU-to-product map into per-product integer quantities (line quantity x box count, summed, so a
    product in two slots counts twice; an unknown SKU throws, as that is a programmer bug). `transition` implements the spec's table:
    every state, event, operation and outcome pair is either the listed target or `ILLEGAL_TRANSITION` (an outcome that does not
    match the recorded operation is illegal; `COMMITTED` is final; `RELEASED` leaves only for an `EXPIRED` re-hold). `stockInvariant`
    reports a seeded discrepancy and passes a consistent state. A purity test limits `domain/reservation` imports to `domain/quote`,
    `zod` and sibling files, and bans clock, environment and `Math.random` reads.
  - Verify: `npm run test -- tests/reservation && npm run typecheck`
  - Files: `domain/reservation/types.ts`, `domain/reservation/quantities.ts`, `domain/reservation/state.ts`, `domain/reservation/invariant.ts`, `domain/reservation/index.ts` (tests under `tests/reservation/`)
  - Depends on: quote-approval.

## Phase B: database

- [x] **T2 Migration 0006: columns, guard trigger, reserve_stock, release_hold**
  - Acceptance: `reservations` gains `in_flight_operation`, `release_reason`, `review_reason`, `state_changed_at` with checks that
    `in_flight_operation` is set exactly while `PAYMENT_IN_FLIGHT` and `release_reason` exactly while `RELEASED`. A guard trigger
    enforces the transition table. `reserve_stock` reserves every product or none, locks stock in product-id order, is idempotent per
    purchase, and re-holds an `EXPIRED` release; `release_hold` releases `HELD` only. Service role only. Tests: demo steps A and B
    (24 bottles, 13 each, one wins and the loser sees needed 13 and available 11 with nothing partial); parallel reservations never
    exceed `on_hand`; opposite-order multi-product reservations do not deadlock; a repeated reserve returns the same reservation;
    release twice changes stock once; every state pair against the TypeScript table; the check constraints; the anon role is denied.
  - Verify: `supabase migration up && npm run test:db -- tests/db/reservation-reserve.test.ts tests/db/reservation-guards.test.ts`
  - Files: `supabase/migrations/0006_reservation.sql`, `tests/db/reservation-reserve.test.ts`, `tests/db/reservation-guards.test.ts`, `tests/db/reservation-helpers.ts`
  - Depends on: T1. Ask first before applying anywhere but local.

- [ ] **T3 begin_operation, settle_operation, resolve_review**
  - Acceptance: `begin_operation` moves `HELD` to `PAYMENT_IN_FLIGHT` (authorize) or `AWAITING_CONFIRMATION` to `PAYMENT_IN_FLIGHT`
    (capture, void), records the operation, and refuses everything else (`NOT_HELD`, `OPERATION_IN_FLIGHT`); on an expired `HELD` it
    releases and returns `HOLD_EXPIRED`. `settle_operation` takes only outcomes that match the recorded operation (`OUTCOME_MISMATCH`
    otherwise) and applies the table including its stock effects: `CAPTURED` lowers `on_hand` and `reserved` once, `VOIDED` lowers
    `reserved` once, `AUTHORIZE_FAILED` restarts the hold. `UNKNOWN` goes to `REVIEW_REQUIRED` with stock held. `resolve_review`
    moves out of `REVIEW_REQUIRED` with evidence and the target's stock effect. Demo steps C to F and H. Five parallel begins give one
    winner; repeated settles change stock once.
  - Verify: `npm run test:db -- tests/db/reservation-operations.test.ts`
  - Files: `supabase/migrations/0006_reservation.sql` (extend), `tests/db/reservation-operations.test.ts`
  - Depends on: T2.

- [ ] **T4 sweep_reservations, check_stock_invariants, reconcile wiring**
  - Acceptance: the sweep releases only `HELD` rows past `expires_at` (conditional update), moves `PAYMENT_IN_FLIGHT` older than the
    in-flight limit to `REVIEW_REQUIRED`, releases a `HELD` reservation whose purchase's quote is no longer `ACCEPTED` (reason
    `SUPERSEDED`) and flags any other state for review, and never touches `AWAITING_CONFIRMATION`, `COMMITTED` or `REVIEW_REQUIRED`
    otherwise. A race of sweep against `begin_operation` has exactly one winner. `check_stock_invariants()` is empty after the full
    demo path and after every test file. `handleReconcile` gains an injected sweep dependency (default no-op) that runs after the
    heartbeat; the existing reconcile tests are unchanged. Demo step G.
  - Verify: `npm run test:db -- tests/db/reservation-sweep.test.ts && npm run test -- tests/cron.test.ts`
  - Files: `supabase/migrations/0006_reservation.sql` (extend), `lib/cron/reconcile-handler.ts`, `app/api/cron/reconcile/route.ts`, `tests/db/reservation-sweep.test.ts`
  - Depends on: T3.

## Phase C: services

- [ ] **T5 Services: reserveForPurchase, operations, release, orphan release**
  - Acceptance: `reserveForPurchase` runs `verifyApprovalBinding` first (a superseded, tampered or unaccepted quote reserves nothing
    and returns `QUOTE_NOT_ACCEPTED` with the underlying code), computes per-product quantities from the snapshot and the merchant's
    SKUs, reads the `reservation_hold_minutes` rule (default 30), calls the RPC, and audits. `beginOperation`, `settleOperation`,
    `resolveReview`, `releaseHold` and `releaseForInvalidatedPurchases` wrap their RPCs with coded results and audit events.
    `sweepReservations` reads the in-flight rule (default 30). A product in two slots reserves double.
  - Verify: `npm run test:db -- tests/db/reservation-services.test.ts`
  - Files: `services/reservation/reserve.ts`, `services/reservation/operations.ts`, `services/reservation/release.ts`, `services/reservation/sweep.ts`, `tests/db/reservation-services.test.ts`
  - Depends on: T4.

## Phase D: screens and review

- [ ] **T6 Customer hold line and merchant holds page (cuttable)**
  - Acceptance: `readHoldForCustomer` returns only the verified inquiry's hold (state and expiry, nothing else); the accepted quote
    card shows "Your items are held until ..." while `HELD`, and a neutral note otherwise; `/merchant/holds` lists the merchant's
    holds and a separate "needs attention" list for `REVIEW_REQUIRED`, read under the merchant's own session; another merchant sees
    nothing; linked from the merchant home.
  - Verify: `npm run test:db -- tests/db/reservation-reads.test.ts && npm run test:e2e -- e2e/reservation-holds.spec.ts`
  - Files: `services/reservation/read.ts`, `components/quote-card.tsx`, `app/merchant/holds/page.tsx`, `tests/db/reservation-reads.test.ts`, `e2e/reservation-holds.spec.ts`
  - Depends on: T5. Cuttable; the state machine, the RPCs and the sweep are not.

- [ ] **T7 Checkpoint**
  - Acceptance: every spec success criterion reviewed against current state with labeled evidence; CI green on the last code commit;
    record in `doc/checkpoints/reservation-checkpoint.md`; statuses updated in `SPEC.md` and this file. Applying 0006 to the hosted
    project only after a fresh explicit yes.
  - Verify: `npm run typecheck && npm run lint && npm run test && npm run test:db && npm run test:e2e`
  - Files: `doc/checkpoints/reservation-checkpoint.md`, `SPEC.md`, `doc/spec/SPEC-reservation.md`, `tasks/reservation/todo.md`
  - Depends on: T5, T6.
