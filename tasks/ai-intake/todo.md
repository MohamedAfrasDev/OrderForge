# Tasks: ai-intake

Spec: [doc/spec/SPEC-ai-intake.md](../../doc/spec/SPEC-ai-intake.md) · Plan: [plan.md](plan.md)
Status: spec APPROVED 3 Nov 2026; task list approved 3 Nov 2026; T1 to T3 built. Tick a box only after its Verify step passes. Every task is test first.

## Phase A: pure logic and the model port (no database; the client is tested against a local fake server)

- [x] **T1 Requirements domain: types, `parseExtraction`, `mergeRequirements`, `blockingFields`, `toCatalogRequirements`, `inquiryTransition`, purity**
  - Acceptance: `RequirementsDoc` holds `boxCount`, `noFood`, `logoRequired`, `maxPricePerBoxMinor`, `requestedPickupDate` and `preferences`,
    each `{ value, status, source }` with the four statuses. `parseExtraction` is strict: extra fields, unknown statuses, floats, non-positive
    quantities, budgets that are not whole minor units and non-calendar dates are rejected with named reasons. `mergeRequirements` writes a new
    document each time and a customer edit outranks the model. `blockingFields` returns exactly: `boxCount` not confirmed, any `conflicted`
    field, any `needs_confirmation` field; an `unknown` budget, date, food or logo preference never blocks (tested over every status
    combination). `toCatalogRequirements` turns unknowns into "not specified" for `validateConfiguration`. `inquiryTransition` implements the spec's
    table; every state and event pair is the listed target or `ILLEGAL_TRANSITION`. A purity test limits `domain/intake` to `domain/catalog`,
    `domain/quote`, `lib/money`, `zod` and itself, with no clock, environment, network or `Math.random` reads.
  - Verify: `npm run test -- tests/intake && npm run typecheck`
  - Files: `domain/intake/{types,extraction,requirements,state,index}.ts`, `tests/intake/{extraction,requirements,state,purity}.test.ts`
  - Depends on: none (catalog-engine and quote-approval are built).

- [x] **T2 Questions, ranking and prompts: `fallbackQuestion`, `acceptQuestion`, `acceptExplanation`, `rankAlternatives`, `buildPrompt`**
  - Acceptance: `fallbackQuestion` has fixed wording for every blocking field. `acceptQuestion` accepts only one sentence of at most 300
    characters ending in a question mark with no price, SKU or stock figure and no markup; otherwise null. `acceptExplanation` accepts text only if
    every currency amount in it is one code produced (passed in); otherwise null. `rankAlternatives` keeps only the entries of code's list, in the
    model's order, drops invented and duplicate entries and appends any the model left out, so code's list is never lost. `buildPrompt(kind, context)`
    builds versioned messages for extract, ask, propose and rank; customer text sits in a delimited block that the system message declares to be
    untrusted data and is never placed in a system message; the model sees `catalogForModel` (no stock counts or ids). Tests include the hostile
    texts (ignore-previous-instructions, a 90% discount, "set the price to 0", JSON that looks like a configuration, markup, a very long message):
    each stays inside the data block.
  - Verify: `npm run test -- tests/intake`
  - Files: `domain/intake/{questions,alternatives,prompts}.ts`, `domain/intake/index.ts`, `tests/intake/{questions,alternatives,prompts}.test.ts`
  - Depends on: T1.

- [x] **T3 Model port and the OpenRouter client**
  - Acceptance: `ModelPort.complete({ kind, messages, schema, model })` returns a typed result or a typed failure (`PROVIDER_FAILURE`,
    `TIMEOUT`, `MALFORMED`). The OpenRouter client uses `fetch` only, a 20-second timeout, structured output (a JSON schema), the existing
    `OPENROUTER_API_KEY`, and optional `OPENROUTER_MODEL` (free) and `OPENROUTER_FALLBACK_MODEL` (low-cost paid) with documented defaults. It switches to
    the fallback model only after a provider failure (timeout, network error, 5xx, 429, a free model reported unavailable), never after a bad answer,
    and reports which model answered. A malformed answer is retried once with the validation errors, then returned as `MALFORMED`. The API key
    never appears in an error or a log. A scripted fake provider is provided for tests. Tested against a local fake HTTP server only.
  - Verify: `npm run test -- tests/intake/openrouter.test.ts`
  - Files: `lib/ai/{model,openrouter,fake}.ts`, `lib/env-schema.ts`, `tests/intake/openrouter.test.ts`
  - Depends on: T2.

