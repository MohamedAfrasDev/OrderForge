# Spec: fulfillment

Module id: `fulfillment` · Depends on: `payments` (built; PR 5 with its last fix is open) · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: **DRAFT, awaiting approval.** Written 3 Nov 2026. Target window: 8–9 Nov 2026 (brief schedule: "unique job" and "a real sandbox purchase reaches the preparation view"; the project is ahead of it). The 9 Nov tripwire applies. Decisions to confirm: **a job is created only for a purchase whose payment is a verified capture, by code in this module (payments never calls it), at most once per purchase by a database constraint; its worksheet is built from the accepted quote snapshot and never changes; the merchant moves the job through a fixed set of steps; the customer sees the status in plain words.**

## 1. Objective

Turn a paid order into exactly one job the merchant can prepare from an exact worksheet, and let the customer see where it is. Nothing else about the order changes here: money and stock were settled by `payments` and `reservation`.

Why: the brief's last steps are "reconcile and prepare" (one preparation job, a worksheet built from the accepted quote snapshot, customer-visible status) and the rule "never cut the real preparation handoff". `payments` decided *whether* a purchase is paid and exposes that as one fact. This module turns that fact into work, and makes it safe to ask twice: a repeated capture click, a repeated reconcile run or a missed event must never create a second job or lose the first.

**Users of the module:** the merchant (sees the worksheet and moves the job along), the customer (sees the status), the accept action and the scheduled reconcile route (both ask for the job to exist; the second is the safety net for anything missed).

### The demo path this module must reproduce

| Step | Action | Required result |
|---|---|---|
| A | A purchase is paid (attempt `CAPTURED`, reservation `COMMITTED`) | One job in `QUEUED` with a worksheet, and a first status event |
| B | The job is requested again, ten times in parallel, and by the reconcile run | Still exactly one job, one first event, one worksheet; the repeats return the same job |
| C | A purchase that is not paid (authorized only, declined, unknown outcome, exception) | No job is created, whatever calls it; the refusal says why |
| D | The catalog price or a product name changes after payment | The worksheet is unchanged: it holds what the customer accepted |
| E | The merchant starts the job, finishes it, marks it collected | `QUEUED` to `PREPARING` to `READY_FOR_PICKUP` to `COLLECTED`, one event each, nothing skipped, nothing backwards; a double click moves it once |
| F | The merchant puts a job on hold with a note, then resumes it | `ON_HOLD`, then back to the step it left; the note is on the event |
| G | The customer opens their order room | The status in plain words and the ready-by date; no worksheet internals, no merchant notes, never another customer's job |
| H | A capture was reconciled out of doubt (or a webhook arrived) and nobody asked for a job | The next reconcile run creates it |

### Acceptance criteria
- Steps A to H pass as automated tests against real Postgres, labeled mocked where the fake PayPal is involved.
- At most one job per purchase, enforced by the unique constraint that already exists; parallel and repeated creation yields one job and one first event.
- A job exists only for a purchase that `payments` reports as paid; the database function checks it, not just the caller.
- The worksheet is built only from the verified accepted snapshot (`verifyApprovalBinding`) and cannot be changed after creation.
- Status changes follow the transition table in TypeScript and in a database trigger; every change writes an event and an audit row.
- A customer sees only their own job's status; a merchant sees and moves only their own jobs.

## 2. Assumptions (correct me now or I proceed)

