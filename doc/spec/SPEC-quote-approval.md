# Spec: quote-approval

Module id: `quote-approval` · Depends on: `catalog-engine` (done) · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: **APPROVED on 2 Nov 2026 with the defaults for all five open questions.** Task list approved; build in progress (see tasks/quote-approval/todo.md). Target window: 3–4 Nov 2026 (brief schedule). Decisions to confirm: **one live quote per inquiry, hash computed in code and re-verified at every use, accept and publish as single database transactions, no new tables.**

## 1. Objective

Turn a valid box configuration into an **immutable, hash-bound quote** that the customer accepts as exactly what they will pay for, and make it impossible for a later change, a stale page or a forged request to turn that acceptance into a charge for something different.

Why: the brief's rule is that code decides money and state. `catalog-engine` decides *what can be made and at what price*. This module decides *what the customer actually agreed to*, and it is the evidence every later step (reservation, authorization, capture, worksheet) checks against.

**Users of the module:** the customer (reads the quote, accepts one exact version), the merchant (reviews and publishes a held quote, withdraws one), `ai-intake` (calls `createQuoteDraft` and `requestMerchantReview` as tools, never publishes or accepts), `reservation` and `payments` (call `verifyApprovalBinding`, read the accepted snapshot), `fulfillment` (builds the worksheet from the accepted snapshot).

### The demo path this module must reproduce (brief steps 4 and 5)

| Step | Action | Required result |
|---|---|---|
| A | Draft for 30 boxes with the organizer, no pending conditions | Draft with `totalMinor` 108000, `perBoxMinor` 3600, five lines; a stable 64-hex hash |
| B | Publish it | Status `PUBLISHED`; inquiry `QUOTE_READY`; any earlier live version `SUPERSEDED` |
| C | Customer accepts that version with the hash they saw | One approval and one purchase created together; quote `ACCEPTED` |
| D | Customer clicks accept twice, or two tabs race | Exactly one approval and one purchase; the second call returns the same ones |
| E | A newer version is published before payment starts | The accepted version becomes `SUPERSEDED`; `verifyApprovalBinding` refuses its approval |
| F | A draft with an unresolved mandatory commitment | Cannot be published by code; inquiry `REVIEW_REQUIRED` until the merchant publishes it |

### Acceptance criteria
- Steps A to F pass as automated tests; the numbers and the hash come from code.
- A quote is never created from anything but a configuration that `validateConfiguration` accepts at that moment; no input has a price field.
- The hash is deterministic, covers every term the customer agreed to, and is **recomputed from the stored row** before acceptance and again by `verifyApprovalBinding`, so a tampered row is detected.
- Acceptance is bound to the hash the customer saw. A different hash, a superseded, expired or withdrawn quote, or a quote that no longer validates is refused with a coded reason.
- Customers see only their own inquiry's published or accepted quotes; drafts are merchant-only. Enforced on the server.

## 2. Assumptions (correct me now or I proceed)

