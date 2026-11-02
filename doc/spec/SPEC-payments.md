# Spec: payments

Module id: `payments` · Depends on: `reservation` (done), `quote-approval` (done), `foundation` (done) · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: **APPROVED on 2 Nov 2026 with the defaults for all eight open questions.** Task list approved; build in progress (see tasks/payments/todo.md). Target window: 7–8 Nov 2026 (brief schedule; the project is ahead of it). The 9 Nov tripwire applies: payment or access tests failing on 9 Nov stops all feature work. Decisions to confirm: **every PayPal operation is begun in one database transaction with the reservation (so nothing is sent if the stock cannot be held), webhooks are hints that trigger a query to PayPal and never drive state themselves, "paid" means a verified capture and nothing else, and one decision record per purchase decides capture or void exactly once.**

## 1. Objective

Turn an accepted quote with held stock into money the merchant has really received, or into a released hold, and never leave anyone unsure which. The customer authorizes payment for the exact quote they accepted. The merchant then confirms the production conditions (capture) or declines (void). Every uncertain outcome is resolved by asking PayPal before anything is retried.

Why: the brief's rules are that code decides state and money, that an order is paid only on verified PayPal evidence, and that a timer or a retry must never act while a PayPal operation may be in flight. `quote-approval` fixed *what* was agreed and its amount. `reservation` holds the stock and owns the in-flight rule. This module is the only one that talks to PayPal about money.

**Users of the module:** the customer (starts payment, approves in PayPal, sees status), the merchant (confirms or declines each authorized order, sees what needs attention), the scheduled reconcile route (settles unknown outcomes and expired authorizations), the PayPal webhook route (hints), and `fulfillment` (reads the fact that a purchase is paid).

### The demo path this module must reproduce (brief steps 5 to 7 and 8)

| Step | Action | Required result |
|---|---|---|
| A | Customer starts payment on the accepted $1,080 quote | Stock held; attempt `CREATED` then `PROVIDER_CREATED`; a PayPal order with intent AUTHORIZE for exactly 108000 cents USD, taken from the accepted snapshot; the approval link returned |
| B | Customer approves in PayPal and returns | Approval is **verified with PayPal** (not trusted from the return URL): `APPROVED`; then authorize: `AUTHORIZED`, authorization id stored, reservation `AWAITING_CONFIRMATION`, a pending merchant decision created |
| C | Merchant confirms the listed conditions and accepts | One decision `accepted`; capture begun; `CAPTURED` only after PayPal confirms a capture of 108000 cents USD linked to this order and authorization; stock committed; the purchase reads as paid |
| D | Merchant declines instead | One decision `declined` with a reason; void begun; `VOIDED` only after PayPal confirms; stock released |
| E | Merchant double-clicks accept, or accept and decline race | Exactly one capture and one outcome; never a capture and a void together |
| F | Capture times out | `OUTCOME_UNKNOWN` (capture); reconciled by asking PayPal before any retry; resolves to `CAPTURED` or back to `AUTHORIZED` |
| G | Authorization comes back for the wrong amount or currency | `EXCEPTION` (financial exception); never marked paid; stock stays held for a person |
| H | A quote is changed after authorization | Old capture blocked; old authorization voided; a new quote, approval and attempt are required; the old authorization is never moved to the new quote |

### Acceptance criteria
- Steps A to H pass as automated tests (against the local fake PayPal, labeled **mocked**), and one real-sandbox run of A to C and A to D on the hosted site is recorded, labeled **real-sandbox**.
- Money is never taken from the browser or a model: the order amount is the accepted snapshot's total.
- No path marks a purchase paid except a PayPal-verified capture whose amount, currency, order and authorization match the local record.
- No PayPal request that could move money is sent unless the attempt and the reservation were moved into flight together, and no retry follows an unknown outcome before PayPal has been queried.
- Duplicate or out-of-order webhooks never cause a second effect or a backwards step.

## 2. Assumptions (correct me now or I proceed)