1. **Paid means `payments` says so.** The fact is `isPurchasePaid` (an attempt `CAPTURED`; the reservation is then `COMMITTED`). The database function that creates the job re-checks both in its own transaction, so a caller cannot create a job for an unpaid purchase.
2. **Who asks for the job.** `payments` never calls this module (dependencies point one way). Two callers do: (a) the merchant's accept action, right after `decide` returns `CAPTURED`; (b) the scheduled reconcile route, which runs after `reconcilePayments` and before the reservation sweep and creates a job for every paid purchase that lacks one. (b) covers a capture that was settled out of doubt, by a webhook, or by a failed call in (a). The brief names Inngest for this step; a queue adds a dependency for no gain here, so the existing scheduled route is used (open question 1).
3. **Creation is one idempotent database step.** `fulfillment_create_job(purchase, worksheet, now)` locks the purchase, checks it is paid, inserts the job with `on conflict (purchase_id) do nothing`, writes the first `QUEUED` event only when it inserted, and returns the job either way (`already` says which). The worksheet comes from TypeScript; the database stores and freezes it but does not interpret it.
4. **The worksheet** is a versioned JSON document (`orderforge.worksheet.v1`) built by a pure function from the verified accepted snapshot plus facts frozen at creation. It contains: the quote version and hash it came from; the purchase and inquiry references; the number of boxes; the lines per box (product name, SKU, quantity per box) and the totals to pick per product (quantity per box times boxes, summed per product, using the same rule as the reservation); the conditions the quote carried and which the merchant confirmed when accepting; the fulfilment method (`customer_pickup`, from the merchant's rule at creation); `productionLeadDays` and `readyBy`; the total paid in minor units and currency. It never contains payer details, PayPal ids or the customer's contact details.
5. **Ready-by** is the day the job is created plus the merchant's `production_lead_days` rule (default 7), both frozen into the worksheet. It is a promise shown to the customer, not a deadline the system enforces.
6. **The worksheet is immutable.** A trigger rejects any change to `worksheet` or `purchase_id`. If the merchant needs to change what is made, that is a new quote, and a paid purchase is not edited (the brief's rule: accepted snapshots are immutable). Corrections go on the job's events as notes.
7. **Job states and moves.** `QUEUED` to `PREPARING` to `READY_FOR_PICKUP` to `COLLECTED`; `ON_HOLD` from `QUEUED`, `PREPARING` or `READY_FOR_PICKUP` (a note is required) and back only to the step it left; `COLLECTED` is final. Steps cannot be skipped or reversed. Asking for the state the job is already in is a no-op, so a double click moves it once.
8. **Events are a log.** Every creation and move writes a `preparation_events` row (status, optional note, who, from which status) in the same transaction. Events are append-only: a trigger refuses updates and deletes.
9. **The customer's view is coarse.** Four plain statuses (being prepared, ready for pickup, collected, delayed) plus the ready-by date. `QUEUED` and `PREPARING` read as "being prepared". Merchant notes are never shown to the customer. The page reads on every load; optional automatic refresh is cuttable (open question 3).
10. **Pickup only.** The seeded merchant's rule is `customer_pickup`; there is no shipping, address or courier in v1. Collection is recorded by the merchant, not by the customer.
11. **No stock or money changes here.** Stock was committed at capture; this module never touches stock, reservations, payments or PayPal. Cancelling or refunding a paid order is out of scope for v1: a problem is an `ON_HOLD` job with a note, resolved by the merchant outside the app.
12. **Artwork files.** The worksheet records whether artwork was required and accepted (from the quote's conditions). Showing the customer's uploaded logo on the worksheet depends on the file storage that `ai-intake` builds; until then it is not included (open question 4).
13. **One migration, `0008_fulfillment.sql`**, adds only what is needed (section 4). Local first; hosted is a separate yes.
14. **Access.** Customer reads go through the verified inquiry id (`VerifiedInquiryId`) as everywhere else; merchant reads use the merchant's own session under the existing row level security (`preparation_jobs_select_own` and `preparation_events_select_own` already exist); every write goes through service-role functions, as in the other modules.

## 3. Interfaces (the contract other modules build against)

```ts
type JobStatus = "QUEUED" | "PREPARING" | "READY_FOR_PICKUP" | "COLLECTED" | "ON_HOLD";
type FulfillmentErrorCode =
  | "NOT_PAID" | "QUOTE_NOT_ACCEPTED" | "NOT_FOUND" | "ILLEGAL_TRANSITION"
  | "NOTE_REQUIRED" | "INVALID_INPUT";

// Pure (domain/fulfillment)
transition(from, to, context): JobStatus | { error: "ILLEGAL_TRANSITION" }   // the only job state machine
buildWorksheet(snapshot, facts): Worksheet                                   // deterministic; no clock, no catalog reads
customerStatusOf(status): "PREPARING" | "READY" | "COLLECTED" | "DELAYED"   // the coarse customer wording

// Services (service role; merchant entry points take a merchant actor, customer ones a VerifiedInquiryId)
createJobForPurchase(purchaseId, ctx): Result<{ jobId; status; already }>    // paid check, snapshot check, worksheet, one idempotent step
createMissingJobs(ctx): { checked: n; created: n }                           // reconcile route: paid purchases that lack a job
moveJob(merchantActor, jobId, to, { note }, ctx): Result<{ status; already }>
jobStatusForCustomer(verifiedInquiryId): CustomerJobView | null              // coarse status + ready-by
listJobsForMerchant(db, merchantId): JobRow[]                                // jobs, newest first, with events
readJob(db, merchantId, jobId): JobDetail | null                             // worksheet + events
```

Coded results (stable): `NOT_PAID` (no verified capture for the purchase), `QUOTE_NOT_ACCEPTED` (the snapshot no longer verifies), `NOT_FOUND` (also another merchant's job), `ILLEGAL_TRANSITION`, `NOTE_REQUIRED` (a hold needs a note), `INVALID_INPUT`.

Job transition table (also enforced by a database trigger):

| From | To | When |
|---|---|---|
| (none) | `QUEUED` | the job is created for a paid purchase |
| `QUEUED` | `PREPARING` | the merchant starts |
| `PREPARING` | `READY_FOR_PICKUP` | the merchant finishes |
| `READY_FOR_PICKUP` | `COLLECTED` | the merchant records the pickup |
| `QUEUED`, `PREPARING`, `READY_FOR_PICKUP` | `ON_HOLD` | the merchant pauses it, with a note |
| `ON_HOLD` | the status it left | the merchant resumes it |
| `COLLECTED` | none | final |

## 4. Database changes (one migration, needs approval with this spec)

`supabase/migrations/0008_fulfillment.sql`. The tables, the unique constraint on `purchase_id` and the merchant read policies already exist; the migration adds:

1. **`preparation_events` columns:** `from_status text` (the status before; null for the first event) and `actor text`, both with checks, so an event says who moved what.
2. **Guard triggers:** on `preparation_jobs` (status moves only along the table above; `worksheet` and `purchase_id` never change; `COLLECTED` never changes) and on `preparation_events` (no update, no delete).
3. **`fulfillment_create_job(p_purchase_id, p_worksheet, p_now)`** (security definer, `set search_path = ''`, service role only, jsonb result): locks the purchase; refuses `NOT_PAID` unless an attempt is `CAPTURED` and the reservation is `COMMITTED`; validates that the worksheet is an object of the expected schema tag and size; inserts the job and its first event, or returns the existing job.
4. **`fulfillment_move_job(p_job_id, p_merchant_id, p_to, p_note, p_now)`**: locks the job; checks the merchant owns the purchase (`NOT_FOUND` otherwise); applies the table (a hold needs a note; a resume returns to the status recorded in the last non-hold event); an identical request is a no-op; writes the event.
5. **`fulfillment_paid_purchases_without_job(p_limit)`**: the purchases that are paid and have no job, oldest first, for the reconcile run.
6. **Audit allowlist:** `lib/audit.ts` gains the key `job_id` (the only change outside this module's own files besides the reconcile handler and the accept action).
7. **No new tables.**

Applying 0008 to the hosted project is a separate step and needs your explicit yes immediately before it happens (with the same read-only checks before and after as 0005 to 0007).

## 5. Tech stack

No new dependencies. TypeScript strict, Zod 4, Vitest, Playwright. No PayPal calls anywhere in this module, so the fake PayPal is used only to produce paid purchases in tests (through the existing `payments` services).

## 6. Commands

```
Unit tests:      npm run test                    # includes tests/fulfillment/**
DB tests:        npm run test:db                 # create, race, moves, immutability, access
E2E:             npm run test:e2e                # accept, then the job, then the customer's status
Typecheck/lint:  npm run typecheck && npm run lint
Migrate local:   supabase db reset               # applies 0008 locally (use the installed CLI, not npx)
```

## 7. Project structure

```
domain/fulfillment/
  types.ts            JobStatus, Worksheet, results, codes
  state.ts            transition (the only job state machine)
  worksheet.ts        buildWorksheet
  customer-status.ts  customerStatusOf
  index.ts            public exports
services/fulfillment/
  create.ts           createJobForPurchase, createMissingJobs
  move.ts             moveJob
  read.ts             jobStatusForCustomer, listJobsForMerchant, readJob
  shared.ts           context, RPC helper, audit helper
supabase/migrations/0008_fulfillment.sql
lib/cron/reconcile-handler.ts   gains a createMissingJobs dependency, run after payments and before the sweep
app/merchant/decisions/actions.ts   after an accepted decision returns CAPTURED, asks for the job (a failure never fails the accept)
app/merchant/jobs/              the job list, the worksheet, the move form
app/o/[token]/                  the customer status line (extends the order room)
tests/fulfillment/    unit; tests/db/fulfillment-*.test.ts; e2e/fulfillment-*.spec.ts
```

`domain/fulfillment` imports only `domain/catalog` and `domain/quote` types, `domain/reservation` (the per-product quantity rule), `lib/money`, `zod` and itself; a purity test enforces it, with no clock, environment or `Math.random` reads (the creation time and the lead days are passed in).

## 8. Code style

```ts
// services/fulfillment/create.ts, style reference: verify, build from the snapshot, one idempotent database step
const binding = await verifyApprovalBinding(db, purchase.approval_id);
if (!binding.ok) return { ok: false, code: "QUOTE_NOT_ACCEPTED" };          // the worksheet comes from a snapshot that still verifies
const worksheet = buildWorksheet(binding.value.snapshot, { quoteHash: binding.value.quoteHash, leadDays, now: ctx.now, confirmed });
const out = await callRpc(db, "fulfillment_create_job", { p_purchase_id: purchaseId, p_worksheet: worksheet, p_now: ctx.now });
if (!out.ok) return refuse(out);                                            // NOT_PAID is decided by the database, not by this caller
return { ok: true, value: { jobId: out.job_id, status: out.status, already: out.already } };
```

Conventions as in the other modules: named exports; no `any`; inputs never mutated; every job change goes through `transition` and the guard trigger and writes an event and an audit row; no clock reads in the domain; secrets, PayPal ids and payer details never appear in a worksheet, an event or a log.

## 9. Testing strategy

| Level | What |
|---|---|
| Unit (Vitest) | The transition table (every pair); `buildWorksheet` is deterministic, takes quantities from the snapshot only, sums a product that appears in two slots, holds no payer or PayPal data; `customerStatusOf` over every status; purity |
| Demo path | Steps A to H against real Postgres and the fake PayPal (to produce paid purchases), labeled **mocked** |
| Atomicity and races | Ten parallel creations give one job and one first event; creation racing the reconcile run gives one job; a double move moves once; two merchants' moves on different jobs do not interfere |
| Unpaid | Authorized only, declined, voided, unknown outcome, exception, no attempt: each is `NOT_PAID` and creates nothing, even when the caller is wrong about it |
| Immutability | A direct update of `worksheet` or `purchase_id`, any change to a `COLLECTED` job, and any update or delete of an event are rejected by the database |
| Snapshot | The worksheet equals what was accepted after the catalog price, product name and stock change; a superseded or tampered quote creates no job (`QUOTE_NOT_ACCEPTED`) |
| Access | RLS and server checks: a merchant lists and moves only their own jobs (another's is `NOT_FOUND`); a customer sees only their own job's status and nothing from the worksheet or the notes |
| Reconcile | `createMissingJobs` finds a capture settled out of doubt and creates its job once; a run with an error still finishes the rest and then fails visibly (as the sweep does); the handler runs it after payments and before the sweep |
| E2E | The merchant accepts, the job appears with its worksheet, the customer's status reads "being prepared", the merchant advances to collected, and the customer's page follows; a double click moves once; a hold needs a note; another merchant sees nothing |
| Real sandbox (documented, manual, labeled) | At the checkpoint: the two orders already captured on the hosted site get their jobs from the first reconcile run after 0008 is deployed; one of them is moved through to collected. Recorded separately from the mocked results |

Brief test row owned here: *repeated capture click (one capture, one job)*, shared with `payments`.

## 10. Boundaries

- **Always:** create a job only for a verified capture, in one idempotent database step; build the worksheet from the verified accepted snapshot; freeze it; write an event and an audit row for every change; check ownership on the server for every read and write; keep the customer's view coarse.
- **Ask first:** adding a dependency (a queue such as Inngest) or an environment variable; changing the job states or the transition table; adding a table or a column beyond 0008; applying 0008 to the hosted database; changing what the worksheet contains after the spec is approved; any refund, cancellation or shipping behavior.
- **Never:** create a job for a purchase that is not paid; edit a worksheet; call PayPal, change stock or touch a payment attempt or reservation from this module; let `payments` or `reservation` import this module; show a customer the worksheet, a merchant note or another customer's job; store payer details, PayPal ids or secrets in a worksheet or an event; skip or remove a failing fulfillment, payment or access test without approval.

## 11. Success criteria (testable)

- [ ] Demo path A to H passes with exact quantities; the hosted check (the two already-captured orders get jobs, one is moved to collected) is recorded separately and labeled real-sandbox.
- [ ] One job per paid purchase: ten parallel and repeated creations, a creation racing the reconcile run, and a repeated accept all give one job and one first event (database race tests).
- [ ] No job without a verified capture: every unpaid state is `NOT_PAID` and creates nothing; the check is in the database function.
- [ ] The worksheet is built from the verified accepted snapshot, equals what was accepted after catalog changes, and is immutable (trigger test); a quote that no longer verifies creates no job.
- [ ] The job transition table is complete in TypeScript and the database trigger rejects every other pair; `COLLECTED` and events cannot be changed.
- [ ] A double click moves a job once; a hold needs a note; a resume returns to the step it left.
- [ ] Access tests pass: a merchant sees and moves only their own jobs; a customer sees only their own job's coarse status.
- [ ] The reconcile run creates missing jobs after payments and before the sweep, and a failing run still finishes and then fails visibly.
- [ ] `domain/fulfillment` passes the purity test; typecheck, lint, unit, database and E2E tests green locally and in CI; payment and access tests are green (the 9 Nov tripwire).
- [ ] The merchant can see the worksheet and move the job; the customer can see the status (richer status wording and automatic refresh are cuttable; the job, its uniqueness, the worksheet and the access checks are not).

## 12. Task outline (becomes `tasks/fulfillment/` after approval)

1. Types, job transition table, `buildWorksheet`, `customerStatusOf`, with tests and the purity test.
2. Migration 0008 locally: event columns, guard triggers, `fulfillment_create_job`, with the uniqueness, unpaid, immutability and race tests.
3. `fulfillment_move_job` and `fulfillment_paid_purchases_without_job`, with the move, hold, resume and double-click tests.
4. Services: `createJobForPurchase`, `createMissingJobs`, `moveJob`, the reads; the snapshot, access and unpaid tests.
5. Wiring: the accept action asks for the job after a capture; `handleReconcile` runs `createMissingJobs` after payments and before the sweep; the audit key; the reconcile tests.
6. Screens: the merchant job list, worksheet and move form; the customer status line; the E2E specs.
7. Checkpoint: criteria against evidence, CI, hosted 0008 only after a fresh yes, the hosted check, record in `doc/checkpoints/fulfillment-checkpoint.md`.

## 13. Open questions (defaults apply if you just say "approved")

1. **How a job is requested:** the accept action plus the scheduled reconcile route, not Inngest (no new dependency). Agree?
2. **Ready-by:** job creation day plus the merchant's `production_lead_days` (7), shown to the customer as a target, not enforced. Agree?
3. **Customer status updates:** the order room reads on each load; automatic refresh every 15 seconds is optional and cuttable. Include it?
4. **Artwork on the worksheet:** record only whether artwork was required and accepted; show the uploaded file once `ai-intake` provides file storage. Agree?
5. **After payment, problems:** no cancel or refund in v1; the merchant puts the job on hold with a note and resolves it outside the app. Agree?
6. **Hold notes:** merchant-only; the customer just sees "delayed". Agree, or should the customer see a short reason?
7. **Migration 0008:** may I write it and apply it to local Supabase on approval? Hosted stays a separate yes.
8. **Hosted check:** after 0008 and the deploy, the two orders already captured on the hosted site get their jobs from the reconcile run, and I ask you to confirm one on the order room as the customer. OK?
