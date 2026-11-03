# Tasks: fulfillment

Spec: [doc/spec/SPEC-fulfillment.md](../../doc/spec/SPEC-fulfillment.md) · Plan: [plan.md](plan.md)
Status: spec APPROVED 3 Nov 2026; task list awaiting approval; T1 and T2 built (0008 applied to local only). Tick a box only after its Verify step passes. Every task is test first.

## Phase A: pure logic (no database, no network)

- [x] **T1 Types, job transition table, `buildWorksheet`, `customerStatusOf`, purity**
  - Acceptance: `JobStatus`, the result codes and `Worksheet` exist. `transition` implements the spec's table: every pair is the listed
    target or `ILLEGAL_TRANSITION`; `COLLECTED` has no exit; `ON_HOLD` is reachable from `QUEUED`, `PREPARING` and `READY_FOR_PICKUP` and
    returns only to the status it left (given in the context); no step is skipped or reversed. `buildWorksheet(snapshot, facts)` is
    deterministic: lines per box, the total to pick per product (quantity per box times boxes, summed per product, so a product in two
    slots counts twice), the quote version and hash, the conditions and which were confirmed, the pickup method, lead days and
    ready-by, the total paid; it takes no clock and holds no payer, contact or PayPal data. `customerStatusOf` maps the five statuses to
    the four customer words. A purity test limits `domain/fulfillment` to `domain/catalog`, `domain/quote`, `domain/reservation`,
    `lib/money`, `zod` and itself, with no clock, environment or `Math.random` reads.
  - Verify: `npm run test -- tests/fulfillment && npm run typecheck`
  - Files: `domain/fulfillment/{types,state,worksheet,customer-status,index}.ts`, `tests/fulfillment/{state,worksheet,purity}.test.ts`
  - Depends on: none (payments is built).

## Phase B: migration 0008 on local Supabase (real Postgres, no network)

- [x] **T2 Migration 0008 part 1: event columns, guard triggers, `fulfillment_create_job`**
  - Acceptance: `preparation_events` gains `from_status` and `actor` (checked). A guard trigger on `preparation_jobs` allows only the
    spec's moves, never changes `worksheet` or `purchase_id`, and never changes a `COLLECTED` job; a trigger on `preparation_events` refuses
    update and delete. `fulfillment_create_job(purchase, worksheet, now)` (service role only, `set search_path = ''`) locks the purchase,
    returns `NOT_PAID` unless an attempt is `CAPTURED` and the reservation `COMMITTED`, validates the worksheet's schema tag and size,
    inserts the job and its first `QUEUED` event, or returns the existing job with `already`. Tests: every unpaid state (no attempt,
    created, authorized, voided, unknown outcome, exception) creates nothing; ten parallel creations give one job and one first event; a
    repeat returns the same job; direct updates of the worksheet or purchase, changes to a collected job and event updates or deletes are
    rejected; the anon and authenticated roles are denied; every state pair against the TypeScript table.
  - Verify: `supabase db reset && npm run test:db -- tests/db/fulfillment-create.test.ts tests/db/fulfillment-guards.test.ts`
  - Files: `supabase/migrations/0008_fulfillment.sql`, `tests/db/fulfillment-create.test.ts`, `tests/db/fulfillment-guards.test.ts`, `tests/db/fulfillment-helpers.ts`
  - Depends on: T1. Ask first before applying anywhere but local.

- [ ] **T3 `fulfillment_move_job` and `fulfillment_paid_purchases_without_job`**
  - Acceptance: `fulfillment_move_job(job, merchant, to, note, now)` locks the job, returns `NOT_FOUND` for another merchant's job, applies
    the table, requires a note for a hold (`NOTE_REQUIRED`), resumes to the status recorded in the last non-hold event, treats a request
    for the current status as a no-op (`already`), and writes the event with the actor and the previous status in the same transaction.
    `fulfillment_paid_purchases_without_job(limit)` returns paid purchases that have no job, oldest first. Tests: the full path
    `QUEUED` to `COLLECTED`; skipping and going backwards refused; a double click and five simultaneous identical moves move once; hold
    then resume from each of the three statuses returns to the right one; another merchant is refused; the missing-jobs query lists a paid
    purchase without a job and stops listing it once the job exists.
  - Verify: `npm run test:db -- tests/db/fulfillment-move.test.ts tests/db/fulfillment-missing.test.ts`
  - Files: `supabase/migrations/0008_fulfillment.sql` (extend), `tests/db/fulfillment-move.test.ts`, `tests/db/fulfillment-missing.test.ts`
  - Depends on: T2.

## Phase C: services and wiring (local fake PayPal only to produce paid purchases, evidence labeled mocked)