1. **Intent stays AUTHORIZE.** The tripwire passed in the foundation (real sandbox authorize, capture and void on the hosted site), so there is no fallback to CAPTURE.
2. **One active attempt per purchase** (the existing partial unique index). A new attempt is allowed only after the earlier one is `VOIDED`, `EXPIRED` or `FAILED`, and never while one is `OUTCOME_UNKNOWN`. A purchase whose merchant declined is finished; a revised offer is a new quote and a new purchase.
3. **Attempt states and transitions** are the brief's, with the table in section 3 (an attempt also records which operation is uncertain while `OUTCOME_UNKNOWN`). `EXCEPTION` is final in v1: it means a person must look, and the merchant sees it flagged. There is no in-app resolution of a financial exception.
4. **Each money-moving operation is begun inside one transaction with the reservation.** `payment_begin` moves the attempt into its in-flight state and calls the reservation's `begin_operation` in the same transaction. If the reservation refuses (`HOLD_EXPIRED`, `NOT_HELD`, `OPERATION_IN_FLIGHT`), the whole step rolls back and nothing is sent to PayPal. Settling works the same way (`payment_settle` settles the reservation, so stock is committed or released exactly when the payment fact is recorded).
5. **Stable `PayPal-Request-Id`:** `of-<attempt id>-<operation>` for `create`, `authorize`, `capture` and `void`. A retry after a provably-did-not-happen answer reuses it, so PayPal cannot do the operation twice.
6. **Approval is verified, not trusted.** The customer is redirected to PayPal's `payer-action` link (the way the foundation spike works, `user_action CONTINUE`, `return_url` back to their order room). When they return, the server asks PayPal for the order and only an order reported `APPROVED` moves the attempt to `APPROVED`. The `?token=` on the return URL is only an order id to look up.
7. **Webhooks are hints.** The existing route verifies the signature and stores the event once (unique provider event id). This module adds: find the attempt from the order or authorization id in the event, and **reconcile that attempt by querying PayPal**. The event payload never sets state. Events for unknown ids are stored and ignored. Because the real sandbox delivers webhooks 8 to 25 seconds late and out of order, an event can never move an attempt backwards: reconciliation reads current PayPal state and the guard trigger allows forward moves only.
8. **Reconciliation** runs from the existing scheduled route, **before** the reservation sweep. It handles, in bounded batches with per-attempt error isolation: attempts in flight for 120 seconds or more, `OUTCOME_UNKNOWN`, `CREATED` that never got an order, idle `PROVIDER_CREATED` and `APPROVED` past the hold, and authorizations past their expiry. A run that finishes with errors still fails visibly (as the sweep does).
9. **Resolving an uncertain operation (query first):**

   | Uncertain | PayPal says | Result |
   |---|---|---|
   | authorize | order authorized, authorization id present | `AUTHORIZED` (after the amount check) |
   | authorize | order still `APPROVED`, nothing authorized | back to `APPROVED`; the hold restarts |
   | capture | authorization `CAPTURED`, capture verified | `CAPTURED` |
   | capture | authorization still `CREATED` | back to `AUTHORIZED`; capture may be retried with the same request id |
   | void | authorization `VOIDED` | `VOIDED` |
   | void | authorization `CREATED` | back to `AUTHORIZED` |
   | void | authorization `CAPTURED` (a decline that was captured) | `EXCEPTION` |
   | any | PayPal cannot be reached | stays `OUTCOME_UNKNOWN`; the order stays in a checking state |

