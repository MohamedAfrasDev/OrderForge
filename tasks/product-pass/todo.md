# Tasks: product-pass

Spec: [doc/spec/SPEC-product-pass.md](../../doc/spec/SPEC-product-pass.md) · Plan: [plan.md](plan.md)
Status: spec APPROVED 4 Nov 2026 (defaults for all nine open questions; Resend chosen as the email provider); task list APPROVED 4 Nov 2026; T0 to T5 built. Tick a box only after its Verify step passes. Every task is test first. Existing end-to-end specs for the shop pages are updated by changing selectors, never by removing or weakening a check.

## Phase A: prove the grid

- [x] **T0 AG Grid spike on a real page: the catalog as a read-only grid**
  - Acceptance: `ag-grid-community` and `ag-grid-react` (Community only, no licence key) installed at exact versions at least two weeks old, recorded in the
    plan. `components/data-grid.tsx` wraps the grid: registers only the modules used, builds its theme from the app's own colour variables for light and
    dark, sets an accessible label, takes plain rows and column definitions as props, and is a client component imported only by shop pages (the build
    output shows no AG Grid code in the customer routes). The catalog page shows the products in the grid (name, SKU, category, price, food, active, on hand,
    held), sortable and filterable, keyboard reachable; the existing catalog checks still pass against the grid's rows. At 390 px the page does not scroll
    sideways (the grid scrolls inside itself). `npm run build` succeeds.
  - Verify: `npm run build && npm run test:e2e -- e2e/catalog-page.spec.ts`
  - Files: `package.json`, `package-lock.json`, `components/data-grid.tsx`, `app/merchant/catalog/page.tsx`, `e2e/catalog-page.spec.ts`
  - Done 4 Nov 2026: `ag-grid-community` and `ag-grid-react` pinned at 36.2.0 (released 16 Sep; 36.3.0 came out the same day and was not used; npm reports no advisory for either). Registered modules: ClientSideRowModel, QuickFilter, TextFilter, NumberFilter, ColumnAutoSize, CellStyle (plus Validation in development only); sorting and keyboard movement are built in. The grid adds one chunk of about 250 KB gzipped, loaded by shop pages only (a test loads `/` and a store page and finds no AG Grid code). Boolean type guessing is switched off so a column shows its formatter's text. The catalog page now also shows On hand and Held. Five checks in `e2e/catalog-page.spec.ts` pass three runs in a row.
  - Depends on: none.

## Phase B: the customer's experience

- [x] **T1 `domain/journey`: `journeyOf`, the glossary, purity**
  - Acceptance: `journeyOf` is pure and total over every combination of inquiry status, quote state (`NONE`, `PUBLISHED`, `EXPIRED`, `ACCEPTED`), payment status
    (`NONE`, `PAYING`, `WAITING_MERCHANT`, `CHECKING`, `PAID`, `DECLINED`, `FAILED`, or null) and job status (`PREPARING`, `READY`, `COLLECTED`, `DELAYED`, or null):
    it returns the six steps (Describe, Choose, Review price, Approve, Shop confirms, Pick up) each `done`, `current`, `upcoming` or `stopped`, the current step,
    a headline, a one-sentence detail and who it waits on, matching the spec's mapping. A separately written expected table is checked against the function for
    every combination. A declined payment and an expired quote are `stopped` with their plain sentence. The glossary module holds every customer-facing word for
    state; a test scans every string the module can return for raw states, SKUs, ids and forbidden words ("successfully", "please", "quote", "authorize", "capture", "void",
    "inquiry"). A purity test limits `domain/journey` to itself, `domain/intake` types and `zod`, with no clock, environment or `Math.random`.
  - Verify: `npm run test -- tests/journey && npm run typecheck`
  - Files: `domain/journey/{journey,wording,index}.ts`, `tests/journey/{journey,wording,purity}.test.ts`
  - Depends on: none.

