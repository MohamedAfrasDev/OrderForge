# Checkpoint: payments review

Date: 3 Nov 2026 · Module: `payments` · Reviewed against: [doc/spec/SPEC-payments.md](../spec/SPEC-payments.md) §11
· Code reviewed: branch `spec-4-payment` at `74117f4` (T1 to T9), plus this record.

Evidence is labeled **mocked** (the local fake PayPal), **local** (Docker Supabase on this machine), **real-sandbox** (the real PayPal
sandbox), **hosted** (the real Supabase project) or **CI** (GitHub Actions). Everything below was run on 3 Nov against current state
unless a row says otherwise. Nothing in this module has been run against real PayPal yet, and the branch has not been pushed, so there
is no CI result.

## Verdict

**10 of 12 criteria met locally with mocked evidence. 2 are open and need you:** criterion 1 (the two real-sandbox runs) and the CI
half of criterion 11 (the branch is not pushed). Migration 0007 is applied to the local database only; the hosted project is untouched
(see Hosted migration). The module is **not** ready for `fulfillment` to rely on until the real-sandbox runs are recorded.

Local gates on `74117f4`: typecheck 0 errors, lint 0 problems, 698 unit, 1031 database, 70 E2E, production build ok.

## Criteria

| # | Criterion (spec §11) | Verdict | Evidence |
|---|---|---|---|
| 1 | Demo path A to H passes against the fake PayPal with exact cents; the real-sandbox runs (pay then accept, pay then decline) are recorded separately | **Half met** | Mocked, met: A and B `payments-checkout` (order for 108000 cents USD from the snapshot, a later price change changes nothing, approval verified with PayPal, authorize sent once even with five simultaneous returns). C and D `payments-decide-service` (capture of exactly 1080.00 verified against PayPal's order record before CAPTURED, stock committed; decline voids and releases). E repeated accept captures once, five simultaneous accepts send one capture, accept racing decline sends one of capture or void. F `payments-reconcile` (capture answer lost resolves to CAPTURED with no second capture). G wrong amount, wrong currency and wrong status on authorize and capture are exceptions. H a superseded quote blocks capture, `voidForChange` voids and refuses once captured. **Real-sandbox: not run.** Needs you as the buyer, see Open items. mocked + local |
| 2 | Transition table complete in TypeScript; the database trigger rejects every other pair; terminal states cannot change | Met | `tests/payments/state.test.ts` (every state, event and operation pair against a separately written table); `payments-guards` (15 tests) drives the trigger across the pairs and the immutable evidence columns. mocked-free: pure + local |
| 3 | `payment_begin` is atomic with the reservation: when the reservation refuses, the attempt is unchanged and nothing is sent | Met | `payments-begin-settle` (42 tests): a refused begin leaves the attempt and reservation as they were, `HOLD_EXPIRED` ends the attempt; `payments-checkout` shows nothing reaches the fake PayPal on a refused begin (expired hold, insufficient stock). local + mocked |
| 4 | Confirm racing decline has exactly one winner; a repeated accept captures once; a capture and a void never both begin | Met | `payments-decide` (database races, 22 tests) and `payments-decide-service` (service level, counted at the fake PayPal: one request per attempt and operation). local + mocked |
| 5 | A lost capture answer, a timeout before processing, a void timeout and an unreachable PayPal each end correctly after reconciliation, never retry before PayPal is queried, never capture twice | Met | `payments-reconcile` (20 tests): `drop-after` resolves to CAPTURED with one capture request; `drop-before` and `hang` resolve to not done and the retry reuses the same request id and captures once (two requests, one capture at the fake); a void timeout stays in doubt while PayPal is unreachable (no request leaves) and resolves once it answers; stuck in-flight work is picked up only after 120 seconds; one failing attempt does not stop the rest and the run then fails. mocked + local |
| 6 | Wrong amount or currency, a capture with the wrong linkage, and a void that finds a captured authorization are financial exceptions, never paid, stock held | Met | Authorize: wrong amount, EUR, status not CREATED (`payments-checkout`). Capture: wrong amount, not COMPLETED, wrong payee (`PAYEE_MISMATCH` when `PAYPAL_PAYEE_MERCHANT_ID` is configured), linkage checked against PayPal's order record (`payments-decide-service`, `tests/payments/verify.test.ts`). Void of a captured authorization is HTTP 422 `PREVIOUSLY_CAPTURED` (as seen on the real sandbox in foundation) and becomes an exception. In every case the stock stays held in review. mocked + local |
| 7 | Webhooks: forged rejected, duplicates acknowledged without a second effect, unprocessed events retried, out-of-order events never move an attempt backwards | Met | `payments-webhook` (11 tests): a delivery PayPal does not vouch for gets 400 and is stored nowhere; a processed duplicate gets 200 with no PayPal request; a failed processing answers 500, leaves `processed_at` empty, and the redelivery processes it; five simultaneous deliveries make one row and one effect; a forged `CAPTURE.COMPLETED` for money PayPal did not capture changes nothing; `AUTHORIZATION.CREATED` after the capture leaves it CAPTURED; an operation started under 120 seconds ago is left to its sender. mocked + replayed + local |
| 8 | Expired authorizations are handled and the honor-period warning shows | Met (application level) | `payments-reconcile` with an injected clock: before expiry nothing happens; after expiry PayPal is asked, the attempt becomes EXPIRED, the reservation is released as EXPIRED and stock returns to 100 available. The 3-day warning is in `payments-reads` and shown on the decisions page. **Labeled application-level: the sandbox was not observed to expire an authorization.** local |
| 9 | A change after authorization voids the old authorization, requires a new quote, approval and attempt, and never reuses the authorization | Met | `payments-decide-service`: the superseded quote blocks capture (`CAPTURE_BLOCKED`, nothing sent, decision stays pending), `voidForChange` voids and releases with reason VOIDED, and a new checkout on the old purchase is refused as `QUOTE_NOT_ACCEPTED`. local + mocked |
| 10 | Access tests pass: customers and merchants act only on their own purchases | Met | Customer: `PURCHASE_NOT_FOUND` for another customer's purchase, `NOT_FOUND` for another customer's order id, no state change (`payments-checkout`, `payments-customer` E2E). Merchant: another merchant's purchase is `NOT_FOUND` for `decide` and `voidForChange`; the decisions page and `listDecisionsForMerchant` show only their own; the page redirects visitors to login (`payments-decide-service`, `payments-reads`, `payments-merchant` E2E). local |
| 11 | `domain/payments` passes the purity test; typecheck, lint, unit, database and E2E green locally and in CI | **Local met, CI open** | Local: figures above. `tests/payments/purity.test.ts` limits `domain/payments` imports to `domain/reservation`, `domain/quote`, `lib/money`, `zod` and itself, and bans clock, environment and `Math.random` reads. **CI: not run, the branch is not pushed.** |
| 12 | The customer can pay and sees each status; the merchant can decide and sees what needs attention | Met, one gap | E2E (`payments-customer` 5, `payments-merchant` 5): pay, redirect to the approval link, return, "authorized, waiting for the merchant"; a second return is harmless; return before approving says so; another customer's order id gets the general message; the merchant must confirm the listed condition, accepts with a double click and one capture results; declines with a reason and the customer is told; isolation between merchants. **Gap: no E2E test shows a financial exception in the merchant's list**, because the fake PayPal cannot be steered from the test process. The ordering (exceptions first) is covered in `payments-reads`. mocked + local |

Counts: payments unit tests 120 (`tests/payments`, `tests/payments-reconcile-handler.test.ts`), payments database tests 215
(`tests/db/payments-*`), payments E2E tests 10.

## Hosted migration

**Not applied.** Migration `0007_payments.sql` exists only in this branch and in the local database. Applying it to the hosted project
needs a fresh explicit yes immediately before, with the same read-only checks before and after as 0005 and 0006. The hosted project
also does not yet have the code: the branch is unpushed, so the hosted reconcile route and webhook route still run the older code.
Order matters when it happens: apply 0007, then merge and deploy (the new webhook route needs the `processed_at` column).

## Findings from this review

1. **Webhook processing could race the sender.** A webhook arriving while we are sending a capture is normal on the real sandbox, and
   reconciling it at that moment would have moved the attempt to doubt under the sender's feet. Events for an operation started under
   120 seconds ago are therefore marked processed without acting; the scheduled reconcile catches anything that really hangs.
2. **`proxy.ts` treated everything after `/o/` as the link**, so `/o/<link>/return` was a 404. It now checks only the first path segment.
3. **A lost capture or void needs a way to finish.** Reconciliation settles "not done" back to AUTHORIZED with the decision already
   recorded; `resumeDecision` (called by the scheduled run) begins and sends it again with the same request id. Not in the spec's
   interface list; no state or transition changed.
4. **Changes beyond the spec text, none changing a state or the transition table:** `PayPalPort` and `PaymentDeps` (the PayPal
   client plus evidence label plus optional payee) are the injection points; the PayPal client returns the authorization's currency as
   PayPal gave it, so a non-USD authorization is an exception instead of a malformed answer; the order's payee merchant id is read;
   `reconcilePayments` takes an optional `attemptIds` list (used by tests, also usable for a targeted run); the webhook handler has an
   optional `apply` step; `PAYPAL_PAYEE_MERCHANT_ID` is an optional environment variable (approved with the spec defaults), documented
   in `.env.example`, unset by default; the customer return handler is a route (`/o/<link>/return`) rather than a page.
5. **Not covered by any test:** the real PayPal approval page (a person is needed), real webhook delivery timing, and the browser
   redirect to the approval link beyond checking its address.
6. **Local data:** `npm run seed` was not re-run after the database runs because `.env` points at the hosted project and the seed
   refuses a remote target. Local tests do not need the seed.

## Open items (need you)

1. **Push and open the PR** so CI can run (criterion 11). Not done: you have not asked for it yet.
2. **Hosted migration 0007**, then deploy, then the two **real-sandbox runs on the hosted site with you as the buyer**: pay then
   accept, and pay then decline. Record them in [doc/evidence/payments-real-sandbox.md](../evidence/payments-real-sandbox.md),
   labeled real-sandbox, separate from everything above.
3. **`PAYPAL_PAYEE_MERCHANT_ID`**: if you give me the sandbox merchant id, it is set on Vercel too, so captures are checked against it.
   Without it that check is skipped.