10. **Paid means verified.** A capture is accepted only if PayPal reports it `COMPLETED`, its amount and currency equal the attempt's (which equal the accepted snapshot), it belongs to this attempt's order and authorization, and, when `PAYPAL_PAYEE_MERCHANT_ID` is set, it was paid to that merchant (open question 1). Anything else is an `EXCEPTION`.
11. **Merchant decision:** one record per purchase (the existing table, unique by purchase). It is created `pending` when the authorization is recorded. Accepting requires the merchant to confirm every condition on the quote that is only pending (`PRODUCTION_SLOT_CONFIRMATION`, `ARTWORK_ACCEPTANCE`); declining requires a reason. The decision transition (pending to accepted or declined) happens under the decision row's lock in the same transaction that begins capture or void, so a confirm racing a decline has exactly one winner and a capture and a void can never both start.
12. **Before capture,** the service rechecks what the brief lists: the decision is `accepted`, the quote is still `ACCEPTED` with an intact hash (`verifyApprovalBinding`), the attempt's quote hash and amount equal the approval's, the reservation is `AWAITING_CONFIRMATION`, and the authorization is not past its expiry.
13. **Authorization deadlines.** PayPal's `expiration_time` is stored. After 3 days the merchant sees a warning that capture may be less reliable (the brief's honor period); capture is still attempted until PayPal refuses. Past expiry, reconciliation confirms with PayPal and moves the attempt to `EXPIRED` and releases the stock (through review, with evidence). Sandbox authorizations may never expire, so expiry is tested at application level with an injected clock and labeled as such.
14. **Change after authorization:** the merchant voids first (a declined decision whose reason names the change), then publishes the new quote (`quote-approval` already refuses to replace an accepted quote while a payment is under way). The new quote needs a new approval and a new attempt. If the payment was already captured, nothing is automatic: it is a merchant resolution outside the app, and the screen says so.
15. **`fulfillment` pulls.** This module exposes the fact "this purchase is paid" (an attempt `CAPTURED` and its reservation `COMMITTED`) and never calls `fulfillment` (dependencies point one way). `fulfillment` creates its one job per paid purchase and covers anything missed.
16. **Evidence labels** on every stored payment event: `mocked` (local fake PayPal), `replayed`, `real-sandbox`. Mocked and real results are reported separately, as the brief requires.
17. USD only; integer minor units; no float ever touches an amount; the PayPal money string is produced by the existing `toPayPalAmount`.

## 3. Interfaces (the contract other modules build against)

Pure parts in `domain/payments/`; database parts in `services/payments/`; transitions are Postgres RPCs (service role only), each atomic and idempotent.

```ts
type AttemptState = "CREATED" | "PROVIDER_CREATED" | "APPROVED" | "AUTHORIZE_IN_FLIGHT" | "AUTHORIZED" | "CAPTURE_IN_FLIGHT"
  | "CAPTURED" | "VOID_IN_FLIGHT" | "VOIDED" | "EXPIRED" | "FAILED" | "OUTCOME_UNKNOWN" | "EXCEPTION";
type Operation = "create" | "authorize" | "capture" | "void";

// Pure
transition(from, event, context): AttemptState | { error: "ILLEGAL_TRANSITION" }        // the only attempt state machine
requestId(attemptId, operation): string                                                  // "of-<id>-<operation>", stable
verifyAuthorization(attempt, providerAuthorization): { ok } | { exception: Reason }      // amount, currency, status
verifyCapture(attempt, providerOrder, providerCapture, payee?): { ok } | { exception: Reason }
unconfirmedConditions(snapshotConditions, confirmedCodes): ConditionCode[]               // what still blocks an accept
classifyPayPal(result, operation): "DONE" | "DEFINITIVE_FAILURE" | "UNKNOWN" | "NOT_SENT"   // from the client's result kinds

// Services (service role; customer entry points take a VerifiedInquiryId, merchant ones a merchant actor)
startCheckout(verifiedInquiryId, purchaseId, ctx): Result<{ attemptId; approveUrl }>      // reserve, attempt, PayPal order
completeApproval(verifiedInquiryId, orderId, ctx): Result<{ state }>                       // verify with PayPal, then authorize
decide(merchantActor, purchaseId, decision, { confirmedConditions, reason }, ctx): Result<{ decision; state }>   // accept => capture, decline => void
voidForChange(merchantActor, purchaseId, reason, ctx): Result<{ state }>                   // change after authorization
reconcileAttempt(attemptId, ctx): Result<{ state }>                                        // asks PayPal; the only way out of OUTCOME_UNKNOWN
reconcilePayments(ctx): { checked: n; settled: n; stillUnknown: n }                        // scheduled batch, before the sweep
applyWebhookEvent(eventId, ctx): Result<void>                                              // find the attempt, reconcile it
paymentStatusForCustomer(verifiedInquiryId): CustomerPaymentView | null
listDecisionsForMerchant(db, merchantId): DecisionRow[]                                    // pending, checking, exceptions
isPurchasePaid(purchaseId): boolean                                                        // for fulfillment
```

