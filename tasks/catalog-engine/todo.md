# Tasks: catalog-engine

Spec: [doc/spec/SPEC-catalog-engine.md](../../doc/spec/SPEC-catalog-engine.md) · Plan: [plan.md](plan.md)
Status: BUILT, all tasks ticked (CI green on the last commit). Tick a box only after its Verify step passes. Every task is test first.

## Phase A: pure engine (no database, no network)

- [x] **T1 Types, strict schemas and the template format**
  - Acceptance: `Product`, `Slot`, `Catalog`, `Stock`, `Requirements`, `Configuration`, `Blocker`, `PricedConfiguration` exist as types.
    A Zod schema for `Configuration` is **strict** (an extra field such as `unitPriceMinor`, `discount` or `total` is rejected).
    A schema for the `box_template` rule requires a non-empty slot list, unique slot ids, integer quantity >= 1, a non-empty
    duplicate-free `allowedSkus`, and an optional `customization` of exactly `"logo"`. `Requirements` has `noFood`,
    optional `maxPricePerBoxMinor`, `logoRequired`, optional `requestedPickupDate` (`YYYY-MM-DD`).
  - Verify: `npm run test -- tests/catalog/schemas.test.ts && npm run typecheck`
  - Files: `domain/catalog/types.ts`, `domain/catalog/schemas.ts`, `tests/catalog/schemas.test.ts`
  - Depends on: foundation.

- [x] **T2 calculateQuote**
  - Acceptance: per-box price is the sum of `unitPriceMinor x slot quantity`; total is per-box x `boxCount`; the result carries
    its lines (slot, sku, name, unit price, quantity); integer cents throughout; overflow throws rather than losing precision.
    Demo numbers: 1200+300+1400+200+500 = 3600 per box and 108000 for 30; with the bottle 1200+300+1300+200+500 = 3500 and 70000 for 20.
  - Verify: `npm run test -- tests/catalog/price.test.ts`
  - Files: `domain/catalog/price.ts`, `tests/catalog/price.test.ts`
  - Depends on: T1.

- [x] **T3 validateConfiguration: structure and product blockers**
  - Acceptance: `UNKNOWN_SLOT`, `SLOT_NOT_FILLED`, `UNKNOWN_PRODUCT`, `INACTIVE_PRODUCT`, `PRODUCT_NOT_ALLOWED_IN_SLOT`,
    `INVALID_QUANTITY` (non-integer or < 1) are each produced alone and together; an unknown SKU is rejected before any price
    exists (brief test row); a valid structure returns `{ ok: true, priced }`; inputs are not mutated.
  - Verify: `npm run test -- tests/catalog/validate-structure.test.ts`
  - Files: `domain/catalog/validate.ts`, `tests/catalog/validate-structure.test.ts`
  - Depends on: T1, T2.

- [x] **T4 validateConfiguration: constraint blockers**
  - Acceptance: `FOOD_NOT_ALLOWED` (a food product under `noFood`, brief test row), `LOGO_NOT_COVERED` (logo required and no
    selected product in a `customization: "logo"` slot), `BELOW_MIN_QUANTITY` (only when the merchant rule exists),
    `UNSUPPORTED_DATE` (requested earlier than `today + productionLeadDays`; the earliest day is valid, the day before is not;
    month and year ends and leap days correct; `today` is a parameter, never read from the clock).
  - Verify: `npm run test -- tests/catalog/validate-constraints.test.ts`
  - Files: `domain/catalog/validate.ts`, `domain/catalog/dates.ts`, `tests/catalog/validate-constraints.test.ts`, `tests/catalog/dates.test.ts`
  - Depends on: T3.

- [x] **T5 validateConfiguration: stock and budget, and the full ordering**
  - Acceptance: `INSUFFICIENT_STOCK` with `needed` and `available` (needed = slot quantity x box count, summed per product across
    slots, so a product in two slots counts twice); `OVER_BUDGET` (equal to the maximum is valid, one cent over is blocked);
    all blockers are returned together in the fixed order (structure, product, constraint, stock, price, date); a blocked box
    never carries a price. Demo path A (valid, 3500 and 70000), B (blocked: bottle, needed 30, available 24) and D (valid, 3600 and 108000).
  - Verify: `npm run test -- tests/catalog/validate-stock-budget.test.ts tests/catalog/demo-path.test.ts`
  - Files: `domain/catalog/validate.ts`, `tests/catalog/validate-stock-budget.test.ts`, `tests/catalog/demo-path.test.ts`, `tests/catalog/fixtures.ts`
  - Depends on: T4.

