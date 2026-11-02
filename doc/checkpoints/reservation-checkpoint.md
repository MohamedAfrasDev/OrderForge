# Checkpoint: reservation review

Date: 2 Nov 2026 · Module: `reservation` · Reviewed against: [doc/spec/SPEC-reservation.md](../spec/SPEC-reservation.md) §11
· Code reviewed: `spec-4-reservation` at `f9647d0` plus one added gate (see Findings).

Every verdict below was re-run on 2 Nov against current state. Evidence is labeled **local** (Docker Supabase on this machine),
**hosted** (the real Supabase project), or **CI** (GitHub Actions). CI evidence was added after the push (criterion 10). Nothing here is hosted evidence: the branch is pushed, but
migration 0006 has not been applied to the hosted project.

## Verdict

**11 of 11 criteria met.** Criterion 10 was partly met until CI ran on the pushed branch; it is now met (see its row). Every local
gate is green and CI is green on `6609daa`. Migration 0006 is applied to the local database only. The module is ready for `payments` to call.

## Criteria

| # | Criterion (spec §11) | Verdict | Evidence |
|---|---|---|---|
| 1 | Demo path A to H with exact quantities on real Postgres | Met | A: 30 of each of five products held, expiry set (`reservation-reserve`, `reservation-services`). B: two customers racing for the last 24 bottles at 13 each, one wins, the loser sees needed 13 and available 11, nothing partial. C and D: a reservation in flight, or awaiting confirmation, past its expiry is not released by a timer, stock stays held (`reservation-operations`, `reservation-sweep`). E: decline, void, stock back to 10 available. F: capture, `on_hand` and `reserved` fall together, available unchanged. G: sweep releases a plain hold at exactly its expiry, and it can be taken up again. H: unknown outcome goes to `REVIEW_REQUIRED` with stock held, and resolves to each of four targets. local |
| 2 | Parallel reservations never over-allocate; a failed one changes nothing; opposite-order multi-product reservations do not deadlock | Met | Twenty parallel reservations of 7 against 50 units: exactly 7 fit, reserved is 49, never above `on_hand`. A short second product leaves the first untouched and creates no reservation. 24 parallel reservations in alternating product order all succeed. Five parallel reserves of one purchase make one reservation. local |
| 3 | Transition table complete in TypeScript; the database trigger rejects every other pair, including `COMMITTED` changes and any `RELEASED` exit except an expired re-hold | Met | `state.test.ts` checks every state, event, operation and outcome pair against a separately written table. `reservation-guards` runs all 121 pairs of state variants (every operation and every release reason) against the trigger, derived from the TypeScript table, plus `COMMITTED` immutability, the purchase being fixed, and the check constraints. local |
| 4 | A sweep never changes in-flight, awaiting or review reservations except stale in-flight to review, never releases their stock, and races safely with `begin_operation` | Met, with a nuance (Finding 3) | `reservation-sweep`: `AWAITING_CONFIRMATION`, `COMMITTED` and `REVIEW_REQUIRED` untouched even 100000 minutes late; in-flight past its hold expiry untouched until the in-flight limit (default 30 minutes, merchant rule, a malformed rule ignored). Ten rounds of a sweep racing `begin_operation` end with exactly one winner and stock matching it. Two sweeps at once, and a sweep racing a release, change stock once. local |
| 5 | Repeated or concurrent `reserve`, `settle`, `release` and `resolve` change stock exactly once | Met | Five simultaneous `CAPTURED` settlements commit once; five `VOIDED` release once; five releases release once; a repeated `CAPTURED` returns the same result; a commit racing a release resolves to one winner (six rounds); repeating a resolution is a no-op. Failure outcomes are deliberately not idempotent. local |
| 6 | `reserveForPurchase` refuses a superseded, tampered or not accepted quote, and reserves the per-product sum from the snapshot | Met | `reservation-services`: `QUOTE_NOT_ACCEPTED` with cause `SUPERSEDED` and with cause `QUOTE_TAMPERED`, nothing reserved. A product in two slots (1 and 2 per box, 10 boxes) reserves 30 in one line. Quantities come only from the accepted snapshot; a SKU the merchant no longer sells is `INVALID_INPUT`. local |
| 7 | `check_stock_invariants()` is empty after every database test file and after the full demo path | Met (gate added in this review, Finding 1) | Every reservation test file now ends with an `afterAll` that calls the database's `check_stock_invariants()` for every product the file created and fails on any discrepancy. It was shown to fail on a deliberately corrupted file, then removed. The full demo path (capture, decline, expiry) is asserted consistent in `reservation-sweep`, and the SQL function is cross-checked against the pure TypeScript invariant. local |
| 8 | A superseded quote's `HELD` reservation is released; one in any other state goes to review | Met | `releaseForInvalidatedPurchases`: plain hold released as `SUPERSEDED`, awaiting confirmation flagged for review with stock held, committed and unreserved skipped, a hold that moved into flight after listing is flagged instead. The sweep does the same for anything missed (`reservation-sweep` orphans). The merchant publish action calls it and a failing release never fails the publish (6 unit tests). local |
| 9 | RLS and customer-view tests pass: merchants read only their own holds; customers see only their own hold | Met | `reservation-reads`: a signed-in merchant's own session lists only their holds, even when another merchant's id is asked for; the customer view returns only the verified inquiry's hold, exactly two fields (state and expiry), no ids, quantities, product names or review notes. Foundation `rls.test` covers the tables. local |
| 10 | `domain/reservation` passes the purity test; typecheck, lint, unit, database and E2E green locally and in CI | Met | Local: 0 type errors, 0 lint problems, 577 unit, 544 database, 60 E2E, production build ok. `purity.test.ts` limits `domain/reservation` imports to `domain/quote`, `lib/money`, `zod` and its own files, and bans clock, environment and `Math.random` reads. **CI: green on `6609daa` (PR 3), 8 of 8 checks: typecheck, lint, test and build; database tests (local Supabase); E2E; Vercel preview, in both the push run and the pull-request run.** local + CI |
| 11 | The customer sees the hold and its expiry on an accepted quote, and the merchant holds page works | Met | E2E (5 tests): "held until <time> UTC" on the accepted quote; "reserved for you" once payment is under way; "the hold on your items has ended" for a hold past its expiry without waiting for the sweep; no hold line when there is no hold; the merchant's holds page lists holds with quantities and product names, a "Needs attention" list with the review note, never another merchant's holds, and nothing to submit. local |