Coded results (stable): `PURCHASE_NOT_FOUND`, `QUOTE_NOT_ACCEPTED` (carries the quote-approval code), `RESERVATION_REFUSED` (carries the reservation code, e.g. `INSUFFICIENT_STOCK`, `HOLD_EXPIRED`), `ATTEMPT_ACTIVE`, `NOT_APPROVED` (PayPal does not show the order approved), `PROVIDER_REFUSED`, `PROVIDER_UNREACHABLE`, `OUTCOME_UNKNOWN` (reconcile before retrying), `FINANCIAL_EXCEPTION` (carries the reason), `DECISION_ALREADY_MADE`, `CONDITIONS_UNCONFIRMED`, `REASON_REQUIRED`, `CAPTURE_BLOCKED` (binding, amount or authorization check failed), `ALREADY_CAPTURED`, `NOT_FOUND`, `INVALID_INPUT`, `ILLEGAL_TRANSITION`.

Attempt transition table (also enforced by a database trigger, as for quotes and reservations):

| From | To | When |
|---|---|---|
| `CREATED` | `PROVIDER_CREATED` | PayPal created the order |
| `CREATED` | `FAILED` / `EXPIRED` | PayPal refused definitively / the hold ran out before an order existed |
| `PROVIDER_CREATED` | `APPROVED` | PayPal reports the order `APPROVED` |
| `PROVIDER_CREATED`, `APPROVED` | `EXPIRED` / `FAILED` | idle past the hold / PayPal says the order is void or expired |
| `APPROVED` | `AUTHORIZE_IN_FLIGHT` | begun together with the reservation |
| `AUTHORIZE_IN_FLIGHT` | `AUTHORIZED` | authorization verified |
| `AUTHORIZE_IN_FLIGHT` | `FAILED` / `OUTCOME_UNKNOWN` / `EXCEPTION` / `APPROVED` | refused / no answer / wrong amount or currency / reconciled as not done |
| `AUTHORIZED` | `CAPTURE_IN_FLIGHT` / `VOID_IN_FLIGHT` | accepted decision / declined decision (or voiding for a change) |
| `AUTHORIZED` | `EXPIRED` / `EXCEPTION` | past expiry per PayPal / a mismatch is found |
| `CAPTURE_IN_FLIGHT` | `CAPTURED` / `AUTHORIZED` / `OUTCOME_UNKNOWN` / `EXCEPTION` | verified capture / refused or reconciled as not done / no answer / wrong amount, currency or linkage |
| `VOID_IN_FLIGHT` | `VOIDED` / `AUTHORIZED` / `OUTCOME_UNKNOWN` / `EXCEPTION` | confirmed void / refused or reconciled as not done / no answer / the authorization was captured |
| `OUTCOME_UNKNOWN` | by the uncertain operation, per assumption 9 | PayPal queried; never retried first |
| `CAPTURED`, `VOIDED`, `EXPIRED`, `FAILED`, `EXCEPTION` | none | terminal |

Rules of the contract:
- **Nothing is sent before it is recorded.** The attempt is moved in flight (with the reservation) and committed before the PayPal request leaves.
- **Nothing is trusted from outside.** An amount comes only from the accepted snapshot; approval and every outcome come from PayPal's own answer; a webhook only says "go and look".
- Customer entry points verify the customer's link; merchant entry points verify the merchant session and that the purchase belongs to them (another merchant's purchase is `NOT_FOUND`).
- `classifyPayPal` maps the client's kinds: `ok` is `DONE`; `provider_error` is a definitive failure for that call; `not_sent` is safe to retry; `timeout` and `malformed` are `UNKNOWN`.

## 4. Database changes (one migration, needs approval with this spec)

`supabase/migrations/0007_payments.sql`. The existing tables hold most of what is needed (`payment_attempts`, `payment_events`, `merchant_decisions`, the unique indexes); the migration adds columns, a guard and transactions:

1. **`payment_attempts` columns:** `approve_url text` (an https PayPal address only), `authorized_at`, `authorization_expires_at`, `state_changed_at`, `failure_code`, `exception_reason`.
2. **Transition guard trigger** enforcing the table above, with `unknown_operation` set exactly while `OUTCOME_UNKNOWN` (already a check) and terminal states immutable.
3. **`payment_events.processed_at`** so a webhook that was stored but not yet acted on is retried on redelivery, while a processed duplicate is acknowledged with no second effect.
4. **RPCs** (security definer, service role only, `p_now` passed in, `jsonb` results): `payment_create_attempt`, `payment_record_order`, `payment_mark_approved`, `payment_begin` (attempt plus reservation `begin_operation`, one transaction), `payment_settle` (attempt plus reservation `settle_operation` plus the pending decision, one transaction), `payment_decide` (the decision under its row lock plus `payment_begin` for capture or void), `payment_resolve_unknown`, and `payment_expire`. Each locks purchase, then attempt, then reservation, so concurrent calls cannot deadlock, and the lock order matches the reservation module's.
5. **No new tables.**