- [ ] **T4 Services: `createJobForPurchase`, `createMissingJobs`, `moveJob`, the reads**
  - Acceptance: `createJobForPurchase` loads the purchase, verifies the approval binding (`QUOTE_NOT_ACCEPTED` otherwise), reads the merchant's
    `production_lead_days` and `fulfilment` rules and the confirmed conditions, builds the worksheet from the snapshot only, and makes the
    one idempotent database call; the database decides `NOT_PAID`. `createMissingJobs` handles a bounded batch with per-purchase error
    isolation and throws after finishing the rest if any failed. `moveJob` is for a merchant actor and audits (`job_id`, `from`, `to`).
    `jobStatusForCustomer` returns exactly the coarse status and the ready-by date for a verified inquiry; `listJobsForMerchant` and
    `readJob` run under the merchant's own session. `lib/audit.ts` allows the key `job_id`. Tests (demo steps A to D and G, access): a
    paid purchase gets one job with the right worksheet; a catalog price and name change afterwards changes nothing; a superseded or
    tampered quote creates no job; authorized-only and declined purchases get `NOT_PAID`; the customer view has exactly its keys and no
    note; another customer or merchant gets nothing.
  - Verify: `npm run test:db -- tests/db/fulfillment-services.test.ts tests/db/fulfillment-reads.test.ts`
  - Files: `services/fulfillment/{create,move,read,shared}.ts`, `lib/audit.ts`, `tests/db/fulfillment-services.test.ts`, `tests/db/fulfillment-reads.test.ts`
  - Depends on: T3.

- [ ] **T5 Wiring: the accept action and the reconcile route**
  - Acceptance: after the merchant's accept action gets `CAPTURED` from `decide`, it asks for the job; a failure there is logged and never
    fails the accept. `handleReconcile` gains a `createMissingJobs` dependency that runs after payments and before the sweep; its failure
    never stops the sweep and then fails the run visibly (`jobs_failed`), as payments does; the route wires it. Tests: handler ordering
    (heartbeat, payments, jobs, sweep) and failure handling; a capture settled out of doubt gets its job from the next run, once; a
    repeated accept action and a run racing the action still give one job (demo steps B and H).
  - Verify: `npm run test -- tests/fulfillment-reconcile-handler.test.ts tests/payments-reconcile-handler.test.ts && npm run test:db -- tests/db/fulfillment-reconcile.test.ts`
  - Files: `lib/cron/reconcile-handler.ts`, `app/api/cron/reconcile/route.ts`, `app/merchant/decisions/actions.ts`, `tests/fulfillment-reconcile-handler.test.ts`, `tests/db/fulfillment-reconcile.test.ts`
  - Depends on: T4.

## Phase D: screens and review

- [ ] **T6 Screens: merchant jobs and the customer status line**
  - Acceptance: `/merchant/jobs` (linked from the merchant home) lists the merchant's jobs, with the worksheet (lines, totals to pick,
    conditions, ready-by, pickup) and the events, and a move form: start, finish, record pickup, hold with a note, resume; buttons disable
    while a request runs and the server refuses repeats. The order room shows the customer's coarse status and ready-by date once a job
    exists (before that it still shows the payment status), never the worksheet or a note. E2E: the merchant accepts, the job appears with
    its worksheet, the customer reads "being prepared", the merchant moves it to collected and the customer's page follows; a double click
    moves once; a hold needs a note; another merchant sees nothing; a visitor with no session goes to login. Optional automatic refresh is
    cuttable.
  - Verify: `npm run test:e2e -- e2e/fulfillment-merchant.spec.ts e2e/fulfillment-customer.spec.ts`
  - Files: `app/merchant/jobs/{page,actions}.tsx`, `components/job-status.tsx`, `app/o/[token]/page.tsx`, `e2e/fulfillment-merchant.spec.ts`, `e2e/fulfillment-customer.spec.ts`
  - Depends on: T5.

- [ ] **T7 Checkpoint**
  - Acceptance: every spec success criterion reviewed against current state with labeled evidence (mocked, local, CI, real-sandbox); CI green
    on the last code commit; record in `doc/checkpoints/fulfillment-checkpoint.md`; statuses updated in `SPEC.md` and this file. Applying 0008 to
    the hosted project only after a fresh explicit yes, with read-only checks before and after; then, after the deploy, the two orders already
    captured on the hosted site get their jobs from the reconcile run and you confirm one on the order room as the customer; one is moved
    to collected. Recorded separately and labeled.
  - Verify: `npm run typecheck && npm run lint && npm run test && npm run test:db && npm run test:e2e`
  - Files: `doc/checkpoints/fulfillment-checkpoint.md`, `doc/evidence/fulfillment-real-sandbox.md`, `SPEC.md`, `doc/spec/SPEC-fulfillment.md`, `tasks/fulfillment/todo.md`
  - Depends on: T6.
