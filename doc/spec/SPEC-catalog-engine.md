# Spec: catalog-engine

Module id: `catalog-engine` · Depends on: `foundation` (done) · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: **BUILT on 2 Nov 2026** (approved the same day with the defaults for the four open questions). Review: [doc/checkpoints/catalog-engine-checkpoint.md](../checkpoints/catalog-engine-checkpoint.md); the CI half of criterion 7 is open until the last commit is pushed. Decisions: **slots from a template, one swap at a time, plain-sum pricing.**

## 1. Objective

Turn what a customer wants into a box the merchant can actually make, and say exactly why when it cannot be made. The engine
is pure code with no model in it: given the merchant's catalog, a box template, stock and the customer's requirements, it
decides **valid or blocked**, computes the **price in integer cents**, and **generates and revalidates alternatives**.

Why: the brief's rule is that code decides money, stock, permissions and state, and the model only interprets, proposes and
explains. This module is where "code decides" lives for everything about what can be sold and at what price. It is the
module `quote-approval` and `ai-intake` both depend on.

**Users of the module** (other code, not people): `ai-intake` (tools `read_catalog`, `validate_configuration`,
`calculate_quote`), `quote-approval` (prices a configuration into an immutable quote version), and the merchant portal
(a small read-only catalog view).

### The demo path this module must reproduce exactly (brief steps 3 and 4)

| Step | Input | Required result |
|---|---|---|
| A | 20 boxes: notebook, pen, **bottle**, branded card, packaging; no food; logo; under $40 per box | **Valid.** 35 USD per box ($12 + $3 + $13 + $2 + $5), 700 USD total. Needs 20 bottles, 24 in stock |
| B | The same configuration, raised to 30 boxes | **Blocked:** `INSUFFICIENT_STOCK` (bottle, need 30, have 24) |
| C | Alternatives for B | Exactly one valid swap offered: **desk organizer** instead of the bottle. Truffles are never offered (food). Every offered box is revalidated |
| D | 30 boxes with the organizer | **Valid.** $12 + $3 + $14 + $2 + $5 = **$36 per box, $1,080 total (108000 cents)**, computed in code |

All catalog and price figures are illustrative fixtures.

### Acceptance criteria
- Steps A to D above pass as automated tests, and the numbers come from code, not from a model or a table.
- The model can never cause a price: nothing in any input carries a payable amount; prices are read only from the catalog.
- Every reason a box cannot be made is a coded blocker, all reported together, in a fixed order.
- Alternatives are single swaps inside one slot, bounded, deterministic, and **each one passes full validation**.

## 2. Assumptions (correct me now or I proceed)

1. **A box is described by slots.** The merchant's `box_template` lists slots (notebook, pen, gift item, card, packaging); each
   slot takes exactly one product, chosen from that slot's allowed list. All slots are required in v1 (no optional slots).
2. **The template is merchant data, not code:** one row in `business_rules` with `key = 'box_template'`, with products named by
   **SKU**. No schema migration is needed.
3. **Pricing is a plain sum.** Per-box price = sum over slots of `unit_price_minor x slot quantity`; total = per-box x box count.
   No discounts, fees or tax in v1. One clearly marked function is the only place a future price rule could go.
4. **Budget is inclusive.** The requirement `maxPricePerBoxMinor` means "at most". The customer's "under $40" is
   interpreted by intake as at most 3999 cents; the engine does not guess.
5. **Stock check:** needed quantity = slot quantity x box count, summed per product across slots; available = `on_hand - reserved`.
   No safety overage. The reservation function re-checks stock atomically later; this check is advisory but must be correct.
6. **Dates are plain calendar dates** (`YYYY-MM-DD`), with no time zone. The earliest pickup date is `today + production_lead_days`
   calendar days (default `production_lead_days` from the merchant rule; if absent, 0). `today` is passed in; the engine never
   reads the clock.
7. **Logo requirement** is satisfied when at least one selected product comes from a slot marked `customization: "logo"`.
   Judging a logo file against print rules is advisory and belongs to `ai-intake`, not here.
8. **`min_order_quantity` is optional.** If the merchant rule exists, `boxCount` below it is blocked; if it does not, there is
   no minimum. The seed does not set one.
9. **The merchant is the unit of scope.** One merchant per call; the engine never mixes catalogs.
10. USD only; money is integer minor units (`lib/money.ts`); no floats anywhere.

## 3. Interfaces (the contract other modules build against)

All pure, all in `domain/catalog/`. Types sketched here; exact names are final once approved.