Applying 0007 to the hosted project is a separate step and needs your explicit yes immediately before it happens (with the same read-only before and after checks as 0005 and 0006).

## 5. Tech stack

No new dependencies. TypeScript strict, Zod 4, Vitest, Playwright. The PayPal client in `lib/paypal/` is reused; it gains only what verification needs (reading the order's payee, the capture's linkage and its status), kept as small additions to its typed results. Tests use the existing local fake PayPal and its fault injection (`drop-after`, `hang`, error statuses). One environment variable is proposed: `PAYPAL_PAYEE_MERCHANT_ID`, optional (open question 1).

## 6. Commands

```
Unit tests:      npm run test                    # includes tests/payments/**
DB tests:        npm run test:db                 # attempt transitions, decisions, races, reconcile
E2E:             npm run test:e2e                # payment journey against the local fake PayPal
Typecheck/lint:  npm run typecheck && npm run lint
Migrate local:   supabase migration up           # applies 0007 locally (supabase db reset for a clean check)
Real sandbox:    npm run paypal:spike            # unchanged; the real-sandbox payment run is a documented manual step
```

## 7. Project structure

```
domain/payments/
  types.ts            AttemptState, Operation, results, codes, exception reasons
  state.ts            transition (the only attempt state machine)
  verify.ts           verifyAuthorization, verifyCapture, unconfirmedConditions
  request-id.ts       requestId
  classify.ts         classifyPayPal
  index.ts            public exports
services/payments/
  checkout.ts         startCheckout (reserve, attempt, order), completeApproval (verify, authorize)
  decide.ts           decide, voidForChange (decision, then capture or void)
  settle.ts           the shared "send, classify, settle or mark unknown" step for each operation
  reconcile.ts        reconcileAttempt, reconcilePayments, expiry
  webhook.ts          applyWebhookEvent (find attempt, reconcile)
  read.ts             paymentStatusForCustomer, listDecisionsForMerchant, isPurchasePaid
supabase/migrations/0007_payments.sql
lib/paypal/           small additions: order payee and capture linkage in the typed results
lib/paypal/webhook-handler.ts   after recording an event, calls applyWebhookEvent (injected)
lib/cron/reconcile-handler.ts   gains a reconcilePayments dependency, run before the sweep
app/o/[token]/      "Pay with PayPal", return handling, status line (extends the order room)
app/merchant/decisions/   pending decisions, checking and exceptions; the decision form
tests/payments/       unit; tests/db/payments-*.test.ts; e2e/payments-*.spec.ts
```

`domain/payments` imports only `domain/reservation` and `domain/quote` types, `lib/money`, `zod` and itself (a purity test enforces it, as for the other domains).

## 8. Code style

```ts
// services/payments/settle.ts, style reference: record in flight, send once, classify, settle by evidence
const begun = await db.rpc("payment_begin", { p_attempt_id: attemptId, p_operation: "capture", p_now: ctx.now });
if (!begun.ok) return refuse(begun);                       // nothing is sent when the stock cannot be held or the state is wrong
const sent = await paypal.captureAuthorization(authorizationId, requestId(attemptId, "capture"), amount);
switch (classifyPayPal(sent, "capture")) {
  case "DONE":               return settleVerifiedCapture(attemptId, sent.data);   // PayPal's own answer, then verifyCapture
  case "DEFINITIVE_FAILURE": return settle(attemptId, "CAPTURE_FAILED");
  case "NOT_SENT":           return settle(attemptId, "CAPTURE_FAILED");           // never left: safe to retry
  case "UNKNOWN":            return settle(attemptId, "UNKNOWN");                  // OUTCOME_UNKNOWN: query before any retry
}
```

Conventions: named exports; no `any`; inputs never mutated; every attempt change goes through `transition` and the guard trigger and writes an audit event (`payment_attempt_id`, `purchase_id`, `from`, `to`, `operation`, `amount_minor`, `currency` are allowlisted already); secrets and raw PayPal bodies are never logged or stored (the existing allowlisted summaries only).

