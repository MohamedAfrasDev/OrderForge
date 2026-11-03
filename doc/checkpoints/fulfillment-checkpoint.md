# Checkpoint: fulfillment review

Date: 3 Nov 2026 · Module: `fulfillment` · Reviewed against: [doc/spec/SPEC-fulfillment.md](../spec/SPEC-fulfillment.md) §11
· Code reviewed: branch `spec-5-fulfillment` (T1 to T6), PR 6.

Evidence is labeled **mocked** (the local fake PayPal, used only to produce paid purchases), **local** (Docker Supabase on this
machine), **real-sandbox** (the real PayPal sandbox through the hosted site), **hosted** (the real Supabase project) or **CI**
(GitHub Actions). Everything below was run on 3 Nov against current state unless a row says otherwise. This module sends nothing to
PayPal itself.

## Verdict

**10 of 10 criteria met.** The hosted check (criterion 1's hosted half) was done on 3 Nov: the scheduled run made the two jobs and the merchant moved them on the live site (details in the evidence file).
Migration 0008 is applied to the local database and, since 3 Nov, to the hosted project (see Hosted migration). The module is not
ready to rely on in the hosted demo until PR 6 is merged and deployed.

Local gates on the reviewed code: typecheck 0 errors, lint 0 problems, 786 unit, 1111 database, 80 end-to-end tests.

## Criteria

| # | Criterion (spec §11) | Verdict | Evidence |
|---|---|---|---|
| 1 | Demo path A to H passes with exact quantities; the hosted check is recorded separately | Met | Local + mocked, met: A `fulfillment-create`, `fulfillment-services` (one QUEUED job, the worksheet with 30 of each product, the quote hash, the confirmed conditions, ready-by, and one first event). B ten parallel creations, a repeat, and the accept action's call racing a reconcile run each give one job, one event and one audit row (`fulfillment-create`, `fulfillment-services`, `fulfillment-reconcile`). C authorized-only, declined and not-accepted purchases get `NOT_PAID`. D a catalog rename and price change after payment leaves the worksheet unchanged. E the full path to collected with one event each, and a double click moves once (`fulfillment-move`, E2E). F a hold needs a note and a resume returns to the status it left, including a second hold (`fulfillment-move`, E2E). G the customer sees the plain status and the ready-by day and nothing else (`fulfillment-reads`, E2E). H a capture settled out of doubt gets its job from the next reconcile run, once (`fulfillment-reconcile`). **Hosted, met on 3 Nov** ([doc/evidence/fulfillment-real-sandbox.md](../evidence/fulfillment-real-sandbox.md), labeled hosted): the scheduled reconcile run made the two jobs for the two paid orders; the merchant then moved one to COLLECTED (four events) and the other to PREPARING on the live site, each move audited. The customer's on-screen view was not seen by me; it is covered by the E2E tests. |
| 2 | One job per paid purchase: parallel and repeated creations, a creation racing the reconcile run, and a repeated accept give one job and one first event | Met | Ten parallel database calls and ten parallel service calls give one job and one event; a unique constraint on `purchase_id` backs it (`fulfillment-create`, `fulfillment-guards`, `fulfillment-services`, `fulfillment-reconcile`). local |
| 3 | No job without a verified capture; the check is in the database function | Met | `fulfillment_create_job` re-checks a CAPTURED attempt and a COMMITTED reservation under the purchase lock. Tested for no attempt, created, order created, approved, authorized, a capture in flight, voided, unknown outcome and a financial exception, all `NOT_PAID` with nothing created. local |
| 4 | The worksheet is built from the verified accepted snapshot, equals what was accepted, and is immutable; a quote that no longer verifies creates no job | Met | `buildWorksheet` is pure and deterministic and holds no payer or PayPal data (`tests/fulfillment/worksheet`); the service verifies the approval binding first; a superseded quote gives `QUOTE_NOT_ACCEPTED`; a trigger rejects any change to the worksheet or the purchase (`fulfillment-guards`). local |
| 5 | The job transition table is complete in TypeScript and the database trigger rejects every other pair; COLLECTED and events cannot be changed | Met | `tests/fulfillment/state` checks every pair against a separately written table; `fulfillment-guards` checks every pair against the trigger, COLLECTED immutability and the append-only log. The trigger lets an ON_HOLD job return to any holdable status; the move function narrows a resume to the status it left (`fulfillment-move`). local |
| 6 | A double click moves a job once; a hold needs a note; a resume returns to the step it left | Met | `fulfillment-move`: a repeat and five simultaneous identical moves give one event; `NOTE_REQUIRED` for no note or blank notes; a hold from each of the three statuses resumes to that status only. E2E double-click test: two events in all. local |
| 7 | Access: a merchant sees and moves only their own jobs; a customer sees only their own job's coarse status | Met | Another merchant's job is `NOT_FOUND` for `moveJob`; the merchant list and `readJob` run under the merchant's own session, so another merchant's id returns nothing (`fulfillment-reads`); the customer view returns exactly `{status, readyBy}`, a hold reads "delayed" without the note, and another customer's page shows nothing (`fulfillment-reads`, E2E). local |
| 8 | The reconcile run creates missing jobs after payments and before the sweep; a failing run still finishes and then fails visibly | Met | `tests/fulfillment-reconcile-handler`: order heartbeat, payments, jobs, sweep; a failing step never stops the next and the run answers `payments_failed`, `jobs_failed` or `sweep_failed`; `createMissingJobs` isolates a failing purchase, audits it and throws at the end (`fulfillment-services`). local |
| 9 | `domain/fulfillment` passes the purity test; typecheck, lint, unit, database and E2E green locally and in CI; payment and access tests green | Met | Local: figures above. `tests/fulfillment/purity.test.ts` limits `domain/fulfillment` imports to `domain/catalog`, `quote`, `reservation`, `lib/money`, `zod` and itself, and bans clock, environment and `Math.random` reads. **CI: green on `e6f17ea` (PR 6), 8 of 8 checks; PR 6 merged as `3e01097`.** |
| 10 | The merchant can see the worksheet and move the job; the customer can see the status | Met | E2E (10 tests): accepting a payment makes the job and the merchant's Jobs page shows the pick list, the per-box contents, the confirmed conditions and the history; the merchant moves it to collected and the customer's page follows; a hold with a note, resume, empty lists, merchant-only access and the redirect for visitors with no session. local + mocked |

Counts: fulfillment unit tests 88 (`tests/fulfillment`, `tests/fulfillment-reconcile-handler.test.ts`, `tests/merchant-decision-actions.test.ts`),
fulfillment database tests 77 (`tests/db/fulfillment-*`), fulfillment E2E tests 10.

## Hosted migration

Applied on 3 Nov after a fresh explicit yes, with `supabase db push --db-url` against the hosted project (ref `twkepbycivkmhrmurxwi`, the one in `.env`).
A dry run first listed exactly one pending migration, `0008_fulfillment.sql`. Checked read-only before and after, over the same connection:

| | Before | After |
|---|---|---|
| Applied migrations | 0001 to 0007 | 0001 to 0008 |
| Preparation jobs and events | 0 and 0 (the migration precondition held) | 0 and 0 (no data touched) |
| Captured payment attempts, committed reservations | 2 and 2 (the two orders paid in the real-sandbox runs) | 2 and 2 |
| New event columns (`from_status`, `actor`) | 0 of 2 | 2 of 2 |
| Guard triggers (jobs transition, events append-only) | 0 of 2 | 2 of 2 |
| Fulfillment functions | none | 3, callable by `service_role` only (not `anon`, not `authenticated`) |
| `check_stock_invariants()` | not run | returns an empty array |

The hosted site still runs the code from before this module until PR 6 is merged and deployed; that older code never calls the new
functions, so nothing changes for users in between. After the deploy, the first reconcile run should create the two jobs (see Open items).
Not run against hosted: the database tests, which clear application data (local only by design).

## Findings from this review

1. **The quote keeps its conditions in a fixed order**, not the order a caller supplied, so a worksheet lists the artwork condition
   before the production-slot one. Nothing depends on the order; the test now expects the stored order.
2. **`fulfillment_move_job` takes an actor** the spec's signature did not list, so the event can say who moved the job. The spec text
   is updated; no state or transition changed.
3. **One database test file failed once as a whole file** in a full local run (`payments-decide`, no individual test named) and passed
   in four later runs, alone and in full. Not diagnosed; recorded so a repeat is recognized.
4. **Not covered by any test:** the optional automatic refresh of the customer page (left out, it is cuttable); showing the customer's
   uploaded artwork on the worksheet (depends on file storage from `ai-intake`); cancelling or refunding a paid order (out of scope in v1).
5. **The reconcile run depends on hosted cron.** The new step runs wherever `/api/cron/reconcile` is called; on hosted that is the
   scheduled call set up in foundation. If that schedule is not running, the accept action is the only creator of jobs.

## Open items

1. Optional: the sandbox merchant id for `PAYPAL_PAYEE_MERCHANT_ID` (carried over from payments).
2. Not tried on the live site: a hold with a note and a resume. Covered by the local and E2E tests.