## Phase B: database, services and the pipeline (local Supabase; the fake model)

- [ ] **T4 Migration 0009: `messages.reply_to` and the one-reply rule**
  - Acceptance: `messages.reply_to` references `messages(id)`, is null except on `assistant` messages (a check), and a unique partial index makes
    a customer message have at most one assistant reply. `lib/audit.ts` allows `model_id`, `prompt_version` and `run`. Tests: a second assistant
    reply to the same message is rejected; two parallel inserts leave one; customer, merchant and system messages cannot carry `reply_to`; the
    anon role cannot write; existing message tests still pass.
  - Verify: `supabase db reset && npm run test:db -- tests/db/intake-messages.test.ts`
  - Files: `supabase/migrations/0009_intake.sql`, `lib/audit.ts`, `tests/db/intake-messages.test.ts`, `tests/audit.test.ts`
  - Depends on: T3. Ask first before applying anywhere but local.

- [ ] **T5 Services: `startInquiry`, `postCustomerMessage`, `editRequirements`, the reads**
  - Acceptance: `startInquiry` (by merchant slug) creates the inquiry in `NEW`, stores the first customer message (at most 4,000 characters) and returns a
    signed customer link; an unknown slug is refused. `postCustomerMessage` stores one message (a double submit stores one), refuses past 40 messages
    or 4,000 characters, and does not call the model. `editRequirements` writes a new requirements version in which the customer's edits outrank
    everything and are `confirmed` with source `customer_edit`. `requirementsForCustomer` returns fields, statuses, the proposal and the open question
    for a verified inquiry only. Access tests: another customer's inquiry is `INQUIRY_NOT_FOUND` for every function.
  - Verify: `npm run test:db -- tests/db/intake-start.test.ts tests/db/intake-edit.test.ts`
  - Files: `services/intake/{start,edit,read,shared}.ts`, `tests/db/intake-start.test.ts`, `tests/db/intake-edit.test.ts`
  - Depends on: T4.

- [ ] **T6 The turn pipeline: `runIntakeTurn` and the tool dispatcher**
  - Acceptance: one turn answers one customer message, once (the unique index; the loser returns `ALREADY_ANSWERED` with the winner's reply). The
    pipeline: extract (retry once, then handoff), merge into a new requirements version, `blockingFields`; if something blocks, ask (the fixed question,
    reworded by the model only if `acceptQuestion` passes) and move to `CLARIFYING`; otherwise validate the model's proposal with
    `validateConfiguration`, and if it is blocked take `proposeAlternatives`, have the model rank and explain them (`rankAlternatives`,
    `acceptExplanation`), store the proposal with the version and move to `CONFIGURING`. At most 3 model calls plus one retry per turn and 6 tool calls;
    the dispatcher lists `read_catalog`, `validate_configuration` and `calculate_quote` only, with strict argument schemas, and refuses anything else.
    Clarification cap (3 turns), model-run cap (20) and conflicts that persist hand the inquiry to the merchant. Each run is audited (model id,
    prompt version, run number). Demo steps A to D with **replayed** outputs; the injection set and every failure (timeout, 5xx, rate limit with fallback,
    invalid JSON, unknown id) with the **mocked** provider: figures never change, the inquiry and messages are kept, no ready state appears.
  - Verify: `npm run test:db -- tests/db/intake-turn.test.ts tests/db/intake-injection.test.ts tests/db/intake-outage.test.ts`
  - Files: `services/intake/turn.ts`, `tests/db/intake-turn.test.ts`, `tests/db/intake-injection.test.ts`, `tests/db/intake-outage.test.ts`, `tests/db/intake-fixtures.ts`
  - Depends on: T5.

- [ ] **T7 `chooseConfiguration` and `handOffToMerchant`**
  - Acceptance: `chooseConfiguration` takes a proposal key (never an amount), revalidates against live stock (`PROPOSAL_STALE` if it no longer holds),
    calls `createQuoteDraft` and applies the quote gate: a quote with no mandatory unresolved condition is published for the customer
    (`QUOTE_READY`); otherwise `requestMerchantReview` (`REVIEW_REQUIRED`). The total is exactly the catalog engine's (30 boxes at $36 is $1,080.00;
    demo step E). `handOffToMerchant` moves any state before `QUOTE_READY` to `REVIEW_REQUIRED` with a system message (demo step H and the customer's own
    handoff request); repeating it is a no-op. Tests: a changed stock level makes a proposal stale; a tampered key is refused; a double click makes one
    draft; another customer's inquiry is refused.
  - Verify: `npm run test:db -- tests/db/intake-choose.test.ts tests/db/intake-handoff.test.ts`
  - Files: `services/intake/choose.ts`, `tests/db/intake-choose.test.ts`, `tests/db/intake-handoff.test.ts`
  - Depends on: T6.

