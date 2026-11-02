# Tasks: payments

Spec: [doc/spec/SPEC-payments.md](../../doc/spec/SPEC-payments.md) · Plan: [plan.md](plan.md)
Status: APPROVED 2 Nov 2026; T1 to T4 built (0007 applied to local only), T5 to T10 open. Tick a box only after its Verify step passes. Every task is test first.

## Phase A: pure logic (no database, no network)

- [x] **T1 Types, attempt transition table, request id, classifier, verification, purity**
  - Acceptance: `AttemptState`, `Operation` and the result codes exist. `transition` implements the spec's table: every state,
    event and operation pair is the listed target or `ILLEGAL_TRANSITION`; the terminal states (`CAPTURED`, `VOIDED`, `EXPIRED`,
    `FAILED`, `EXCEPTION`) have no exit; `OUTCOME_UNKNOWN` exits only by the uncertain operation's resolutions. `requestId(attempt,
    operation)` is `of-<id>-<operation>`, stable and distinct per operation. `classifyPayPal` maps the client's result kinds
    (`ok`, `provider_error`, `not_sent`, `timeout`, `malformed`) to `DONE`, `DEFINITIVE_FAILURE`, `NOT_SENT` or `UNKNOWN`.
    `verifyAuthorization` and `verifyCapture` accept only matching status, amount, currency, order and authorization (and payee
    when given) and name the exception reason otherwise. `unconfirmedConditions` returns what still blocks an accept. A purity test
    limits `domain/payments` to `domain/reservation`, `domain/quote`, `lib/money`, `zod` and itself, with no clock, environment or
    `Math.random` reads.
  - Verify: `npm run test -- tests/payments && npm run typecheck`
  - Files: `domain/payments/types.ts`, `domain/payments/state.ts`, `domain/payments/verify.ts`, `domain/payments/classify.ts`, `domain/payments/request-id.ts`, `domain/payments/index.ts` (tests under `tests/payments/`)
  - Depends on: reservation, quote-approval.

## Phase B: database

- [x] **T2 Migration 0007 (part 1): columns, guard trigger, create, record and approve**
  - Acceptance: `payment_attempts` gains `approve_url` (https PayPal address only), `authorized_at`, `authorization_expires_at`,
    `state_changed_at`, `failure_code`, `exception_reason`. A guard trigger enforces the transition table, makes terminal states
    immutable, and keeps the existing `unknown_operation` rule. `payment_create_attempt` is idempotent for the same purchase and
    quote hash and refuses a second active attempt (`ATTEMPT_ACTIVE`); `payment_record_order` moves `CREATED` to `PROVIDER_CREATED`
    and stores the order id and approval link; `payment_mark_approved` moves it to `APPROVED`; `payment_fail` (added here for T5) ends a pre-authorization attempt that PayPal refused. Service role only. Tests: every state
    pair against the TypeScript table; terminal immutability; the unique ids and one-active-attempt constraints; a replayed record is
    a no-op; the anon role is denied.
  - Verify: `supabase migration up && npm run test:db -- tests/db/payments-attempts.test.ts tests/db/payments-guards.test.ts`
  - Files: `supabase/migrations/0007_payments.sql`, `tests/db/payments-attempts.test.ts`, `tests/db/payments-guards.test.ts`, `tests/db/payments-helpers.ts`
  - Depends on: T1. Ask first before applying anywhere but local.

- [x] **T3 `payment_begin` and `payment_settle`: attempt, reservation and decision together**
  - Acceptance: `payment_begin` moves the attempt into its in-flight state and calls the reservation's `begin_operation` in the same
    transaction; if the reservation refuses (`HOLD_EXPIRED`, `NOT_HELD`, `OPERATION_IN_FLIGHT`) nothing changes. Capture needs an
    accepted decision, void a declined one. `payment_settle` records the outcome and settles the reservation in one transaction:
    `AUTHORIZED` stores the authorization id, times and expiry, creates the pending merchant decision and moves the reservation to
    awaiting; `CAPTURED` commits the stock; `VOIDED` releases it (reason `DECLINED` or `VOIDED`); a failure returns to the earlier state; `UNKNOWN`
    sets `OUTCOME_UNKNOWN` with the uncertain operation and sends the reservation to review. A financial mismatch sets `EXCEPTION`.
    After every transition the attempt and reservation states are paired as the spec says (a test asserts it).
  - Verify: `npm run test:db -- tests/db/payments-begin-settle.test.ts`
  - Files: `supabase/migrations/0007_payments.sql` (extend), `tests/db/payments-begin-settle.test.ts`
  - Depends on: T2.

- [x] **T4 `payment_decide`, `payment_resolve_unknown`, `payment_expire`**
  - Acceptance: `payment_decide` moves the decision `pending` to `accepted` or `declined` under the decision row's lock and begins
    capture or void in the same transaction; accepting needs every pending condition confirmed (`CONDITIONS_UNCONFIRMED`), declining
    a reason (`REASON_REQUIRED`); a repeated decision returns the existing one (`DECISION_ALREADY_MADE`) and starts nothing new.
    **Confirm racing decline has exactly one winner; five accepts at once start one capture; a capture and a void never both begin.**
    `payment_resolve_unknown` applies PayPal's evidence per the spec's table (the only way out of `OUTCOME_UNKNOWN`);
    `payment_expire` expires an authorization past its expiry and releases the stock through review with evidence.
  - Verify: `npm run test:db -- tests/db/payments-decide.test.ts tests/db/payments-resolve.test.ts`
  - Files: `supabase/migrations/0007_payments.sql` (extend), `tests/db/payments-decide.test.ts`, `tests/db/payments-resolve.test.ts`
  - Depends on: T3.

## Phase C: services (local fake PayPal, evidence labeled mocked)

- [ ] **T5 Checkout service: `startCheckout` and `completeApproval`**
  - Acceptance: `startCheckout` (verified inquiry only) requires an intact accepted quote, reserves stock through the reservation
    service, creates the attempt and a PayPal order with intent AUTHORIZE for exactly the snapshot's total, USD, with `reference_id`
    set to the attempt id and the `return_url` to the order room, stores the order id and https approval link, and returns the link.
    `completeApproval` asks PayPal for the order and moves to `APPROVED` only when PayPal reports it approved (`NOT_APPROVED`
    otherwise), then begins and sends the authorize with the stable request id, verifies amount and currency, and settles. Demo steps
    A and B; a wrong amount or currency is a financial exception (step G); a refused or unreachable PayPal ends in `FAILED`, `OUTCOME_UNKNOWN` or a safe retry as classified;
    insufficient stock or an expired hold sends nothing. Each PayPal event is stored with the label `mocked`.
  - Verify: `npm run test:db -- tests/db/payments-checkout.test.ts`
  - Files: `services/payments/checkout.ts`, `services/payments/settle.ts`, `lib/paypal/client.ts` (small additions for payee and linkage), `lib/paypal/types.ts`, `tests/db/payments-checkout.test.ts`
  - Depends on: T4.

- [ ] **T6 Decision services: `decide`, `voidForChange` and the capture/void send step**
  - Acceptance: `decide` (merchant actor, own purchases only) runs the pre-capture checks (accepted decision, intact quote binding,
    hash and amount match, reservation awaiting, authorization not expired; `CAPTURE_BLOCKED` otherwise), begins the operation through
    `payment_decide`, sends capture or void with the stable request id, classifies the answer, verifies a capture (status, amount,
    currency, order, authorization, payee when set) and settles. Demo steps C, D, E (a repeated accept captures once; confirm racing decline
    has one winner) and H (`voidForChange` voids, then a new quote, approval and attempt are needed; the old authorization is never reused; a captured
    payment is refused as `ALREADY_CAPTURED` with merchant-resolution guidance). A void on a captured authorization is an `EXCEPTION`.
  - Verify: `npm run test:db -- tests/db/payments-decide-service.test.ts`
  - Files: `services/payments/decide.ts`, `services/payments/settle.ts` (extend), `tests/db/payments-decide-service.test.ts`
  - Depends on: T5.

- [ ] **T7 Reconciliation: `reconcileAttempt`, `reconcilePayments`, expiry, route wiring**
  - Acceptance: `reconcileAttempt` queries PayPal and resolves per the spec's table; it is the only exit from `OUTCOME_UNKNOWN` and never
    retries before asking. `reconcilePayments` handles, in a bounded batch (20) with per-attempt error isolation, attempts in flight
    for 120 seconds or more, unknown outcomes, `CREATED` without an order, idle `PROVIDER_CREATED` and `APPROVED` past the hold, and
    authorizations past expiry; a run with errors still finishes the rest and then fails visibly. `handleReconcile` gains a
    `reconcilePayments` dependency run **before** the reservation sweep. Fault injection: the capture answer lost after PayPal processed it
    (`drop-after`) resolves to `CAPTURED` with no second capture; a capture dropped before processing (`drop-before`, `hang`) resolves to
    not done and the retry reuses the same request id and captures once; a void timeout stays checking until PayPal confirms;
    PayPal unreachable stays unknown. Expiry tested with an injected clock and labeled application-level.
  - Verify: `npm run test:db -- tests/db/payments-reconcile.test.ts && npm run test -- tests/reconcile-sweep.test.ts tests/cron.test.ts`
  - Files: `services/payments/reconcile.ts`, `lib/cron/reconcile-handler.ts`, `app/api/cron/reconcile/route.ts`, `tests/db/payments-reconcile.test.ts`, `tests/payments-reconcile-handler.test.ts`
  - Depends on: T6.

- [ ] **T8 Webhooks: `applyWebhookEvent`**
  - Acceptance: after the existing route verifies and records an event, an injected `applyWebhookEvent` finds the attempt by the
    order or authorization id and reconciles it by querying PayPal; the payload never sets state. `payment_events.processed_at`
    distinguishes a processed duplicate (acknowledged, no second effect) from a stored but unprocessed event (processed on redelivery).
    Forged signatures are still rejected. An out-of-order event (`AUTHORIZATION.CREATED` after `CAPTURE.COMPLETED`) never moves an
    attempt backwards; an event for an unknown id is stored and ignored. A failure to process returns 500 so PayPal retries.
  - Verify: `npm run test:db -- tests/db/payments-webhook.test.ts && npm run test -- tests/webhook.test.ts`
  - Files: `services/payments/webhook.ts`, `lib/paypal/webhook-handler.ts`, `app/api/webhooks/paypal/route.ts`, `supabase/migrations/0007_payments.sql` (extend), `tests/db/payments-webhook.test.ts`
  - Depends on: T7.

## Phase D: screens and review

- [ ] **T9 Customer payment screens and the merchant decisions page**
  - Acceptance: on an accepted quote with a hold the order room shows "Pay with PayPal" (a server action that verifies the customer's
    link and calls `startCheckout`, then sends them to the https approval link); the return handler calls `completeApproval` once
    (idempotent) and shows each status in plain words (authorized and waiting for the merchant, paid, declined and released, could not be completed, checking);
    no code, id or amount is taken from the browser. `/merchant/decisions` lists authorized orders waiting for a decision (with the quote, the
    conditions to confirm, the authorization deadline and the 3-day honor warning), orders being checked, and financial exceptions; the decision
    form confirms each condition, accepts, or declines with a reason; another merchant sees nothing; a double click captures once. Status wording is
    cuttable; the actions and the exception list are not.
  - Verify: `npm run test:db -- tests/db/payments-reads.test.ts && npm run test:e2e -- e2e/payments-customer.spec.ts e2e/payments-merchant.spec.ts`
  - Files: `services/payments/read.ts`, `app/o/[token]/` (actions and return handling), `components/payment-status.tsx`, `app/merchant/decisions/page.tsx`, `e2e/payments-customer.spec.ts`, `e2e/payments-merchant.spec.ts`
  - Depends on: T8.

- [ ] **T10 Checkpoint**
  - Acceptance: every spec success criterion reviewed against current state with labeled evidence (mocked, replayed, real-sandbox, CI);
    CI green on the last code commit; the two real-sandbox runs on the hosted site recorded separately (pay then accept; pay then decline) with
    you as the buyer; record in `doc/checkpoints/payments-checkpoint.md`; statuses updated in `SPEC.md` and this file. Applying 0007 to
    the hosted project, and adding `PAYPAL_PAYEE_MERCHANT_ID` if you supply it, only after a fresh explicit yes.
  - Verify: `npm run typecheck && npm run lint && npm run test && npm run test:db && npm run test:e2e`
  - Files: `doc/checkpoints/payments-checkpoint.md`, `doc/evidence/payments-real-sandbox.md`, `SPEC.md`, `doc/spec/SPEC-payments.md`, `tasks/payments/todo.md`
  - Depends on: T9.