- [x] **T2 The order room layout: header, strip, headline, no raw state, the scan test**
  - Acceptance: the order room header shows the shop name, the progress strip and the headline from `journeyOf`; the raw `Status:` line is gone; the sections follow the
    order the customer meets them (conversation and order so far, boxes, price, payment, order status). Behaviour and server actions are unchanged. An end-to-end
    scan walks the page at every stage (request started, a question open, boxes shown, price published, accepted, payment authorized and waiting, paid and
    preparing, ready, collected, declined, handed to the shop) and finds no raw state name, SKU, id or forbidden word; the strip and headline are right at each stage.
  - Verify: `npm run test:e2e -- e2e/order-room-words.spec.ts e2e/intake-customer.spec.ts e2e/quote-accept.spec.ts e2e/payments-customer.spec.ts e2e/fulfillment-customer.spec.ts`
  - Files: `app/o/[token]/page.tsx`, `components/{journey-strip,customer-header}.tsx`, `e2e/order-room-words.spec.ts`, existing customer specs (selectors)
  - Done 4 Nov 2026. Scan scope as built: on the whole page, no raw state name, SKU, id or `Status:` line at any of the 12 stages (stalled assistant, open question, boxes, with the shop, price to review, price expired, accepted, waiting for the shop, declined, being prepared, ready, collected); the header (strip, headline, detail) is also checked against the full vocabulary list. The rest of the page (quote card, payment, conversation text) joins the vocabulary check in T4 and T3 when their wording is rewritten. The page title stays "Your request" (h1) with the headline as an h2, so existing selectors only needed `exact: true`.
  - Amended T1 while building this: `journeyOf` takes an optional `stalled` input (a message the assistant has not answered). Without it a failed first message left the header saying "We're reading what you wrote" forever. It matters only before a price and before the request is with the shop; it has its own wording and tests (1,600 combinations now).
  - Rule learned: customer-page specs must visit `/o/` from a private address (`x-forwarded-for`), or they use up the shared 60-a-minute budget of the other specs.
  - Depends on: T1.

- [x] **T3 The conversation with "Your order so far" and quick replies**
  - Acceptance: the conversation and the order-so-far card sit side by side on a desktop and stacked on a phone; each line shows its value, how sure we are and where it came
    from, unknown lines read "Tell us", and tapping a line edits it (the existing edit action). `quickRepliesFor(question, fields)` is pure and decided by code for each
    blocking field (a number with presets for the quantity; Yes / No for food and logo; a few budgets plus "Other"; "Any day" plus a date for the pickup date) and never
    offers a choice the edit schema would refuse. A tap records the customer's own confirmed answer through `editRequirements` and the assistant carries on through the
    existing numbered message; typing still works; a tap and a message at once never produce two replies. No raw state name appears.
  - Verify: `npm run test -- tests/intake/quick-replies.test.ts && npm run test:e2e -- e2e/intake-customer.spec.ts`
  - Files: `domain/intake/{quick-replies,index}.ts`, `tests/intake/quick-replies.test.ts`, `app/o/[token]/{intake-panels,intake-forms,intake-actions}.tsx`, `e2e/intake-customer.spec.ts`
  - Done 4 Nov 2026. As built: `quickRepliesFor` and `parseAnswer` (pure, 53 tests with the purity test); `services/intake/answer.ts` (`applyEdits`, `answerWithChoice`) with 9 database tests including a tap racing a message and five taps at once. A tap sends only the field and a position; the server recomputes the choices from the open question, so a stale or forged tap is refused. The order room shows the conversation beside "Your order so far" (below it on a phone, between the conversation and the box to write in), lines read "Tell us" until answered, every line opens a small editor, and the open question has its choices plus a typed box (number, dollars or date). The app's own "I updated my requirements (change N)." message shows as a quiet "You changed your order" note. The old "Change something" editor is gone.
  - Wording swept for the glossary: customer-facing "merchant" became "shop" in the notes and buttons ("Ask the shop to take over"), "Please" is gone from the customer messages and the message form, "Choose this box" replaces "Use this one", the conversation names its speakers (You, Assistant, the shop's name, Note). The scan covers the order so far, the open question, the boxes and the message form against the vocabulary list at every stage; the conversation's own messages and the quote and payment sections join it in T4. A banner that repeated the header's sentence was cut.
  - The replay fixture's code-written reply strings (14) were refreshed for the new wording ("ask the shop to take over"); the recorded model answers were not touched and the replay still compares everything exactly.
  - Depends on: T2.

- [x] **T4 The price and PayPal sections, and "Keep this page"**
  - Added 4 Nov 2026 (spec step D, which no earlier task covered): the suggested boxes list their items by name with each item's price, the price per box and the total, and say in a friendly line when something was swapped and why (for example "only 24 are left"), with "Choose this box" as the one button. T3 renamed the button and the wording only.
  - Acceptance: the quote section is an itemised price (each item with its price, the price per box, the number of boxes, the total), how long the price is held, and its
    conditions in plain words. **The terms sentence the customer accepts, and the hash behind it, are not changed or reworded**; the plain explanation is added beside it. The PayPal box states
    exactly what is held, that the shop decides, and what happens on yes and on no; "Approve on PayPal" is the one main button. "Keep this page" shows the link, copies it (with a
    visible select-all fallback), builds a `mailto:` link in the browser and says the link is the only way back; the server sends and stores nothing. Payment, decision and
    job sections use the glossary. The existing quote, payment and fulfillment customer checks pass with updated wording selectors.
  - Verify: `npm run test -- tests/keep-page.test.ts && npm run test:e2e -- e2e/quote-accept.spec.ts e2e/payments-customer.spec.ts e2e/fulfillment-customer.spec.ts`
  - Files: `components/{quote-card,payment-status,job-status,keep-page}.tsx`, `tests/keep-page.test.ts`, existing customer specs (selectors)
  - Done 4 Nov 2026. As built: the price section is "Your price" (an itemised table, price per box, number of boxes, total, how long it is held, "Things to know about this price", and "This is an updated price" instead of a version number). The terms the customer accepts and the hash behind them are untouched and tested word for word (`data-terms`). The accept button is "Accept this price"; the PayPal box (in the Payment section, showing the accepted total) says "You won't be charged yet. PayPal sets aside $X. The shop reviews your order and, only if they accept, you're charged. If they say no, the hold disappears." with one button, "Approve on PayPal" ("Continue on PayPal" to carry on). "Keep this page" sits under the header: the page's own address (never the notice after it), Copy link, and "Email it to me" (a `mailto:` built in the browser by `keepLinkMailto`, whose subject cannot be bent by the shop's name); copying sends nothing (tested). The suggested boxes list their items with prices, mark the swapped-in item and explain the swap (step D).
  - Customer wording rewritten and tested: every payment notice, payment status, order status and price-acceptance message (74 cases in `tests/customer-vocabulary.test.ts`) uses the glossary, says "shop", and ends in a full stop; the two assistant notes that said "quote" now say "price".
  - The scan now covers the whole order room except the terms and the shop's own condition notes, which are not ours to reword. Found and fixed while scanning: the Payment section said the same thing twice after returning from PayPal ("Thank you" now only confirms the approval), and the header and the order section repeated one sentence.
  - Still to come: the "emailed" half of keep-this-page (T10/T11). The conversation's own messages are not vocabulary-scanned (they carry the customer's words). Shop-side pages keep their own wording.
  - Depends on: T1.