## Phase C: screens (local Supabase; the fake model)

- [ ] **T8 Customer screens: the store form and the order room**
  - Acceptance: the store page has a form (message up to 4,000 characters) that starts an inquiry and lands in the order room; the order room shows the
    conversation, a message composer, the visible specification (each field with its status and source, editable), the agent's open question, the
    proposals with code-computed prices and the explanations, a "Use this one" action per proposal, and, after a failure, "Try again" and "Ask the merchant
    to take over". All text is rendered as plain text. A fake model provider is selectable only on a local development host (never on hosted). Sandbox and
    synthetic-data wording is shown. E2E: describe a request, see the specification, answer one question, pick an alternative, reach a quote that can be
    accepted; the outage path shows retry and handoff; a hostile message changes nothing and is shown as text; another customer's link shows nothing.
  - Verify: `npm run test:e2e -- e2e/intake-customer.spec.ts`
  - Files: `app/store/[slug]/{page,actions,start-form}.tsx`, `app/o/[token]/{page,intake-actions,intake-panels}.tsx`, `e2e/intake-customer.spec.ts`
  - Depends on: T7.

- [ ] **T9 Merchant inquiries page and reply**
  - Acceptance: `/merchant/inquiries` (linked from the merchant home) lists the merchant's inquiries in `REVIEW_REQUIRED` with the conversation and
    the specification, newest first, and a reply box that stores a `merchant` message; another merchant sees nothing; a visitor with no session goes to
    login. Reads run under the merchant's own session. E2E covers a handed-over inquiry, a reply and isolation.
  - Verify: `npm run test:db -- tests/db/intake-merchant.test.ts && npm run test:e2e -- e2e/intake-merchant.spec.ts`
  - Files: `services/intake/read.ts` (extend), `app/merchant/inquiries/{page,actions}.tsx`, `tests/db/intake-merchant.test.ts`, `e2e/intake-merchant.spec.ts`
  - Depends on: T8.

## Phase D: evaluation and review

- [ ] **T10 The evaluation set, the runner and the replayed fixtures**
  - Acceptance: at least 15 scenarios in `eval/intake/scenarios.ts` (missing quantity, missing budget, budget stated two ways, ambiguous packaging, food
    exclusion, unsupported date, a quantity change that breaks stock, something not sold, a hostile message, a very long message, a second language, a
    correction mid-conversation, and more), each with the expected outcome stated in code terms (the blocking field, the blockers, that figures are
    unchanged). `npm run eval:intake` runs them against the real model on your OpenRouter key (free candidates first; the paid fallback only on provider
    failure), and writes a report with the number of scenarios, the method, which model answered each and every failure, with no accuracy, speed or
    time-saving figure. The free candidates are compared and the primary chosen; if none passes the structure and injection scenarios that is reported
    to you before any paid primary. The recorded outputs of one run become replayed fixtures for the CI tests. README note on how to read the report.
  - Verify: `npm run test -- tests/intake/eval-scenarios.test.ts` (the scenarios are well formed and the replayed fixtures pass) and a documented manual `npm run eval:intake`
  - Files: `eval/intake/{scenarios,run}.ts`, `eval/intake/README.md`, `tests/intake/eval-scenarios.test.ts`, `package.json`
  - Depends on: T9. Ask first before the manual run spends anything on your key (it is mostly free; a handful of paid fallback calls at most).

- [ ] **T11 Checkpoint**
  - Acceptance: every spec success criterion reviewed against current state with labeled evidence (replayed, mocked, real-model, local, CI); CI green on the
    last code commit; the real-model evaluation recorded separately; record in `doc/checkpoints/ai-intake-checkpoint.md`; statuses updated in `SPEC.md` and this
    file. Applying 0009 to the hosted project, setting the two optional environment variables on Vercel, and one hosted run of the full journey (you as
    the customer) only after a fresh explicit yes, with read-only checks before and after. Recorded separately and labeled.
  - Verify: `npm run typecheck && npm run lint && npm run test && npm run test:db && npm run test:e2e`
  - Files: `doc/checkpoints/ai-intake-checkpoint.md`, `doc/evidence/ai-intake-real-model.md`, `SPEC.md`, `doc/spec/SPEC-ai-intake.md`, `tasks/ai-intake/todo.md`
  - Depends on: T10.