```ts
// What the merchant sells (a snapshot, loaded by the service layer)
type Product = { id: string; sku: string; name: string; category: string; unitPriceMinor: Cents; isFood: boolean; active: boolean };
type Slot = { id: string; label: string; quantity: number; allowedSkus: string[]; customization?: "logo" };
type Catalog = { products: Product[]; slots: Slot[]; rules: { minOrderQuantity?: number; productionLeadDays: number } };
type Stock = Record<string /* productId */, number /* available = on_hand - reserved */>;

// What the customer wants (constraints) and what is chosen (a configuration) are separate
type Requirements = { noFood: boolean; maxPricePerBoxMinor?: Cents; logoRequired: boolean; requestedPickupDate?: string };
type Configuration = { boxCount: number; selections: Record<string /* slotId */, string /* sku */> };

type Blocker =
  | { code: "UNKNOWN_PRODUCT"; slotId: string; sku: string }
  | { code: "INACTIVE_PRODUCT"; slotId: string; sku: string }
  | { code: "UNKNOWN_SLOT"; slotId: string }
  | { code: "SLOT_NOT_FILLED"; slotId: string }
  | { code: "PRODUCT_NOT_ALLOWED_IN_SLOT"; slotId: string; sku: string }
  | { code: "FOOD_NOT_ALLOWED"; slotId: string; sku: string }
  | { code: "INSUFFICIENT_STOCK"; sku: string; needed: number; available: number }
  | { code: "OVER_BUDGET"; perBoxMinor: Cents; maxMinor: Cents }
  | { code: "LOGO_NOT_COVERED" }
  | { code: "BELOW_MIN_QUANTITY"; boxCount: number; minimum: number }
  | { code: "INVALID_QUANTITY"; boxCount: number }
  | { code: "UNSUPPORTED_DATE"; requested: string; earliest: string };

validateConfiguration(input): { ok: true; priced: PricedConfiguration } | { ok: false; blockers: Blocker[] }
calculateQuote(validConfiguration, catalog): PricedConfiguration   // lines, perBoxMinor, boxCount, totalMinor, currency "USD"
proposeAlternatives(input, options?): { alternatives: Alternative[]; considered: number }  // valid single swaps only
catalogForModel(catalog): ModelCatalogView   // names, SKUs, categories, slots, food flags and prices; never stock counts or ids
```

Rules of the contract:
- `validateConfiguration` returns **all** blockers at once, ordered by a fixed rule (structure, product, constraint, stock, price,
  date), so a customer or model is told everything in one go. It never returns a price for a blocked box.
- `PricedConfiguration` carries its `lines` (slot, sku, name, unit price, quantity) so a quote can be reproduced and audited.
  Canonical JSON and the SHA-256 hash belong to `quote-approval`, not here.
- `Configuration` accepts only `boxCount` and `selections`. **Any other field is rejected** (strict schema), so an injected
  amount, discount or "charge $1" has nowhere to go.
- `proposeAlternatives` only swaps one slot's product for another allowed product of that slot, keeps everything else, and
  keeps a candidate only if `validateConfiguration` says valid.
  Order: smallest absolute change in per-box price first, then slot order, then the slot's allowed-list order, then SKU. Bounded:
  it considers at most (slots x allowed products) candidates and returns at most `limit` (default 5, maximum 20).
  The model may later rank or explain these; it cannot add to them.

## 4. Tech stack

No new dependencies. TypeScript strict, Zod 4 (already installed) for the strict schemas, Vitest. Pure domain code uses only
`lib/money.ts` and the standard library.

## 5. Commands

```
Unit tests:      npm run test                    # includes tests/catalog/**
DB tests:        npm run test:db                 # includes the catalog loader against real Postgres
Typecheck/lint:  npm run typecheck && npm run lint
Re-seed local:   npm run seed                    # after the fixture change (adds the box template)
```

## 6. Project structure

```
domain/catalog/
  types.ts            Product, Slot, Catalog, Stock, Requirements, Configuration, Blocker, PricedConfiguration
  schemas.ts          Zod: strict Configuration, Requirements, and the box_template rule shape
  validate.ts         validateConfiguration (all blockers, fixed order)
  price.ts            calculateQuote (the only place a price rule could ever go)
  alternatives.ts     proposeAlternatives (single swaps, revalidated, bounded, deterministic)
  model-view.ts       catalogForModel
  index.ts            public exports
services/catalog/
  load-snapshot.ts    loadCatalogSnapshot(db, merchantId): reads products, stock, business_rules; Zod-validates the template
app/merchant/catalog/  small read-only page: products, stock, template (cuttable)
supabase/seed/fixtures.ts   adds the box_template rule (SKUs; gift slot allows bottle, organizer and truffles)
tests/catalog/        unit tests per file + demo-path test
tests/db/catalog-load.test.ts
```

`domain/` imports nothing from Next.js, Supabase, Node or the network (a test enforces it).

## 7. Code style