- [x] **T5 The home page entry, the shared header and the calm not-found page**
  - Acceptance: `/` says what OrderForge is in one sentence, with "Try it as a customer" opening the demo store (a code constant for `demo-gift-boxes`, shown only when that store exists,
    so there is no dead link) and "Shop sign in" as the secondary link. A wrong, forged, expired or revoked customer link gets a calm "we couldn't find that request" page with a link
    home; the response stays a 404 and says nothing about whether the request exists. The sandbox banner stays and is smaller on a phone. No horizontal scroll of the page at 390 px.
  - Verify: `npm run test:e2e -- e2e/home.spec.ts e2e/access.spec.ts e2e/banner.spec.ts`
  - Files: `app/page.tsx`, `app/not-found.tsx`, `lib/demo-store.ts`, `e2e/home.spec.ts`, `e2e/{access,banner}.spec.ts` (selectors)
  - Done 4 Nov 2026. As built: `/` has one sentence ("Order custom gift boxes by describing what you need, see an exact price, and approve it on PayPal; you're charged only if the shop accepts."), "Try it as a customer" first and "Shop sign in" second, and three plain steps. The customer link is shown only when `findDemoStore` finds `demo-gift-boxes` (`lib/demo-store.ts`, equal to the seed's slug by test); otherwise the page says no store is open and offers only the sign-in. `app/not-found.tsx` is one calm page ("We couldn't find that", a way home) for every address that leads nowhere, so it cannot say whether a request exists; a revoked link and a link to nothing show identical text (tested). The sandbox banner is slimmer on a phone (30 px or less, tested at 390 px with no sideways scroll and the main button on screen).
  - Two honest notes. Forged, expired and malformed order links get a real 404 from the proxy; revoked and unknown ones need the database, so they are decided after the page has streamed (status 200, same calm content), as before this task. A separate shared header was not built: the not-found page carries the way home and no other page needed one.
  - Depends on: none.

## Phase C: the shop

- [ ] **T6 The shop's Today, the grid wrapper's detail pattern and the Requests grid**
  - Acceptance: `merchantOverview(db, merchantId)` returns the counts of requests to answer (handed-over inquiries plus held draft quotes), orders waiting for the shop's OK and
    orders to prepare, from reads under the shop's own session (row level security), isolated per shop (tested with two shops). The shop's home shows them as three counts with one
    button each, and "More" holds the catalog, stock holds, quote history and the developer pages. The grid wrapper gains the detail-area pattern (a row opens its detail below
    the grid). The Requests page is a grid (newest first, sortable and filterable) whose detail area holds the conversation, the order so far and the reply form, as today.
  - Verify: `npm run test:db -- tests/db/merchant-overview.test.ts && npm run test:e2e -- e2e/intake-merchant.spec.ts e2e/merchant-auth.spec.ts`
  - Files: `services/merchant/overview.ts`, `app/merchant/page.tsx`, `app/merchant/inquiries/page.tsx`, `components/data-grid.tsx`, `tests/db/merchant-overview.test.ts`, `e2e/intake-merchant.spec.ts`
  - Depends on: T0.

- [ ] **T7 Build a quote**
  - Acceptance: `quoteBuilderView` returns, for an inquiry the shop owns that is `REVIEW_REQUIRED`, the customer's wishes, the quantity (from the confirmed value) and, per slot, the active
    products the template allows with name, unit price and available stock; otherwise null. `buildQuoteForInquiry` takes only a quantity, a product per slot and the two fixed notes
    (`ARTWORK_ACCEPTANCE`, `PRODUCTION_SLOT_CONFIRMATION`, fixed text), refuses another shop's inquiry as not found and an inquiry not with the shop as an illegal state, calls
    `createQuoteDraft` (which validates and prices) and `publishQuote`, tells the customer with one note, and returns the price the catalog engine computed. A box the engine blocks
    returns its blockers in plain words and sends nothing. A price, discount, status or free-text condition has nowhere to go. A double submit makes one quote. The customer sees the quote
    in their order room and can accept it. The page `/merchant/inquiries/[id]/quote` is reached from the request's detail area.
  - Verify: `npm run test:db -- tests/db/intake-builder.test.ts && npm run test:e2e -- e2e/shop-quote.spec.ts`
  - Files: `services/intake/merchant-quote.ts`, `app/merchant/inquiries/[id]/quote/{page,actions,quote-form}.tsx`, `tests/db/intake-builder.test.ts`, `e2e/shop-quote.spec.ts`
  - Depends on: T6.

- [ ] **T8 Catalog editing: the rules and the services (no screen)**
  - Acceptance: `domain/catalog-edit` holds strict schemas (name 1 to 120, category 1 to 64, price whole cents from 0 to 10,000,000, food and active flags, stock on hand a whole number from 0 to
    1,000,000, a new product's SKU 1 to 64 from a safe character set) and the rules as pure functions: `checkDeactivation` (the last active product of a slot cannot be deactivated),
    `checkStockChange` (not below what is held), a new product must name at least one slot. `addProduct` and `editProduct` check the shop's ownership on the server for every call, refuse
    unknown keys, a duplicate SKU and the SKU of an existing product being changed, write the template **last** when adding, translate the database's `reserved <= on_hand` refusal into
    `STOCK_HELD`, and audit with the product id and the names of the fields changed. Tests: every refusal; a price edit and a deactivation leave a published and an accepted quote unchanged
    and the accept and reservation paths working; a failure after the product is inserted but before the template is written leaves an unsellable product and no broken template; another
    shop's product is not found; stock never goes below held under parallel edits. A purity test covers the new domain.
  - Verify: `npm run test -- tests/catalog-edit && npm run test:db -- tests/db/catalog-edit.test.ts`
  - Files: `domain/catalog-edit/{schemas,rules,index}.ts`, `services/catalog/edit.ts`, `tests/catalog-edit/{rules,purity}.test.ts`, `tests/db/catalog-edit.test.ts`
  - Depends on: none.

- [ ] **T9 The editable catalog grid and the add-product form**
  - Acceptance: the catalog grid edits name, category, price, food, active and stock on hand in place; each change goes through `editProduct` and updates the row, and a refusal shows its plain
    reason and puts the cell back (no silent failure). The SKU is read only. "Add a product" takes name, category, price, food, stock and at least one slot of the box it may go in, and the product
    appears in the grid and, for a Build a quote, in that slot's choices. Prices are shown and typed in dollars and cents and stored in whole cents. Keyboard editing works; no page scrolls sideways at
    390 px.
  - Verify: `npm run test:e2e -- e2e/shop-catalog.spec.ts e2e/catalog-page.spec.ts`
  - Files: `app/merchant/catalog/{page,actions,catalog-grid,add-product}.tsx`, `e2e/shop-catalog.spec.ts`
  - Depends on: T0, T8.

## Phase D: email

- [ ] **T10 Email data and pure rendering: migration 0010 (local), `domain/notifications`, the optional address**
  - Acceptance: `supabase/migrations/0010_notifications.sql` adds `inquiries.customer_email` (nullable, lowercased, at most 254 characters, a format check) and the `notifications` table (id, inquiry id,
    recipient kind, event kind, dedupe key unique, status `PENDING` / `SENT` / `FAILED` / `SKIPPED`, attempts, timestamps; no message text; row level security on with no policy for the shop or the customer),
    applied to the local database only; migration tests cover the checks, the unique key and the access. `domain/notifications` is pure: `eventsToQueue(state)` lists the events whose state is true
    (customer: request started with the link, price ready, shop replied, shop accepted or declined, ready for pickup; shop: request handed over, order waiting for the shop's OK) with their dedupe
    keys; `render(kind, data)` returns a subject, plain text and a minimal HTML twin from fixed text and system data only (product names, amounts, dates, the customer's link), in the glossary's words,
    saying it is a sandbox demo. A scan test over every template finds no customer free text, raw state, SKU, id or forbidden word, and escapes every inserted value. `startInquiry` takes an optional
    email, validated; the store form shows the optional field with a plain line on what it is used for.
  - Verify: `npm run test -- tests/notifications && npm run test:db -- tests/db/notifications-schema.test.ts tests/db/intake-start.test.ts && npm run test:e2e -- e2e/intake-customer.spec.ts`
  - Files: `supabase/migrations/0010_notifications.sql`, `domain/notifications/{events,render,index}.ts`, `services/intake/start.ts`, `app/store/[slug]/{start-form,actions}.tsx`, `tests/notifications/*`, `tests/db/notifications-schema.test.ts`
  - Depends on: none. (Larger than five files because of the tests.)

- [ ] **T11 The outbox: enqueue, drain, limits and failure handling, with a fake provider**
  - Acceptance: `enqueueNotifications(db, ctx)` reads current state (published quotes, merchant messages, decisions, ready jobs, handed-over inquiries, authorized payments awaiting a decision) and inserts the
    events from `eventsToQueue` with their dedupe keys, once however often or in parallel it runs. `drainNotifications(db, port, ctx)` sends each pending row through the `EmailPort` (the shop's address
    resolved at send time from the shop owner's login; the customer's from the inquiry), marks it `SENT`, retries a failure up to three times across runs, then marks it `FAILED`, never sends more than 8
    per inquiry (the rest `SKIPPED`), and `SKIPPED` when there is no address. A failing, slow or throwing provider changes no order step, no quote, no payment, no reservation and no job (a test runs the full
    pay and prepare path with a provider that always fails). The scheduled run gets a new notify step after the existing ones, which does not change the order or the result codes of the existing steps. The
    actions that cause an event also drain immediately, best effort. Nothing logs or audits an address, a link or a message body. The fake port records every message for tests.
  - Verify: `npm run test:db -- tests/db/notifications-outbox.test.ts && npm run test -- tests/cron-handler.test.ts tests/fulfillment-reconcile-handler.test.ts`
  - Files: `services/notifications/{enqueue,drain}.ts`, `lib/email/{port,fake}.ts`, `lib/cron/reconcile-handler.ts`, `tests/db/notifications-outbox.test.ts`
  - Depends on: T10.

- [ ] **T12 The Resend provider and its guards (no real send without a yes)**
  - Acceptance: a real `EmailPort` calls `POST https://api.resend.com/emails` with `fetch`, a timeout and the notification id as the idempotency key; it refuses any other host, never puts the key in a
    result, a log or an error, and treats any non-success as a failure for the outbox to retry. `RESEND_API_KEY`, `EMAIL_FROM` and `EMAIL_REPLY_TO` are optional in the environment schema (empty counts as
    unset) and documented in `.env.example`; with no key the app sends nothing and the outbox marks rows `SKIPPED`; under test and in CI the real port is never constructed. Tested against a local fake HTTP
    server (no real network): the request shape, the host lock, the timeout, a 4xx, a 5xx, a dropped connection and that the key is absent from every output. The first real send, to your own address, is
    a separate step after a fresh yes and is recorded separately.
  - Verify: `npm run test -- tests/email && npm run typecheck`
  - Files: `lib/email/resend.ts`, `lib/env-schema.ts`, `.env.example`, `tests/email/resend.test.ts`
  - Depends on: T11.

## Phase E: the rest of the shop (both cuttable)

- [ ] **T13 The other shop lists as grids: Orders to confirm, Jobs, Stock holds, Quote review**
  - Acceptance: each page lists its rows in a grid (sortable, filterable, newest first) and opens the existing forms and actions in its detail area; nothing about a decision, a move or a withdrawal
    changes. The existing end-to-end specs for payments (merchant), fulfillment (merchant), quote review and stock holds pass with updated selectors only, plus a test that each grid shows only the
    signed-in shop's rows. The 9 Nov tripwire tests (payments, access) are rerun after this task.
  - Verify: `npm run test:e2e -- e2e/payments-merchant.spec.ts e2e/fulfillment-merchant.spec.ts e2e/quote-review.spec.ts e2e/reservation-holds.spec.ts`
  - Files: `app/merchant/{decisions,jobs,holds,quotes}/page.tsx`, the matching four specs (selectors)
  - Depends on: T6. (Larger than five files.)

- [ ] **T14 Print the pick list and three one-tap reply phrases**
  - Acceptance: the job's pick list has a Print action and a print stylesheet that shows only the list; the request reply box offers three starting phrases that fill the text box (client only, nothing
    sent until the shop sends it).
  - Verify: `npm run test:e2e -- e2e/fulfillment-merchant.spec.ts e2e/intake-merchant.spec.ts`
  - Files: `app/merchant/jobs/job-forms.tsx`, `app/globals.css`, `app/merchant/inquiries/reply-form.tsx`, the two specs
  - Depends on: T6, T13 if done.

## Phase F: prove it and close

- [ ] **T15 The chained end-to-end runs and the 390 px checks**
  - Acceptance: one browser run goes from `/` to "collected" with the stand-in model, the fake PayPal and the fake email provider (all labeled mocked): start with an email, the order builds, a tapped quick
    reply, a box chosen, the price read, accepted, PayPal, the shop accepts, prepared, collected; the strip and headline are right and the emails recorded at each step are the expected ones, once each. A
    second run covers the handed-over path: handed over, the shop builds a quote, the customer accepts. At 390 px the home page, store page, order room at every stage, the shop's Today and Build a quote
    have no horizontal scroll of the page and show their main button without zooming.
  - Verify: `npm run test:e2e -- e2e/journey.spec.ts e2e/journey-phone.spec.ts`
  - Files: `e2e/journey.spec.ts`, `e2e/journey-phone.spec.ts`, `e2e/journey-support.ts`
  - Depends on: T3, T4, T5, T7, T11.

- [ ] **T16 Checkpoint**
  - Acceptance: every spec success criterion reviewed against current state with labeled evidence (mocked, local, CI, and later hosted and real-email); CI green on the last code commit; record in
    `doc/checkpoints/product-pass-checkpoint.md`; statuses updated in `SPEC.md` and this file. Applying 0010 to the hosted project, setting `RESEND_API_KEY`, `EMAIL_FROM` and `EMAIL_REPLY_TO` on Vercel, the first
    real email to your own address, and one hosted run of the full journey only after a fresh explicit yes each, with read-only checks before and after, recorded separately and labeled.
  - Verify: `npm run typecheck && npm run lint && npm run test && npm run test:db && npm run test:e2e`
  - Files: `doc/checkpoints/product-pass-checkpoint.md`, `doc/evidence/product-pass-hosted.md`, `SPEC.md`, `doc/spec/SPEC-product-pass.md`, `tasks/product-pass/todo.md`
  - Depends on: T15.
