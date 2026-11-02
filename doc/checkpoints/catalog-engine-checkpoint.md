# Checkpoint: catalog-engine review

Date: 2 Nov 2026 · Module: `catalog-engine` · Reviewed against: [doc/spec/SPEC-catalog-engine.md](../spec/SPEC-catalog-engine.md) §10
· Code reviewed: `spec-1-foundation` at `015cf93` plus one added test (see Findings).

Every verdict below was re-run on 2 Nov against current state. Evidence is labeled **local** (Docker Supabase on this machine),
**hosted** (the real Supabase project), or **CI** (GitHub Actions).

## Verdict

**9 of 9 criteria met.** CI is green on the last code commit (see criterion 7). The module is ready
for `quote-approval` to build on.

## Criteria

| # | Criterion (spec §10) | Verdict | Evidence |
|---|---|---|---|
| 1 | Demo path A to D with exact numbers | Met | `tests/catalog/demo-path.test.ts`: A valid at 3500 per box and 70000; B blocked `INSUFFICIENT_STOCK` bottle needed 30, available 24; D valid at 3600 and 108000. `alternatives.test.ts`: C returns exactly the desk organizer (+100 per box), never the truffles. A database test runs B against the real seeded stock of 24. local |
| 2 | Every blocker code has a test; several at once, fixed order | Met | All 12 codes are produced in `validate-structure`, `validate-constraints` and `validate-stock-budget` tests. One test returns six at once in the order structure, product, constraint, stock, price, date. local |
| 3 | Unknown SKU, inactive product, product not allowed in its slot and food under `noFood` are blocked and never offered as alternatives | Met | Each is blocked in the validate tests. Alternatives tests: inactive product and food never offered, and (added in this review) an SKU named in a slot list but absent from the catalog is tried, rejected and not offered. Seeded property test checks `noFood` over 300 catalogs. local |
| 4 | `Configuration` with an extra field is rejected | Met | `schemas.test.ts` rejects `unitPriceMinor`, `discount`, `total`, `totalMinor` and `amount` (strict schema). local |
| 5 | Alternatives: single swap, all valid, bounded (<= 20), deterministic, order-independent | Met | Seeded properties over 300 catalogs: each alternative re-validates, differs in exactly one slot, count is bounded, order is by absolute price change, repeat is identical, and shuffling products, selection keys and stock keys changes nothing. A guard asserts the property is not vacuous (more than 100 alternatives offered). local |
| 6 | Stock needed is summed per product across slots | Met | `validate-stock-budget.test.ts`: a product in two slots (quantity 1 and 2, 10 boxes) needs 30; 29 is blocked, 30 is valid. local |
| 7 | Purity test, and typecheck, lint, unit, database and E2E green locally and in CI | Met | Local: 0 type errors, 0 lint errors, 376 unit, 99 database, 44 E2E, production build ok. Purity test (`purity.test.ts`) fails on any import outside `lib/money`, `zod` or the module, and on clock, network, environment or random use. CI: all checks green on `739eca3` (T1 to T8) and on `1e9c814` (T9, T10 and this record), in the pull-request run. The push run of `1e9c814` failed once in its database job with "port 54322 already in use" while starting Supabase on the runner (an infrastructure collision with the parallel pull-request run, before any test ran), so it is not counted. local, CI |
| 8 | `loadCatalogSnapshot` returns the seeded catalog and template from real Postgres and fails clearly on a bad template | Met | 13 database tests: seeded catalog and template, `available = on_hand - reserved`, no other merchant's rows, missing template, five kinds of malformed template, malformed lead-days and minimum rules, all raising `CatalogLoadError` naming the rule. local |
| 9 | Read-only merchant catalog page | Met | `/merchant/catalog`: signed-out visitor redirected to login; signed-in view shows bottle $13.00 with 24 available, truffles flagged food, organizer 100, five template slots, lead time. No visible form or input. E2E, local |

## Hosted re-seed

Done after a fresh explicit OK on 2 Nov, with `--confirm-host` naming the project. Checked read-only before and after:

| | Before | After |
|---|---|---|
| Products, stock rows | 7, 7 | 7, 7 |
| Reserved total, on-hand total | 0, 1574 | 0, 1574 |
| Business rules | `fulfilment`, `logo_print`, `production_lead_days` | the same three plus `box_template` |
| Template | none | notebook, pen, gift (bottle, organizer, truffles), card, packaging, by SKU |

The change is one added rule row. The seed also re-upserts the existing rows with identical values and resets the demo merchant login
password to the `.env` value (it is unchanged in effect). Not run against hosted: the engine's loader (proved on local Postgres with the
same fixture) and the catalog page (hosted deploy follows a merge to `main`).

## Findings from this review

1. **Criterion 3 had a thin spot.** The rule "an unknown SKU is never offered" rested on validation alone, with no direct test.
   A test now names a ghost SKU in a slot list and shows it is tried and rejected.
2. **`npm run test:db` clears the local demo data** (as the README says), so the local seed was re-run after it before the E2E suite.
   This did not affect any result.
3. **The seed command refuses to run against the hosted project without `--confirm-host`.** `.env` points at hosted, so a plain
   `npm run seed` did nothing, as designed. The local seed was run by setting the local URL and key for that one command.
4. **Choices the spec did not fix:** the minimum order rule is `min_order_quantity` with `{ quantity }` (not set by the seed); a
   missing `production_lead_days` rule means 0; the model view leaves out inactive products.

## Open items

| Item | Why it is open | What closes it |
|---|---|---|
| Branch | catalog-engine work sits on `spec-1-foundation` (PR 1) | Decide whether to merge PR 1 with it or split. |

## Next

Next module in build order: **`quote-approval`**. Spec first, as `AGENTS.md` requires.