1. **One live quote per inquiry.** At most one version is `PUBLISHED` or `ACCEPTED` at a time. Publishing a newer version supersedes the live one, in the same transaction.
2. **Quotes are created only from valid configurations.** `createQuoteDraft` runs `validateConfiguration` (with `today` and a fresh stock snapshot passed in) and prices through `calculateQuote`. A blocked configuration returns the blockers and creates nothing.
3. **Pending conditions come in three kinds** (from the brief's "what must be resolved" table):
   - `PRODUCTION_SLOT_CONFIRMATION` and `ARTWORK_ACCEPTANCE`: may stay pending **if disclosed**; they are written onto the quote and into the hash.
   - `UNSUPPORTED_CUSTOMIZATION`: **mandatory**. A quote that carries it unresolved is held as a draft and the inquiry goes `REVIEW_REQUIRED`. Only an authenticated merchant can publish it. Their approval is recorded as a disclosed condition `MERCHANT_APPROVED_CUSTOMIZATION` (with their wording) plus an audit event, so the customer sees it and the hash covers it. Total price, products and quantities can never be pending: they are the validated lines.
4. **Hash input** is canonical JSON (keys sorted by code point, no whitespace, arrays in order, integers only, any float, NaN, `undefined` or `-0` is an error) of: schema tag `orderforge.quote.v1`, `merchantId`, `inquiryId`, `version`, `requirementVersionId`, `boxCount`, `perBoxMinor`, `totalMinor`, `currency`, `lines` (slot, sku, name, unit price, quantity, in template order), and `conditions` (code and text, sorted by code). Status and timestamps are excluded. SHA-256 is lowercase hex.
5. **Stored shape:** `quote_versions.lines` holds `{ boxCount, perBoxMinor, lines }`; `total_minor`, `currency`, `pending_conditions`, `requirement_version_id` use their existing columns. **No new tables.**
6. **Validity window:** a published quote can be accepted until `published_at + quote_validity_hours`, a merchant rule (default **72**). Expiry is evaluated at the moment of use; a scheduled sweep marks `EXPIRED` for tidiness. An `ACCEPTED` quote never expires here; payment and reservation timers belong to those modules.
7. **Acceptance re-checks the offer.** Before the transaction, `acceptQuote` rebuilds the configuration from the stored lines, loads the current catalog and stock, and requires `validateConfiguration` to return ok **with identical lines and total**. A price change or lost stock refuses the acceptance (`QUOTE_STALE` or the stock blockers) instead of honouring a quote the merchant can no longer make. This check is advisory for stock; `reservation` re-checks atomically.
8. **Terms text** shown and stored is generated in code from one template plus the disclosed conditions. The sentence "You are authorizing this exact proposal, subject to the merchant confirming the listed production conditions." is fixed. A generic "merchant confirmation" must never stand in for an unresolved commercial term.
9. **Changing a quote after acceptance** is allowed **only before any payment attempt has moved past `CREATED`**. After that, `quote-approval` refuses (`PAYMENT_STARTED`); `payments` owns the void-then-supersede path and will extend this through an ask-first change. A superseded accepted quote leaves its purchase behind; the `reservation` module releases holds whose quote is no longer `ACCEPTED`. This module never calls `reservation` (dependencies point one way).
10. USD only; money is integer minor units (`lib/money.ts`); no floats; no clock reads inside `domain/` (`now` is passed in).

## 3. Interfaces (the contract other modules build against)

Pure parts in `domain/quote/`; database parts in `services/quote/`. Types sketched here; exact names are final once approved.

```ts
type QuoteStatus = "DRAFT" | "PUBLISHED" | "ACCEPTED" | "SUPERSEDED" | "EXPIRED" | "WITHDRAWN";

type ConditionCode =
  | "PRODUCTION_SLOT_CONFIRMATION" | "ARTWORK_ACCEPTANCE"
  | "UNSUPPORTED_CUSTOMIZATION" | "MERCHANT_APPROVED_CUSTOMIZATION";
type Condition = { code: ConditionCode; text: string };          // text: 1..500 chars, plain text

// Pure
canonicalJson(value): string                                       // throws on non-canonical input (a bug, never a business outcome)
buildQuoteSnapshot(input): QuoteSnapshot                           // the exact object that is hashed
quoteHash(snapshot): string                                        // sha256 hex over canonicalJson (hash primitive lives in lib/hash.ts)
gateForPublish(conditions): { canAutoPublish: boolean; mandatoryUnresolved: Condition[] }
transition(from: QuoteStatus, event: QuoteEvent): QuoteStatus | { error: "ILLEGAL_TRANSITION" }   // the only transition function
isExpired(publishedAt, validityHours, now): boolean
renderTerms(snapshot): string

// Services (service-role client; every function checks access first)
createQuoteDraft({ inquiryId, configuration, requirements, requirementVersionId, conditions }): Result<{ quoteId; version; snapshot }>
requestMerchantReview(quoteId): Result<void>                       // inquiry -> REVIEW_REQUIRED (the intake tool)
publishQuote(quoteId, actor): Result<{ quoteId; hash }>            // auto only if the gate allows it; else merchant actor required
withdrawQuote(quoteId, merchantActor, reason): Result<void>
acceptQuote(verifiedInquiryId, quoteId, expectedHash): Result<{ approvalId; purchaseId }>   // idempotent
verifyApprovalBinding(approvalId): Result<{ snapshot }>            // for reservation, payments, fulfillment
readCustomerQuote(verifiedInquiryId): CustomerQuoteView | null     // PUBLISHED or ACCEPTED only
```

Coded results (stable; other modules match on them): `CONFIGURATION_BLOCKED` (carries the catalog blockers), `NOT_DRAFT`, `NOT_PUBLISHED`, `SUPERSEDED`, `EXPIRED`, `WITHDRAWN`, `HASH_MISMATCH` (the customer's hash is not the stored one), `QUOTE_TAMPERED` (stored hash is not the recomputed one), `QUOTE_STALE` (reprice differs), `MERCHANT_REVIEW_REQUIRED`, `MERCHANT_ONLY`, `PAYMENT_STARTED`, `NOT_FOUND` (also returned for another customer's quote, so existence is not leaked), `INVALID_INPUT` (strict schema failure, added in T5), `ILLEGAL_TRANSITION`. A thrown error means a programmer bug or a malformed row.

Rules of the contract:
- `createQuoteDraft` accepts a **strict** input schema: `inquiryId`, `configuration` (the strict catalog schema), `requirements`, `requirementVersionId`, `conditions`. Any other field, including an amount or discount, is rejected.
- `acceptQuote` takes the **customer's `expectedHash`**, never a price. The server recomputes the hash from the stored row, compares both, then runs one database transaction.
- Customer views never include merchant ids, stock counts, drafts, or other inquiries' data.

## 4. Database changes (one migration, needs approval with this spec)

`supabase/migrations/0005_quote_approval.sql`. The existing tables already hold what is needed; the migration adds **transactions and guards**, not tables:

1. **`publish_quote(p_quote_id, p_hash, p_now)`** (security definer, service role only): locks the inquiry row, checks `DRAFT`, refuses if an `ACCEPTED` live quote has a payment attempt past `CREATED` (`PAYMENT_STARTED`), supersedes the live quote, sets `PUBLISHED`, `quote_hash`, `published_at`, and moves the inquiry to `QUOTE_READY`.
2. **`accept_quote(p_quote_id, p_expected_hash, p_terms_text, p_now, p_validity_hours)`**: locks the quote and inquiry rows, checks `PUBLISHED`, unexpired, stored hash equals the expected hash; inserts the approval and the purchase; sets `ACCEPTED`. A second call for the same quote returns the existing ids.
3. **Partial unique index** `quote_versions (inquiry_id) where status in ('PUBLISHED','ACCEPTED')`: the database itself enforces "one live quote".
4. **Transition guard tightened.** Today `guard_quote_version_immutable` lets an `ACCEPTED` row move to any status, including back to `PUBLISHED`. The migration allows only `PUBLISHED → ACCEPTED | SUPERSEDED | EXPIRED | WITHDRAWN`, `ACCEPTED → SUPERSEDED`, and `DRAFT → PUBLISHED | WITHDRAWN`. This is a state-machine change, hence the explicit approval.
5. **`next_quote_version(p_inquiry_id)`** inside `create_quote_draft`: version numbers assigned under the inquiry row lock, so two drafts cannot take the same number.

Refinements found while building T4 (2 Nov; none changes a status, transition or condition code):
- The table check `status = 'DRAFT' or quote_hash is not null` would have made `DRAFT → WITHDRAWN` impossible, because a draft has no hash. It is replaced by `status in ('DRAFT','WITHDRAWN') or quote_hash is not null`.
- `PAYMENT_STARTED` is raised when the accepted quote's purchase has an attempt in any state **except** `CREATED`, `VOIDED`, `EXPIRED` or `FAILED`. A voided attempt therefore lets `payments` supersede after the void, as the brief's change-after-authorization flow needs.
- The hash is computed from the stored draft row at publish time, not at draft time, because the version number is assigned by the database.
- An accept racing a newer publish has two correct outcomes, both ending with exactly one live quote (the new one): accept loses with `SUPERSEDED`, or accept wins first and the publish then supersedes it and reports the invalidated purchase ids.
- The existing foundation test that published a second quote on an inquiry already holding one was changed to retire version 1 first, because of the new one-live-quote index.

Applying 0005 to the hosted Supabase project is a separate step and needs your explicit yes immediately before it happens.

## 5. Tech stack

No new dependencies. TypeScript strict, Zod 4 for strict schemas, Vitest, `node:crypto` (only in `lib/hash.ts`, never in `domain/`), Supabase RPC calls for the two transactions.

## 6. Commands

```
Unit tests:      npm run test                    # includes tests/quote/**
DB tests:        npm run test:db                 # includes the RPCs, races and RLS for quotes
Typecheck/lint:  npm run typecheck && npm run lint
Migrate local:   supabase db reset               # applies 0005 locally
E2E:             npm run test:e2e                # includes the quote journey
```

## 7. Project structure

```
domain/quote/
  types.ts            QuoteStatus, Condition, QuoteSnapshot, QuoteEvent, result and error codes
  schemas.ts          Zod: strict draft input, condition, stored lines shape
  canonical.ts        canonicalJson
  snapshot.ts         buildQuoteSnapshot, quoteHash (takes a hash function), renderTerms
  gate.ts             gateForPublish
  state.ts            transition (the only quote state machine), isExpired
  index.ts            public exports
lib/hash.ts           sha256Hex (node:crypto)
services/quote/
  create-draft.ts     validate, price, snapshot, store (RPC)
  publish.ts          gate, hash, RPC; merchant approval path
  accept.ts           access check, tamper check, revalidate, RPC
  verify-binding.ts   verifyApprovalBinding
  read.ts             readCustomerQuote, merchant reads
supabase/migrations/0005_quote_approval.sql
app/o/[token]/      quote card, terms, accept action (extends the existing order room)
app/merchant/quotes/  review queue: approve and publish, withdraw
tests/quote/        unit tests; tests/db/quote-*.test.ts
```

`domain/quote` imports only `domain/catalog` types, `lib/money` and `zod` (a purity test enforces it). Until `ai-intake` exists, the existing dev action in `app/merchant/dev` creates an inquiry, requirement version and draft so the demo and E2E can run.

## 8. Code style

```ts
// domain/quote/state.ts, style reference: one transition table, coded errors, no thrown business outcomes
const TABLE: Record<QuoteStatus, Partial<Record<QuoteEvent, QuoteStatus>>> = {
  DRAFT:      { PUBLISH: "PUBLISHED", WITHDRAW: "WITHDRAWN" },
  PUBLISHED:  { ACCEPT: "ACCEPTED", SUPERSEDE: "SUPERSEDED", EXPIRE: "EXPIRED", WITHDRAW: "WITHDRAWN" },
  ACCEPTED:   { SUPERSEDE: "SUPERSEDED" },
  SUPERSEDED: {}, EXPIRED: {}, WITHDRAWN: {},
};

export function transition(from: QuoteStatus, event: QuoteEvent): QuoteStatus | { error: "ILLEGAL_TRANSITION" } {
  return TABLE[from][event] ?? { error: "ILLEGAL_TRANSITION" };
}
```

Conventions: named exports; no `any`; inputs never mutated; deterministic output; `now` and `today` passed in; every state change goes through `transition` and writes an audit event (`quote_version`, `quote_hash`, `from`, `to` are already allowlisted).

## 9. Testing strategy

| Level | What |
|---|---|
| Unit (Vitest) | Canonical JSON (key order, nested, unicode, rejects floats, NaN, `undefined`, `-0`); hash golden value for the demo quote; hash changes when any single covered field changes and does not change with key order or excluded fields; gate rules per condition; the full transition table (every legal and every illegal pair); expiry edge (exact boundary); terms text contains each disclosed condition |
| Demo path | Steps A to F with exact cents and the golden hash |
| Properties | Seeded pseudo-random snapshots: hash is order-independent for keys, stable on repeat, and unique across different totals; `transition` never returns a state not in the table |
| Boundary | `domain/quote` imports nothing outside `domain/catalog`, `lib/money`, `zod` and itself |
| Database | RPCs against real Postgres: publish supersedes the live quote; the partial unique index rejects a second live quote; accept is idempotent; **two simultaneous accepts yield one approval and one purchase**; **accept racing a newer publish has one winner and the loser gets a coded refusal**; `PAYMENT_STARTED` refusal; trigger rejects `ACCEPTED → PUBLISHED`, any edit of a non-draft row's lines or hash, and approval updates or deletes; RLS: another merchant reads nothing; customer read function returns no drafts and no other inquiry's quote |
| E2E | Customer opens the link, sees the exact quote and terms, accepts; refresh shows accepted; an expired or superseded page offers no accept button; the merchant review queue publishes a held quote |

Brief test rows owned here: *model proposes an unknown product ID (rejected before any quote)*, covered at draft creation; *message says to charge $1 or discount (server price unchanged)*, because the draft input has no amount field and the strict schema rejects one; *quote changed after acceptance (old acceptance cannot authorize payment)*, covered by `verifyApprovalBinding` refusing a superseded quote, a tampered row and a hash that differs from the approval's. The *changed after authorization* row belongs to `payments`.

## 10. Boundaries

- **Always:** compute the hash in code from the stored row, never from client input; compare the customer's hash with the stored one; run publish and accept as single transactions; send every state change through `transition`; write an audit event per transition; keep `domain/` pure; check customer access on the server for every read and accept; keep error codes stable; run the unit tests before committing.
- **Ask first:** adding a dependency; changing the hash input or the canonicalization (it would invalidate every stored hash); changing a status, transition or condition code; adding a table or column; applying 0005 to the hosted database; changing the validity default; extending post-acceptance supersede (that is `payments`).
- **Never:** take a price, discount or amount from any input or from a model; publish a quote that carries an unresolved mandatory condition without a merchant actor; accept without comparing the customer's hash; edit a non-draft quote or an approval; call `reservation` or `payments` from this module; let a customer read a draft or another inquiry's quote; skip or remove a failing approval test without approval.

## 11. Success criteria (testable)

- [ ] Demo path A to F passes: total 108000, per box 3600, golden hash, one approval and one purchase after a double accept, supersede refuses the old approval.
- [ ] Canonical JSON and the hash pass their unit and property tests; the golden hash is committed.
- [ ] `transition` covers the full table; the database guard rejects every transition the table forbids, including `ACCEPTED → PUBLISHED`.
- [ ] A blocked configuration, an unknown SKU, and an input carrying an amount or discount each create no quote.
- [ ] The publish gate holds a quote with `UNSUPPORTED_CUSTOMIZATION` as a draft with the inquiry `REVIEW_REQUIRED`; only a merchant actor can publish it, and the merchant's wording appears in the quote and the hash.
- [ ] Acceptance refuses a wrong hash, a tampered row, an expired, superseded or withdrawn quote, a changed price and insufficient stock, each with its own code.
- [ ] Two simultaneous accepts, and an accept racing a publish, are proven safe by database tests.
- [ ] `verifyApprovalBinding` refuses an approval whose quote is superseded, tampered, or whose hash differs.
- [ ] RLS and server access tests pass: customers read only their own published or accepted quote; drafts are merchant-only.
- [ ] `domain/quote` passes the purity test; typecheck, lint, unit, database and E2E tests green locally and in CI.
- [ ] The order room shows the exact quote, conditions and terms, and the merchant review queue works (richer quote history is cuttable; the gate and the accept flow are not).

## 12. Task outline (becomes `tasks/quote-approval/` after approval)

1. Types, strict schemas, `canonicalJson`, `lib/hash.ts`, with tests.
2. Snapshot, `quoteHash`, `renderTerms`, golden hash, property tests.
3. Gate, transition table, expiry, with tests.
4. Migration 0005 locally, with the database tests for the transactions, races and guards.
5. `createQuoteDraft` and `publishQuote` services (including the merchant approval path).
6. `acceptQuote` (tamper check, revalidation, RPC) and `verifyApprovalBinding`.
7. Customer reads and the order-room quote card with accept action, and its E2E test.
8. Merchant review queue and its E2E test.
9. Checkpoint: criteria review, hosted migration (with approval), record.

## 13. Open questions (defaults apply if you just say "approved")

1. **Validity window:** 72 hours default, set by the merchant rule `quote_validity_hours`. Change it?
2. **Quote change before payment:** allowed until a payment attempt moves past `CREATED`, then refused here and handled by `payments`. Agree?
3. **Merchant approval of unsupported customization:** recorded as a disclosed condition plus an audit event, with no new table. Agree, or do you want a dedicated review table?
4. **Revalidation at accept:** a price or stock change refuses the acceptance and the customer gets a fresh quote. The alternative is to honour the published price until it expires. Which?
5. **Migration 0005:** may I write it and apply it to local Supabase on approval? Hosted stays a separate yes.
