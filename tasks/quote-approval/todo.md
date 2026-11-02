# Tasks: quote-approval

Spec: [doc/spec/SPEC-quote-approval.md](../../doc/spec/SPEC-quote-approval.md) · Plan: [plan.md](plan.md)
Status: APPROVED 2 Nov 2026; T1 to T5 built (0005 applied to local only), T6 to T9 open. Tick a box only after its Verify step passes. Every task is test first.

## Phase A: pure logic (no database, no network)

- [x] **T1 Types, strict schemas, canonical JSON, sha256**
  - Acceptance: `QuoteStatus`, `Condition`, `QuoteSnapshot`, `QuoteEvent` and the result codes exist. A strict Zod schema for the
    draft input rejects any extra field (amount, discount, total). `canonicalJson` sorts keys by code point, emits no whitespace,
    keeps array order, and throws on floats, NaN, Infinity, `undefined` and `-0`. `lib/hash.ts` exposes `sha256Hex`.
  - Verify: `npm run test -- tests/quote/schemas.test.ts tests/quote/canonical.test.ts && npm run typecheck`
  - Files: `domain/quote/types.ts`, `domain/quote/schemas.ts`, `domain/quote/canonical.ts`, `lib/hash.ts`, `tests/quote/canonical.test.ts`
  - Depends on: catalog-engine.

- [x] **T2 Snapshot, quote hash, terms text**
  - Acceptance: `buildQuoteSnapshot` covers exactly the fields in spec assumption 4; `quoteHash` is stable, key-order independent,
    changes when any single covered field changes, ignores status and timestamps. Golden hash for the 30-box organizer quote
    (3600 per box, 108000) is committed. `renderTerms` contains the fixed sentence and every disclosed condition.
  - Verify: `npm run test -- tests/quote/snapshot.test.ts`
  - Files: `domain/quote/snapshot.ts`, `tests/quote/snapshot.test.ts`
  - Depends on: T1.

- [x] **T3 Publish gate, transition table, expiry, purity**
  - Acceptance: `gateForPublish` holds `UNSUPPORTED_CUSTOMIZATION` and lets the two disclosable conditions through; `transition`
    covers every status and event pair (legal ones per the spec table, all others `ILLEGAL_TRANSITION`); `isExpired` is correct
    at the exact boundary; a purity test limits `domain/quote` imports to `domain/catalog`, `lib/money`, `zod` and itself;
    seeded property tests for the hash and the table.
  - Verify: `npm run test -- tests/quote/gate.test.ts tests/quote/state.test.ts tests/quote/purity.test.ts`
  - Files: `domain/quote/gate.ts`, `domain/quote/state.ts`, `domain/quote/index.ts`, `tests/quote/gate.test.ts`, `tests/quote/state.test.ts`
  - Depends on: T2.

## Phase B: database

- [x] **T4 Migration 0005 and its database tests**
  - Acceptance: `publish_quote`, `accept_quote`, `create_quote_draft` (version under the inquiry lock) and the partial unique
    index exist; the transition guard allows only the spec's transitions (`ACCEPTED → PUBLISHED` now rejected); service-role
    only. Tests: publish supersedes the live quote; a second live quote is rejected; accept is idempotent; two simultaneous
    accepts give one approval and one purchase; accept racing a newer publish has one winner; `PAYMENT_STARTED` refusal; edits to a
    non-draft row's lines or hash and any approval update or delete are rejected; every status pair matches the TS table.
  - Verify: `supabase db reset && npm run test:db -- tests/db/quote-rpc.test.ts tests/db/quote-guards.test.ts`
  - Files: `supabase/migrations/0005_quote_approval.sql`, `tests/db/quote-rpc.test.ts`, `tests/db/quote-guards.test.ts`
  - Depends on: T3. Ask first before applying anywhere but local.

## Phase C: services

- [x] **T5 createQuoteDraft, requestMerchantReview, publishQuote, withdrawQuote**
  - Acceptance: a draft is created only from a configuration that validates (blockers returned, nothing stored otherwise); an
    unknown SKU or an input with an amount is rejected before any quote; prices come from `calculateQuote`; the gate holds a quote
    with an unresolved mandatory condition (inquiry `REVIEW_REQUIRED`); only a merchant actor publishes it, adding
    `MERCHANT_APPROVED_CUSTOMIZATION` with their wording; every transition writes an audit event; demo steps A, B and F pass.
  - Verify: `npm run test:db -- tests/db/quote-draft-publish.test.ts`
  - Files: `services/quote/create-draft.ts`, `services/quote/publish.ts`, `tests/db/quote-draft-publish.test.ts`, `tests/quote/fixtures.ts`
  - Depends on: T4.

- [ ] **T6 acceptQuote and verifyApprovalBinding**
  - Acceptance: acceptance recomputes the hash from the stored row and compares it with the customer's; refuses `HASH_MISMATCH`,
    `QUOTE_TAMPERED`, `NOT_PUBLISHED`, `SUPERSEDED`, `EXPIRED`, `WITHDRAWN`, `QUOTE_STALE` (price change) and the stock blockers;
    another customer's quote returns `NOT_FOUND`; a double accept returns the same approval and purchase; `verifyApprovalBinding`
    refuses a superseded quote, a tampered row or a differing hash (brief row: old acceptance cannot authorize payment). Demo steps C, D, E.
  - Verify: `npm run test:db -- tests/db/quote-accept.test.ts`
  - Files: `services/quote/accept.ts`, `services/quote/verify-binding.ts`, `tests/db/quote-accept.test.ts`
  - Depends on: T5.

## Phase D: screens and review

- [ ] **T7 Customer quote card in the order room**
  - Acceptance: `readCustomerQuote` returns only the inquiry's own `PUBLISHED` or `ACCEPTED` quote (never a draft); `/o/[token]`
    shows lines, totals, disclosed conditions, terms and an accept action bound to the shown hash; refresh after accepting shows
    the accepted state; superseded or expired quotes show no accept button; sandbox banner stays visible.
  - Verify: `npm run test:db -- tests/db/quote-reads.test.ts && npm run test:e2e -- e2e/quote-accept.spec.ts`
  - Files: `services/quote/read.ts`, `app/o/[token]/page.tsx`, `app/o/[token]/actions.ts`, `tests/db/quote-reads.test.ts`, `e2e/quote-accept.spec.ts`
  - Depends on: T6.

- [ ] **T8 Merchant review queue**
  - Acceptance: a signed-in merchant lists held drafts for their own inquiries only, approves and publishes one with their wording,
    or withdraws one with a reason; another merchant sees nothing; the dev action creates demo inquiries and drafts until intake exists.
  - Verify: `npm run test:e2e -- e2e/quote-review.spec.ts`
  - Files: `app/merchant/quotes/page.tsx`, `app/merchant/quotes/actions.ts`, `app/merchant/dev/` (extend), `e2e/quote-review.spec.ts`
  - Depends on: T5. Quote history display is cuttable; the gate and publish action are not.

- [ ] **T9 Checkpoint**
  - Acceptance: every spec success criterion reviewed against current state with labeled evidence; CI green on the last code
    commit; record in `doc/checkpoints/quote-approval-checkpoint.md`; statuses updated in `SPEC.md` and this file. Applying 0005
    to the hosted project only after a fresh explicit yes.
  - Verify: `npm run typecheck && npm run lint && npm run test && npm run test:db && npm run test:e2e`
  - Files: `doc/checkpoints/quote-approval-checkpoint.md`, `SPEC.md`, `doc/spec/SPEC-quote-approval.md`, `tasks/quote-approval/todo.md`
  - Depends on: T7, T8.
