# Checkpoint D: foundation review

Date: 2 Nov 2026 · Module: `foundation` · Reviewed against: [doc/spec/SPEC-foundation.md](../spec/SPEC-foundation.md) §1 and §15
· Code reviewed: `spec-1-foundation` at `6d167c7` (plus one generated file removed from git, see Findings).

Every verdict below was re-checked on 2 Nov against the running systems, not carried over from earlier task notes. Evidence is
labeled **local** (a Docker Supabase on this machine), **hosted** (the real Supabase project and the Vercel site), **CI** (GitHub
Actions), or **real-sandbox** (the real PayPal sandbox).

## Verdict

**14 of 15 criteria met. 1 not met, because it cannot be met inside the schedule: observing sandbox authorization expiry.**
The module is ready to build on. Four items are open or deserve a decision (see Open items).

## Criteria

| # | Criterion (spec) | Verdict | Evidence |
|---|---|---|---|
| 1 | Fresh clone plus `.env` from `.env.example` runs `dev`, `test`, `build` (§1) | Met | Clean clone of the pushed branch, README followed literally: dev server healthy (`env ok`, `database ok`), seeded merchant signs in, build ok. local |
| 2 | `typecheck`, `lint`, `test`, `test:db`, `build` pass in CI and locally (§15) | Met | Local: 0 type errors, 0 lint errors, 232 unit, 86 database, 42 E2E. CI on `6d167c7`: check, database and E2E jobs all green. |
| 3 | `supabase db reset` applies migrations and seed; repeatable via `demo:reset` (§1) | Met | `db reset` applies 0001 to 0004 clean. `demo:reset` run three times: see row 4. local, and hosted migrations applied with `supabase db push`. |
| 4 | Migrations apply on a clean DB; `demo:reset` restores the seed **exactly** (§15) | Met | One md5 over every seeded row (merchants, products, stock, rules): `bb0b…` after reset 1, 2 and 3; the deliberately dirtied state hashed differently (`7048…`) and left 4 extra rows that the reset removed. local |
| 5 | Real PayPal sandbox authorize, capture and void succeed on the hosted site, evidence labeled real sandbox (§1, §15) | Met | Orders `3W3141129R8530006` (authorize, capture 1080 USD) and `9T3837548G451384N` (authorize, void confirmed VOIDED). Ten `real-sandbox` rows. Write-up: [doc/evidence](../evidence/foundation-real-sandbox.md). real-sandbox, hosted |
| 6 | Webhook rejects unsigned or forged requests; duplicates acknowledged with no second effect (§1, §15) | Met | Live: unsigned and forged-cert requests answer 400. Duplicates: handler tests (replayed three times, one row), and 10 simultaneous redeliveries leave one row in real Postgres. Hosted: 7 real webhook rows, 7 distinct event ids. hosted, local |
| 7 | No merchant routes without a session; customer link A cannot read inquiry B, server-side and tested (§1, §15) | Met | Database tests (8 RLS and 11 inquiry-read cases) and E2E (16 customer-link and 5 merchant-auth tests). Live: `/merchant` answers 307 to the login page when signed out. local, CI, hosted |
| 8 | Sandbox banner on every route (§1, §15) | Met | Root layout renders it. Live check: present on `/`, `/merchant/login`, `/store/<slug>`, `/o/<token>` (not-found view), a 404 page, and the login page that `/merchant/dev/paypal` redirects to. E2E checks `/` and a 404. hosted |
| 9 | No secret in the repository or any client bundle (§1) | Met | Scan of 111 tracked and untracked non-ignored files: no `.env` value and no token, database-URL or client-id shaped string. Client bundle: 29 files of the local production build and 5 live pages plus 12 live JS and CSS chunks (about 714 KB), checked against 8 real secret values (service-role key, PayPal secret and webhook id, OpenRouter key, link and cron secrets, demo and database passwords): none present. |
| 10 | `pg_cron` job exists, calls `/api/cron/reconcile` with the bearer secret, shows successful runs on hosted; 401 without the bearer (§15) | Met | Hosted: job `orderforge-reconcile` (`*/5 * * * *`, active); **25 of 25 runs succeeded**, 25 HTTP 200 answers, latest tick 5 minutes before the check; the Vault URL is the new domain. Live: 401 with no bearer and with a wrong one. hosted |
| 11 | Access: cross-inquiry and unauthenticated reads denied, DB and E2E tests (§15) | Met | Same evidence as row 7. |
| 12 | `.env.example` lists every variable; MIT `LICENSE` present (§15) | Met | 17 of 17 variables required by the spec, the app's env schema and the scripts are listed (the database URL as a commented placeholder). `LICENSE` is MIT. |
| 13 | Sandbox banner on every route (§15) | Met | See row 8. |
| 14 | Secret scan of the tree is clean (§15) | Met | See row 9. |
| 15 | Sandbox authorization-expiry behaviour **observed** and recorded in the spec (§15) | **Not met** | PayPal holds an authorization up to 29 days, so it cannot be observed before the 12 Nov deadline. The spec records it as **not observed**. The brief itself allows deadline handling to be shown with clearly labeled application-level tests, and those belong to the `payments` module. |

## Findings from this review

1. **A generated file was tracked in git.** `test-results/.last-run.json` was committed even though `/test-results/` is ignored, so
   every test run made the tree dirty. It is now removed from git (it stays on disk). Part of this commit.
2. **My first "demo reset is exact" check was invalid, and I caught it.** A shell quoting slip made all three "fingerprints"
   the same error message, which compared equal. The numbers in row 4 come from a corrected check: real 32-character hashes, a
   dirty state that hashes differently, and a guard that rejects anything that is not a hash.
3. **No secret reached a client bundle.** This had not been checked before this review.
4. **The real-sandbox run used the production deployment, not a preview.** The spec words criterion 5 as "on the Vercel
   preview". Preview URLs sit behind Vercel's login wall, which would also block PayPal's webhooks and the scheduler's calls, so the
   stable production address was the right target. The criterion's intent (a real sandbox run on the hosted site) is met.

## Open items

| Item | Why it is open | What closes it |
|---|---|---|
| PayPal webhook delivery on `order-forge.afras.dev` | The webhook URL was changed after the last real delivery (07:33 UTC). Nothing has arrived since. | One real run on the new domain (create, approve with the US buyer, capture), then check the hosted `payment_events` for new `webhook` rows. |
| Criterion 15 (expiry) | Needs up to 29 days of waiting | Decision: accept "recorded as not observed, covered by application-level tests in `payments`" and amend the criterion, or keep it open. |
| Vercel Git integration is active | A merge to `main` would likely deploy production automatically | Keep it, or disconnect it in Vercel's Git settings. |
| Environment hygiene on the developer machine | A stray old Supabase CLI at `C:\Users\moham\node_modules\.bin` (2.24.3) and an older global npm one (2.107.0) shadow the current CLI (2.119.0) in some folders | Remove the stray installs. The tests now explain this clearly if it happens. |

## Not part of this checkpoint

The product modules (`catalog-engine`, `quote-approval`, `reservation`, `payments`, `fulfillment`, `ai-intake`) are specified in
`SPEC.md` and not built. The payment state machine, reconciliation logic and webhook-driven transitions arrive with `payments`;
the real-sandbox findings that shape them (webhooks are delayed and out of order, voiding a captured authorization is HTTP 422
`PREVIOUSLY_CAPTURED`) are recorded in the foundation spec.