## 9. Testing strategy

| Level | What |
|---|---|
| Unit (Vitest) | The attempt transition table (every pair, every operation); `requestId` is stable and distinct per operation; `verifyAuthorization` and `verifyCapture` accept only matching amount, currency, status, order and authorization and name the reason otherwise; `unconfirmedConditions`; `classifyPayPal` over every client result kind; purity |
| Demo path | Steps A to H against the local fake PayPal, exact cents, labeled **mocked** |
| Database | `payment_begin` rolls back when the reservation refuses (nothing in flight, nothing to send); the guard trigger against the TypeScript table; terminal states immutable; the one-active-attempt and unique-id constraints; `payment_decide`: **a confirm racing a decline has one winner**, a repeated accept starts one capture, a capture and a void never both begin; reservation and attempt states stay paired after every transition |
| Fault injection | Capture answer lost after PayPal processed it (`drop-after`): `OUTCOME_UNKNOWN`, reconcile finds `CAPTURED`, no second capture; capture timed out before processing (`drop-before`, `hang`): reconcile finds it not done, retry uses the same request id and captures once; void timeout: stays checking until PayPal confirms; authorize times out; PayPal unreachable during reconcile: stays unknown, no retry |
| Verification | An authorization for the wrong amount or currency is an `EXCEPTION`, not paid, stock held; a capture whose order or authorization does not match is an `EXCEPTION`; a void that finds a captured authorization is an `EXCEPTION` |
| Webhooks | Forged signature rejected (existing); duplicate event acknowledged with no second effect (processed once); an event stored but not processed is retried on redelivery; **out of order** (`AUTHORIZATION.CREATED` after `CAPTURE.COMPLETED`) never moves an attempt backwards; an event for an unknown id is stored and ignored |
| Deadlines | Authorization past its expiry with an injected clock (labeled application-level, not observed in the sandbox): reconcile confirms, `EXPIRED`, stock released with evidence; honor-period warning shows after 3 days |
| Change after authorization | Voiding for a change, then a new quote, approval and attempt; the old authorization is never reused; capture of the old proposal is blocked |
| Access | RLS and server checks: a customer acts only on their own purchase; a merchant decides only their own; another merchant or customer gets `NOT_FOUND` |
| E2E | Customer pays through the fake PayPal (approve, return, authorize); merchant accepts (paid) and, separately, declines (voided); double-click accept captures once; the order room shows each status; exceptions appear in the merchant's list |
| Real sandbox (documented, manual, labeled) | At the checkpoint: one full run on the hosted site, customer pays with a sandbox buyer and the merchant accepts; and one run where the merchant declines. Evidence recorded separately from the mocked results |

Brief test rows owned here: *quote changed after authorization*; *repeated capture click (one capture, one job, with `fulfillment`)*; *capture times out*; *wrong amount or currency*; *forged or duplicate webhook*; *simultaneous merchant confirm and decline*; *timeout during void*. Rows owned elsewhere that depend on this module: *another customer opens the order* (foundation access), *quote changed after acceptance* (`quote-approval`).

## 10. Boundaries

- **Always:** take the amount from the accepted snapshot; begin an operation (with the reservation) before sending it; send a stable `PayPal-Request-Id`; query PayPal after any timeout or unreadable answer before retrying; mark paid only on a verified capture; verify approval with PayPal; keep the decision single and final; record audit events; label every piece of evidence (`mocked`, `replayed`, `real-sandbox`); keep secrets server-side; run the payment and access tests before every commit.
- **Ask first:** adding a dependency or an environment variable; changing the attempt state machine or a state; changing the transition table; adding a table or column beyond 0007; applying 0007 to the hosted database; changing the 120-second reconcile threshold or the 3-day honor warning; switching to intent CAPTURE; making any step retry without querying first.
- **Never:** trust a return URL, a webhook payload or a model statement as proof of payment; take an amount from the browser; transfer an authorization to a changed quote; send a money-moving request without a recorded in-flight state; retry after an unknown outcome before reconciling; release stock while an operation may be in flight; capture and void for the same purchase; store raw PayPal bodies, payer details or secrets; skip or remove a failing payment, approval or access test without approval; call `fulfillment` from this module.

## 11. Success criteria (testable)