```ts
// domain/catalog/validate.ts, style reference: pure, returns data, never throws for business outcomes
export function validateConfiguration(input: ValidationInput): ValidationResult {
  const blockers: Blocker[] = [
    ...checkStructure(input),
    ...checkProducts(input),
    ...checkConstraints(input),
    ...checkStock(input),
    ...checkBudget(input),
    ...checkDate(input),
  ];
  return blockers.length > 0
    ? { ok: false, blockers }
    : { ok: true, priced: calculateQuote(input.configuration, input.catalog) };
}
```

Conventions: named exports; no `any`; inputs are never mutated; every function is deterministic (same inputs, same output,
including order); anything time-dependent takes `today` as a parameter; a thrown error means a programmer bug or a malformed
snapshot, never a business outcome.

## 8. Testing strategy

| Level | What |
|---|---|
| Unit (Vitest) | Each blocker code, alone and in combination; stock summed across slots; the budget edge (equal to the maximum is valid, one cent over is blocked); date edge (earliest day valid, day before blocked); logo coverage; strict schema rejects extra fields |
| Demo path | Steps A to D, with exact cents |
| Properties | Seeded pseudo-random catalogs and configurations (no new dependency): total = per-box x count; per-box = sum of lines; every alternative is valid and differs from the original in exactly one slot; results do not depend on input array order; output is identical on repeat; candidate count never exceeds the bound |
| Boundary | `domain/catalog` imports nothing outside `lib/money`, `zod` and itself |
| Database | `loadCatalogSnapshot` against local Postgres: returns the seeded catalog, `available = on_hand - reserved`, a malformed or missing template raises a clear error, another merchant's rows are never returned |

Brief test rows owned here: *model proposes an unknown product ID (rejected before any quote)*; *no-food constraint with a food
substitute (substitute rejected, and never offered)*; *quantity exceeds component stock (blocked, every alternative
revalidated)*; *a message says to charge $1 or discount (server price unchanged, because there is no input for it)*.

## 9. Boundaries

- **Always:** compute money in integer cents with `lib/money.ts`; report every blocker; keep ordering deterministic; revalidate every
  alternative; keep `domain/` pure; run the unit tests before committing; keep blocker codes stable (other modules match on them).
- **Ask first:** adding a dependency; adding or changing a price rule; changing the template format; changing or adding a blocker
  code; re-seeding the hosted database (the fixture change adds a rule row).
- **Never:** take a price, discount or amount from any input; call a model; read the clock or the network inside `domain/`;
  mutate inputs; use floating point for money; offer a candidate that has not passed validation; return stock counts to the model.

## 10. Success criteria (testable)

- [x] Demo path A to D passes with exact numbers: 3500 and 70000 cents (valid, 20 boxes with the bottle); blocked with
      `INSUFFICIENT_STOCK` needed 30, available 24; alternatives exactly `[organizer]`; 3600 per box and 108000 total.
- [x] Every blocker code has a test; several blockers at once are reported together in the fixed order.
- [x] An unknown SKU, an inactive product, a product not allowed in its slot and a food product under `noFood` are each blocked
      and none is ever returned as an alternative.
- [x] `Configuration` with an extra field (price, discount, amount) is rejected by the strict schema.
- [x] Alternatives: single swap only, all valid, bounded (<= 20), deterministic and order-independent.
- [x] Stock needed is summed per product across slots (a product used in two slots counts twice).
- [ ] `domain/catalog` passes the purity test; typecheck, lint, unit, database and E2E tests green locally and in CI.
- [x] `loadCatalogSnapshot` returns the seeded merchant's catalog and template from real Postgres, and fails clearly on a bad template.
- [x] The read-only merchant catalog page shows products, stock and the template (cuttable; see cut order).

## 11. Task outline (becomes `tasks/catalog-engine/` after approval)

1. Types, strict schemas and the template format, with tests.
2. `validateConfiguration` and its blockers, one group at a time, test first.
3. `calculateQuote`, with the demo-path numbers.
4. `proposeAlternatives`, with the property tests and the demo-path alternatives.
5. `catalogForModel` and the purity test.
6. Seed fixture: `box_template` rule; re-seed local; `loadCatalogSnapshot` with its database tests.
7. Read-only merchant catalog page and its E2E test (cuttable).
8. Checkpoint: criteria review, hosted re-seed (with approval), record.

## 12. Open questions: resolved (approved with defaults, 2 Nov 2026)

1. **Budget wording:** "under $40" means at most $39.99. The engine treats `maxPricePerBoxMinor` as inclusive; intake sends 3999.
2. **Minimum order quantity:** the seed does **not** set one. The engine supports the rule when a merchant adds it.
3. **Hosted data:** re-seeding the hosted project is allowed in the final task, but I ask again immediately before doing it.
4. **Merchant catalog page:** kept, as the last and cuttable task before the checkpoint.