- [x] **T6 proposeAlternatives**
  - Acceptance: only single swaps inside one slot, to another allowed product of that slot; every candidate passes
    `validateConfiguration`; a food product is never offered under `noFood`; order is smallest absolute per-box price change, then
    slot order, then allowed-list order, then SKU; at most `limit` (default 5, maximum 20) results, and at most slots x allowed
    products considered; identical output on repeat and when input arrays are shuffled; demo path C returns exactly the desk organizer.
    Property tests with a seeded pseudo-random generator (no new dependency).
  - Verify: `npm run test -- tests/catalog/alternatives.test.ts`
  - Files: `domain/catalog/alternatives.ts`, `tests/catalog/alternatives.test.ts`, `tests/catalog/random.ts`
  - Depends on: T5.

- [x] **T7 Model view, purity test and public exports**
  - Acceptance: `catalogForModel` returns names, SKUs, categories, slots, food flags and prices but no stock counts and no
    internal ids; `domain/catalog/index.ts` exports the public surface; a test fails if any file in `domain/catalog` imports
    anything other than `lib/money`, `zod` or another file in the module (no Next.js, Supabase, Node or network).
  - Verify: `npm run test -- tests/catalog/model-view.test.ts tests/catalog/purity.test.ts && npm run lint`
  - Files: `domain/catalog/model-view.ts`, `domain/catalog/index.ts`, `tests/catalog/model-view.test.ts`, `tests/catalog/purity.test.ts`
  - Depends on: T6.

### Checkpoint A
`npm run typecheck && npm run lint && npm run test` green; demo path A to D reproduced in unit tests; purity test green.
Review with the human before phase B.

## Phase B: data

- [x] **T8 Seed template and loadCatalogSnapshot**
  - Acceptance: `supabase/seed/fixtures.ts` gains a `box_template` rule (slots notebook, pen, gift, card, packaging, by SKU; the
    gift slot allows the bottle, the organizer and the truffles; the card slot is `customization: "logo"`); `loadCatalogSnapshot(db, merchantId)`
    reads products, stock and business rules for that merchant only, derives `available = on_hand - reserved`, and Zod-validates
    the template; a missing or malformed template raises a clear error; `npm run seed` stays idempotent; the full unit, database
    and E2E suites still pass; the README's seed description gets one line.
  - Verify: `npm run seed` (local) then `npm run test:db -- tests/db/catalog-load.test.ts && npm run test && npm run test:e2e`
  - Files: `supabase/seed/fixtures.ts`, `services/catalog/load-snapshot.ts`, `tests/db/catalog-load.test.ts`, `README.md`
  - Depends on: T7. Needs Docker and the local Supabase. **No hosted write.**

### Checkpoint B
Loader proven against real Postgres; whole suite green; CI green after the push.

## Phase C: page and review

- [x] **T9 Read-only merchant catalog page (cuttable)**
  - Acceptance: `/merchant/catalog` (merchant session required, re-checked on the server) lists products with price, food flag and
    available stock, and shows the box template; read-only (no writes); a signed-out visitor is redirected; E2E covers both.
  - Verify: `npm run build && npm run test:e2e`
  - Files: `app/merchant/catalog/page.tsx`, `e2e/catalog-page.spec.ts` (plus a link from the merchant home)
  - Depends on: T8.

- [x] **T10 Checkpoint: criteria review and hosted re-seed**
  - Acceptance: every success criterion in spec section 10 is ticked or explained in `doc/checkpoints/catalog-engine-checkpoint.md`;
    the hosted re-seed (adds one rule row) is done **only after a fresh explicit OK** and checked read-only afterwards; `SPEC.md`
    status updated; next module in build order is `quote-approval`.
  - Verify: the checks listed in the record, re-run against current state.
  - Files: `doc/checkpoints/catalog-engine-checkpoint.md`, `doc/spec/SPEC-catalog-engine.md`, `SPEC.md`, `tasks/catalog-engine/todo.md`
  - Depends on: T9 (or T8 if T9 is cut).