- [ ] Demo path A to H passes against the fake PayPal with exact cents, labeled mocked; the real-sandbox runs (pay then accept, pay then decline) are recorded separately and labeled.
- [ ] The attempt transition table is complete in TypeScript and the database trigger rejects every other pair; terminal states cannot change.
- [ ] `payment_begin` is atomic with the reservation: when the reservation refuses, the attempt is unchanged and nothing is sent.
- [ ] Merchant confirm racing decline has exactly one winner; a repeated accept captures once; a capture and a void never both begin (database race tests).
- [ ] A lost capture answer, a timeout before processing, a void timeout and an unreachable PayPal each end correctly after reconciliation, never retry before PayPal has been queried, and never capture twice (fault-injection tests).
- [ ] A wrong amount or currency, a capture with the wrong linkage, and a void that finds a captured authorization are financial exceptions, never marked paid, with stock held.
- [ ] Webhooks: forged rejected, duplicates acknowledged without a second effect, unprocessed events retried, out-of-order events never move an attempt backwards.
- [ ] Expired authorizations are handled (confirmed with PayPal, `EXPIRED`, stock released with evidence), tested at application level with an injected clock and labeled as such; the honor-period warning shows.
- [ ] A change after authorization voids the old authorization, requires a new quote, approval and attempt, and never reuses the authorization.
- [ ] Access tests pass: customers and merchants act only on their own purchases.
- [ ] `domain/payments` passes the purity test; typecheck, lint, unit, database and E2E tests green locally and in CI; payment and access tests are green (the 9 Nov tripwire).
- [ ] The customer can pay and sees each status; the merchant can decide and sees what needs attention (the state machine, the verification and reconciliation are not cuttable; richer status wording is).

## 12. Task outline (becomes `tasks/payments/` after approval)

1. Types, attempt transition table, `requestId`, `classifyPayPal`, verification functions, with tests and the purity test.
2. Migration 0007 locally: columns, guard trigger, `payment_create_attempt`, `payment_record_order`, `payment_mark_approved`, with guard and constraint tests.
3. `payment_begin` and `payment_settle` (attempt, reservation and decision together), with the atomicity and pairing tests.
4. `payment_decide`, `payment_resolve_unknown`, `payment_expire`, with the confirm-versus-decline race and repeated-accept tests.
5. PayPal client additions and the checkout service: `startCheckout`, `completeApproval`, against the fake PayPal (steps A and B, wrong amount).
6. The decision services: `decide`, `voidForChange`, the shared send-classify-settle step (steps C, D, E, H, repeated capture click).
7. Reconciliation: `reconcileAttempt`, `reconcilePayments`, expiry, wired into the reconcile route before the sweep; fault-injection tests (steps F and timeouts).
8. Webhooks: `applyWebhookEvent` and its wiring, `processed_at`, duplicate, forged, out-of-order and unknown-id tests.
9. Customer payment screens and the merchant decisions page, with their E2E tests (status wording cuttable).
10. Checkpoint: criteria review, the real-sandbox runs (with your sandbox buyer), hosted migration (with approval), record.

## 13. Open questions (defaults apply if you just say "approved")

1. **Payee check:** verify captures were paid to our sandbox merchant using an optional `PAYPAL_PAYEE_MERCHANT_ID` (a new environment variable, added to `.env.example` and Vercel). The brief asks for a merchant match; without the variable that check is skipped. Add it?
2. **Reconcile cadence:** treat an operation as stuck after 120 seconds, at most 20 attempts per run. Change?
3. **Approval method:** redirect to PayPal's approval link (as the spike does), not the JS SDK buttons. The SDK is optional and cuttable. Agree?
4. **Financial exceptions are final in v1:** shown to the merchant, resolved outside the app. Agree, or do you want an in-app resolution step?
5. **Change after authorization** goes through a merchant void (a declined decision whose reason names the change), then a new quote. Agree, or should a change void automatically?
6. **Honor period:** warn after 3 days, keep trying to capture until PayPal refuses. Agree?
7. **Migration 0007:** may I write it and apply it to local Supabase on approval? Hosted stays a separate yes.
8. **Real-sandbox runs:** at the checkpoint I will need you to play the buyer in the real sandbox (pay with the US sandbox buyer), once for accept and once for decline. OK?