Counts: reservation-specific unit tests 78 (`tests/reservation`, `tests/reconcile-sweep.test.ts`, `tests/merchant-quote-actions.test.ts`),
reservation-specific database tests 307 (`tests/db/reservation-*`), 5 reservation E2E tests.

## Hosted migration

**Not applied.** Migration 0006 is local only. Before applying it to the hosted project (after your explicit yes) the plan is the
same as for 0005: confirm the project ref, dry-run `supabase db push --db-url`, and read the tables before and after. The migration
has a precondition: existing `reservations` rows must already satisfy the new checks. Hosted had no purchases when last checked
(so no reservations); that has to be re-checked read-only immediately before applying.

## Findings from this review

1. **Criterion 7 was only partly backed.** Invariants were asserted inside individual reservation tests, not as a gate for each file.
   Every reservation test file now ends with a database-side check over the products it created, and it fails when stock is inconsistent.
2. **Design problems found while building, all fixed and tested:** one hold whose stock could not be given back aborted the whole sweep
   (a poison pill every minute), so the sweep now isolates it, audits `reservation.sweep_error`, finishes the rest, then fails the run
   so the scheduler shows it. The in-flight stale query first locked every in-flight row and filtered afterwards; it now filters in the query.
   Application code had no way to flag an in-flight reservation for review, so `flag_for_review` was added.
3. **Criterion 4 reads narrower than the spec's own assumption 9.** The sweep also flags orphaned in-flight or awaiting reservations (their
   quote is no longer accepted) for review, with the stock still held. That is what assumption 9 asks for and it never releases stock for them.
4. **Changes beyond the spec text, none changing a state or the transition table:** `flag_for_review` RPC; the sweep service built in
   T4 rather than T5 because the route needed it; `settle_operation` and `resolve_review` take optional hold-window, release-reason and note
   parameters; `release_hold` with reason `EXPIRED` before the expiry returns `INVALID_INPUT` rather than adding a new code; the customer
   view collapses the six internal states to three (held, secured, ended); settle idempotence covers success outcomes only.
5. **A test-suite change that affects workflow:** the database suite now also clears application data when it ends (before, only at the
   start), because some fixtures are inconsistent on purpose and the scheduled sweep now (rightly) reports them as accounting errors,
   which made the cron E2E return 500 locally. CI starts from a fresh database and was never affected. README updated.
6. **Local data:** the local demo data was re-seeded after each database run, with the local URL and key set for that one command (`.env`
   points at the hosted project and the seed script refuses a remote host without `--confirm-host`).

## Open items

| Item | Why it is open | What closes it |
|---|---|---|
| Migration 0006 on hosted | Local only; hosted needs a fresh explicit yes | You say yes immediately before; then dry run, apply, read-only checks before and after. |
| Nothing calls reserve, begin or settle in the live flow | Accepting a quote does not create a hold; `payments` (its `start_checkout`) is where `reserveForPurchase`, `beginOperation` and `settleOperation` are called | `payments` spec and build. Wiring `reserveForPurchase` into the accept action earlier is a small change if you want customers to see a hold before payments exists. |
| Order of work inside the reconcile route | The sweep runs after the heartbeat; once `payments` adds its reconciliation it must run first, so in-flight work is reconciled before the sweep flags it | `payments` task for the reconcile route (a comment marks the spot). |
| Merchant rules introduced | `reservation_hold_minutes` and `inflight_review_minutes` (each `{ "minutes": n }`), defaults 30 and 30, are not in the seed or the README | Add to the README's rules section when `payments` lands, or on request. |

## Next

After CI is green and the hosted migration is decided: the next modules in build order are **`ai-intake`** (it can run in parallel; it
needs `catalog-engine` and `quote-approval`, both done) and **`payments`** (needs this module and `quote-approval`). Spec first for each,
as `AGENTS.md` requires.
