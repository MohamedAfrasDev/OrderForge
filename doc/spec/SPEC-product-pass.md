# Spec: product-pass

Module id: `product-pass` · Depends on: `ai-intake` (built; PR 8 open, to be merged first) and every module before it · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: **DRAFT 3, 4 Nov 2026, awaiting your approval.** Draft 2 plus your three changes of 4 Nov: (1) the shop can **add and edit products**, (2) **email notifications** are in, (3) **AG Grid** is the library for the shop's data grids. Those three are real new behaviour, a new migration, new environment variables and a new dependency, so this module is now much larger than a screen pass (see section 11, the schedule and the cut order). Money, stock rules, quote rules, payments, jobs and the intake pipeline still do not change.

## 1. Objective

A person who has never heard of this project can open the site, order custom gift boxes by talking about what they need, understand every price and every PayPal step in plain words, always know where their order is and who is next, get emails at the moments that matter, and never lose their order. The shop owner opens one page, sees only what needs them, keeps the catalog up to date (add and edit products), answers a request, sends a price, confirms an order and prepares it, all without a technical step. One automated run proves the chain from the home page to "collected".

Why: every stage is built and tested alone, but nothing has run as one flow, and a first-time visitor falls into seams (checked on 4 Nov): the home page offers only "Merchant portal"; the order room prints raw states; the only way back to a request is the long link in the address bar; the PayPal hold is unexplained; the shop home is a list of links; the catalog page is read-only (products can only be changed by the seed script); and a request handed to the shop can be answered but not turned into a price except through the developer demo page.

**Users:** a first-time customer such as an office manager (not technical, wants a price and reassurance); the shop owner (small business, wants to know what needs them today).

### Design principles (the tests every screen must pass)

1. **One next step per screen:** one main button and a plain line saying what happens after it.
2. **The order builds itself:** a live "Your order so far" card beside the conversation; missing facts read "Tell us"; any line can be tapped and changed.
3. **Quick answers:** when the assistant needs one answer, tappable choices sit under the question; typing is optional.
4. **Say what PayPal will and won't do:** the hold, the shop's decision, what happens on yes and on no, in one short box next to the button.
5. **Always know where you are:** a thin progress strip and a plain headline on every customer page, naming who is next.
6. **Never lose the order:** the link is shown, copyable, mailable, and (if the customer gave an email) emailed.
7. **The shop sees only what needs it:** counts and one button each; data lives in grids; everything else under "More".
8. **Words a customer says:** sentence case, contractions, no jargon, no "successfully", no "please"; a fixed glossary is the only vocabulary on customer pages and in customer emails.

| Never shown to a customer | Shown instead |
|---|---|
| inquiry, specification | your request, your order so far |
| proposal, alternative | a box we suggest |
| quote, quote version, hash | your price |
| authorize / capture / void | PayPal sets the money aside / the shop is paid / the hold is released |
| reservation, stock hold | we're holding the items for you |
| job, worksheet | your order is being prepared; the shop's pick list |
| `CLARIFYING`, `REVIEW_REQUIRED`, `WAITING_MERCHANT`, any SKU or id | "We need one answer", "With the shop", "Waiting for the shop to confirm", product names |

### The demo path this module must reproduce

| Step | Action | Required result |
|---|---|---|
| A | A visitor opens `/` | They see what OrderForge is in one sentence and a primary action "Try it as a customer" to the demo store; "Shop sign in" is secondary. If the demo store does not exist the primary action is not shown (no dead link) |
| B | The customer writes their request (the store form also asks, optionally, for an email) | The conversation and "Your order so far" sit side by side (stacked on a phone); the card fills in as facts are read, each line with where it came from; unknown lines read "Tell us"; tapping a line edits it |
| C | The assistant needs one answer | The question shows with tappable choices decided by code from the open field: a number box with presets for the quantity, Yes / No for food and logo, a few budgets plus "Other", "Any day" plus a date picker for the pickup date; a tap records the customer's own confirmed answer and the assistant carries on. Typing still works |
| D | The customer sees suggested boxes | Each box lists its items with names and prices, the price per box and the total, a friendly line when something was swapped, and one button "Choose this box" |
| E | The customer reads their price | An itemised price (items, per box, number of boxes, total), how long the price is held, any conditions in plain words, and the PayPal box ("You won't be charged yet. PayPal sets aside $X. The shop reviews your order and, only if they accept, you're charged. If they say no, the hold disappears.") next to "Approve on PayPal" |
| F | The customer is anywhere in their order | A progress strip (Describe, Choose, Review price, Approve, Shop confirms, Pick up) marks done / current / still to come and a headline says what happens next and who it waits on; no raw state name anywhere; "Keep this page" shows the link with Copy and "Email it to me" (a `mailto:`) and says it is the only way back; if the customer gave an email, it also says the link was emailed |
| G | A request is handed to the shop | The customer sees "With the shop" and what to expect; the shop is emailed; the shop's Today shows "requests need a reply"; the shop opens it, reads the conversation and the order so far, and chooses **Build a quote** |
| H | The shop builds a quote | One screen: the customer's wishes at the top; the quantity; one choice per slot of the box (active products the template allows, stock shown); optional disclosed notes ("Needs artwork approval", "Production slot to confirm"); the system computes the price from the catalog (the shop cannot type a price); "Send price to customer" creates and publishes the quote through the existing services and emails the customer; a box that cannot be made is explained in plain words and not sent |
| I | The shop's daily work | Today shows counts (requests to answer, orders waiting for the shop's OK, orders to prepare), each with one button. Lists are AG Grids (sort, filter, keyboard use) with the action in a detail area; the pick list can be printed; replying has three one-tap starting phrases |
| J | The shop keeps the catalog | The catalog is an editable AG Grid: **edit** a product's name, category, price, food flag, active or not, and stock on hand by editing the cell; **add** a product (name, category, price, food, stock, and the slot or slots of the box it can go in). A refused change (a price that is not a price, stock below what is being held, deactivating the last product of a slot, a duplicate SKU) says why in plain words and the cell goes back; changing a price or deactivating a product never changes a quote that was already published or accepted |
| K | Emails go out at the moments that matter | **Customer** (if they gave an email): the request link when they start; their price is ready; the shop replied; the shop accepted or declined; their order is ready for pickup. **Shop:** a request was handed over; an order is waiting for their OK. Each is sent once however many times the trigger fires; a failing provider never blocks or rolls back anything; no email contains the customer's own words, only fixed text, names and amounts from the system |
| L | A customer completes the whole journey in one browser run (stand-in model, fake PayPal, emails captured not sent; labeled mocked) | From `/` to "collected"; a second run covers the handed-over path (shop builds a quote, the customer accepts); the strip, headline and the emails recorded at each step are right |
| M | The same pages at 390 px width | No horizontal scroll of the page on the home page, store page, order room (every stage) and the shop's Today and Build a quote (a grid may scroll inside itself); the main button of each page is visible without zooming |
| N | A wrong or revoked customer link | A calm "we couldn't find that request" page with a link home; the response stays a 404 and says nothing about whether the request exists |

### Acceptance criteria
- Steps A to N pass as automated tests (E2E on the local stack; pure logic, services and the outbox as unit and database tests), labeled mocked where the stand-in model, the fake PayPal or the fake email provider is involved. **No test and no CI run ever sends a real email.**
- The journey function is pure and total over every combination of states (table test). Quick replies are pure and decided by code, never by the model.
- A scan test walks the order room at every stage, and every customer email template, and finds no raw state name, SKU, id or forbidden word.
- The shop cannot set a quote price, a discount or a status: the quote builder takes only a quantity, a product per slot and the two fixed notes; the price comes from `createQuoteDraft`, which validates against live stock. Catalog edits change catalog data only, through strict validation, never a quote, a reservation or a payment.
- Emails never carry customer free text; each is sent at most once per event (dedupe key); a customer address is used only for that customer's own inquiry, capped per inquiry; sending is off unless configured, and the provider key is never printed, logged or committed.
- The existing merchant specs are updated for the grids by changing selectors, never by removing or weakening a check; payment and access tests stay green.

## 2. Assumptions (correct me now or I proceed)

1. **Branching.** PR 8 (`ai-intake`) is merged first; `product-pass` is built on a branch cut from `main` after that.
2. **One pure module owns the words and the stage.** `journeyOf` and the glossary live in `domain/journey`; components only draw what it returns. Email text comes from the same glossary.
3. **The strip has six segments:** Describe, Choose, Review price, Approve, Shop confirms, Pick up (mapping rules in the task list; Check belongs to Describe, Prepared to Pick up).
4. **Quick replies** are chosen by code from the open field and applied as the customer's own confirmed edit (`editRequirements`, source `customer_edit`), then the existing numbered message makes the assistant continue. Only fields the pipeline can block on get choices; other lines are edited by tapping them.
5. **The order room becomes one conversation layout**, with the quote, payment and order status sections below it in the order the customer meets them. Same services and server actions.
6. **Price and PayPal wording is accurate to the flow** (authorize at accept, the shop's decision captures or voids). No promised response time unless the shop sets one.
7. **Keep this page** is a small client component (Copy, `mailto:`); with an email on file the link is also emailed (step K). The link is already a credential in the address bar; it never goes into logs, audit rows or analytics.
8. **Build a quote** (service `buildQuoteForInquiry`, page `/merchant/inquiries/[id]/quote`): the shop must own the inquiry and it must be `REVIEW_REQUIRED`; `createQuoteDraft` validates and prices; `publishQuote` publishes (it sets the inquiry to `QUOTE_READY`); the two notes map to the existing `ARTWORK_ACCEPTANCE` and `PRODUCTION_SLOT_CONFIRMATION` conditions with fixed text; no typed price, no free-text condition.
9. **The shop edits the catalog (your change to open question 6).** Editable: name (1 to 120 characters), category (1 to 64), price (whole cents, 0 to 10,000,000), food flag, active, stock on hand (whole number, 0 to 1,000,000). **Not editable:** the SKU after creation (templates and quotes refer to it). **No delete:** a product is deactivated, so history stays intact. Rules enforced in a service (`catalog` write services, strict schemas, merchant ownership checked on the server for every call): stock on hand cannot go below what is being held (the database already enforces `reserved <= on_hand`; the refusal is translated into plain words); the last active product of a slot cannot be deactivated (no box could be made); a product is added with at least one slot of the box template it may go in, written to the `box_template` rule as the **last** step of adding (so a partial failure leaves an unsellable product, never a template pointing at a missing SKU). Changing a price or deactivating a product affects only quotes made afterwards: published and accepted quotes are snapshots. Each change is audited with the product id and the names of the fields changed, never the values of other people's data.
10. **Email is in (your change to open question 4).**
    - *Provider.* Sent through a small `EmailPort` with a real implementation that calls the provider's HTTP API with `fetch` (no email SDK), and a fake that records messages. **The provider and sender need your choice** (open question 4): the default is Resend, which needs an API key and a verified sender; until a domain is verified its test sender can deliver only to the account owner's address, so for a demo the customer's address must be that one. Gmail SMTP (needs the `nodemailer` dependency and an app password) can send to any address and is the alternative.
    - *New data (migration 0010, local first, hosted only after a fresh yes).* `inquiries.customer_email` (nullable text, lowercased, at most 254 characters, validated), and a `notifications` table (id, inquiry id, recipient kind `customer` or `shop`, kind, dedupe key unique, status `PENDING` / `SENT` / `FAILED` / `SKIPPED`, attempts, timestamps). The table stores no message text and no recipient address for the shop (resolved at send time from the shop owner's login).
    - *Triggers.* Derived from database state, not hooked inside the payments or fulfillment services (they do not change): a new step in the existing scheduled run enqueues the events whose state is true and not yet queued, using the dedupe key (for example `quote_ready:<quote id>`, `decision:<purchase id>`, `ready:<job id>`, `handed_over:<inquiry id>`, `awaiting_ok:<purchase id>`), then drains the queue; the actions that cause an event also drain immediately, best effort, so most emails go out within seconds.
    - *Limits and safety.* Email is optional on the store form with a plain line on what it is used for; at most 8 emails per inquiry; a failing send is retried up to 3 times by the scheduled run, then marked `FAILED`, and never blocks, rolls back or changes any order step; emails are fixed templates (plain text with a minimal HTML twin) filled with system data only (product names, amounts, dates, the customer's link), never customer free text or model output; the subject and body say it is a sandbox demo; the customer's address is not written to logs, audit rows or the model prompt.
    - *Local and tests.* With no provider configured, and always under test, only the recorded `SENT` row (fake provider) exists. A real send happens only on a configured deployment, and the first real test message goes to your own address after a fresh yes, recorded separately (real-email evidence).
11. **AG Grid (your change to open question 5).** Dependencies `ag-grid-community` and `ag-grid-react`, **Community edition only** (MIT; no Enterprise features, no licence key), exact versions pinned at least two weeks old (checked when installing; the newest releases are not used). A first task is a short spike to confirm it builds and tests under this repo's Next.js and React versions before anything depends on it. One shared `components/data-grid.tsx` wraps it (registers only the modules used, applies a theme built from the app's own colour variables with light and dark modes, sets accessible labels, takes plain data from the server page as props). **Grids** are for the shop's data lists: Requests, Orders to confirm, Jobs, Stock holds, Quote review, and the Catalog (editable). **Not grids:** the customer pages (the itemised price is a small static table), the order forms and detail areas, and the quote builder's slot choices (plain selects). Rows open a detail area below the grid that holds the existing forms, so every action keeps working as it does now. On a phone a grid scrolls inside itself; the page does not.
12. **The shop's Today** shows counts from existing reads under the shop's own session (row level security); one small service, `merchantOverview`. Catalog, stock holds, quote history and the developer pages sit under "More".
13. **Print and phrases are cuttable** (a print stylesheet and Print button on the pick list; three one-tap reply phrases).
14. **Sandbox honesty stays.** The sandbox banner stays. No claim about time saved, demand or accuracy is added anywhere, in the pages or in the emails.
15. **The chained tests** use the stand-in model, the local fake PayPal and the fake email provider (mocked). The hosted run of the same journey, with the real model, the real PayPal sandbox and a real email to your address, is a separate step after merge and deploy, needs your yes, and is recorded separately.

## 3. Interfaces

```ts
// domain/journey (pure)
journeyOf(input: { inquiry; quote: "NONE"|"PUBLISHED"|"EXPIRED"|"ACCEPTED"; payment: CustomerPaymentStatus | null; job: CustomerJobStatus | null }):
  { steps: Array<{ id; label; state: "done"|"current"|"upcoming"|"stopped" }>; current: number; headline: string; detail: string; waitingOn: "you"|"shop"|"nobody" }
// domain/intake (pure, new file)
quickRepliesFor(question: { field: BlockingField }, fields: RequirementsDoc): { kind: "number"|"choice"|"money"|"date"; choices: Array<{ label: string; edit: Record<string, unknown> }> }
// domain/catalog-edit (pure): strict schemas and the rules above as functions
productPatchSchema, newProductSchema; checkDeactivation(template, products, sku); checkStockChange(onHand, reserved)
// domain/notifications (pure)
eventsToQueue(state): Array<{ kind; recipient: "customer"|"shop"; dedupeKey }>; render(kind, data): { subject; text; html }
// services
merchantOverview(db, merchantId); quoteBuilderView(db, merchantId, inquiryId); buildQuoteForInquiry(db, actor, inquiryId, input, ctx)
addProduct(db, actor, input, ctx); editProduct(db, actor, productId, patch, ctx)          // codes: NOT_FOUND, INVALID_INPUT, DUPLICATE_SKU, STOCK_HELD, LAST_IN_SLOT
enqueueNotifications(db, ctx); drainNotifications(db, port: EmailPort, ctx); interface EmailPort { send(message): Promise<{ ok: boolean }> }
```

## 4. Database changes (one migration, needs approval with this spec)

`supabase/migrations/0010_notifications.sql`: `inquiries.customer_email text null` with a length and format check, the `notifications` table with a unique dedupe key and a check on status and kind, RLS on (service role only; the shop reads nothing from it), no change to any existing table's other columns or policies. Local first; hosted only after a fresh yes, with read-only checks before and after. Catalog editing needs **no** migration (the tables, constraints and policies already exist; writes go through the service role after the shop's session is verified on the server).

## 5. Structure

```
domain/journey/  domain/intake/quick-replies.ts  domain/catalog-edit/  domain/notifications/   (pure, with purity tests)
components/journey-strip.tsx, keep-page.tsx, customer-header.tsx, data-grid.tsx (AG Grid wrapper)
app/page.tsx  app/o/[token]/ (conversation layout, summary, quick replies, price and PayPal)  app/not-found.tsx
app/store/[slug]/ (optional email field)
app/merchant/ (Today; requests, orders, jobs, holds, quotes as grids with detail areas; catalog grid; Build a quote)
services/merchant/overview.ts  services/catalog/edit.ts  services/intake/merchant-quote.ts  services/notifications/{enqueue,drain}.ts
lib/email/ (port, fetch provider, fake)  lib/cron/ (a notify step)
supabase/migrations/0010_notifications.sql
e2e/journey.spec.ts  e2e/shop-quote.spec.ts  e2e/shop-catalog.spec.ts  e2e/notifications.spec.ts  (and the existing merchant specs, selectors updated)
```

New environment variables (all optional; sending is off without them): `EMAIL_PROVIDER` (`resend` or `smtp`), `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`. New dependencies: `ag-grid-community`, `ag-grid-react` (and `nodemailer` only if you choose SMTP).

## 6. Code style and testing

TypeScript strict, Tailwind and the existing shadcn button, the repo's patterns (pure domain with a purity test, services behind the shop's session, server actions verified on every call, audit without secrets). Tests first for every task.

- Unit: `journeyOf` over every combination; the glossary on every returned string and every email template; `quickRepliesFor`; the catalog edit rules (every refusal); `eventsToQueue` and `render`; the `mailto` builder.
- Database: overview counts and isolation; `buildQuoteForInquiry`; product add and edit (ownership, strict validation, duplicate SKU, stock below held, last product of a slot, template written last, published quotes unchanged after a price edit, audit); the outbox (dedupe under repeated and parallel runs, per-inquiry cap, retry then `FAILED`, a failing provider changes no order state).
- E2E: A to N, including the scan tests, AG Grid interaction (sort, filter, edit a cell, refusal reverts), and the two chained runs with the emails recorded.

## 7. Boundaries

- **Always:** keep wording in the pure modules; keep every page and email truthful about the sandbox and about what PayPal does; keep customer links, addresses and the provider key out of logs and the repo; keep catalog writes behind server-side ownership checks and strict schemas.
- **Ask first:** sending a real email (each new recipient kind, and the first real send), applying 0010 to the hosted database, setting the email variables on Vercel, any provider other than the one you choose, letting the shop enter a quote price, using an AG Grid Enterprise feature.
- **Never:** change money, stock rules, quote rules, payment, job or intake behaviour; put customer free text, model output or a secret in an email or a log; send a real email from a test or CI; show a raw state name, id or SKU to a customer; let a catalog edit change a published or accepted quote; promise a response time the shop has not set; add a claim about speed, savings or accuracy; turn the stand-in model on for a hosted site.

## 8. Success criteria (testable)

- [ ] A visitor with only the site address reaches the customer flow from the home page in one click; the shop sign-in stays reachable.
- [ ] `journeyOf` is pure and total over every combination, with the table test; the strip and headline are right at every stage of both chained runs.
- [ ] No raw state name, id, SKU or forbidden word appears to a customer at any stage or in any customer email (scan tests).
- [ ] The conversation and "Your order so far" appear together; a tapped quick reply records the customer's own confirmed answer and the assistant continues; typing still works.
- [ ] The price section is itemised and the PayPal box says exactly what is held, what the shop decides and what happens on yes and on no.
- [ ] "Keep this page" shows the link, copies it, builds the `mailto:` link, says it is the only way back, and says when the link was emailed.
- [ ] The shop's Today shows the three counts, isolated per shop; the lists are AG Grids with a detail area; the shop can build and send a quote from a handed-over request, priced by the system, and the customer can accept it.
- [ ] The shop can add a product and edit a product's name, category, price, food flag, active flag and stock; every refusal is explained and reverts the cell; published and accepted quotes are unchanged by a price or active edit; every change is audited.
- [ ] The listed customer and shop emails are queued once per event, sent through the port, retried then marked failed on provider errors without touching any order step, and contain no customer free text; no test sends a real email.
- [ ] The chained journey passes from `/` to "collected" and the handed-over journey from the handoff to an accepted quote (both mocked, with the recorded emails checked).
- [ ] No horizontal scroll of the page at 390 px on the listed pages; a wrong or revoked link gets the calm 404.
- [ ] Typecheck, lint, unit, database and E2E green locally and in CI; payment and access tests stay green; migration 0010 applied locally and, after a fresh yes, to hosted with checks before and after.
- [ ] The hosted run (real model, real PayPal sandbox, a real email to your own address) is done after merge and deploy, only after a fresh yes, and recorded separately.

## 9. Task outline (becomes `tasks/product-pass/` after approval)

0. **Spike:** install AG Grid Community, render one grid on one shop page, confirm build and an E2E test pass on this Next.js and React, pin the versions.
1. `domain/journey`: `journeyOf`, the glossary, the table and wording tests, the purity test.
2. The order room layout: header with headline and strip, raw status removed, sections in order, the scan test.
3. The conversation with the live "Your order so far" card and quick replies.
4. The price and PayPal sections and "Keep this page".
5. The home entry with its guard, the shared customer header, the calm not-found page.
6. The shared grid wrapper, `merchantOverview`, the shop's Today with "More", and the Requests grid with its detail area.
7. Build a quote (`quoteBuilderView`, `buildQuoteForInquiry`, page, tests).
8. The catalog: `domain/catalog-edit`, `addProduct` and `editProduct`, the editable grid and the add form, tests (no migration).
9. Email core: migration 0010 locally, `domain/notifications`, the outbox, `enqueueNotifications` and `drainNotifications`, the fake provider, the cron step, the optional email field on the store form, tests (mocked).
10. Email provider: the `fetch` implementation for the chosen provider, the variables, a guard that nothing sends without configuration; the first real send only after a fresh yes.
11. The other shop grids (Orders to confirm, Jobs, Stock holds, Quote review) with detail areas, and the existing merchant E2E specs updated.
12. Cuttable: the printable pick list and the three reply phrases.
13. The chained E2E runs and the 390 px checks.
14. Checkpoint: criteria against evidence, CI, then (after merge, deploy and fresh yeses) hosted 0010, the Vercel variables, the hosted run, recorded separately.

## 10. Open questions (defaults apply if you say "approve defaults", except question 4)

1. **Merge PR 8 first** and build this on a branch from `main`? Default: yes.
2. **Demo store link** on the home page from a code constant (`demo-gift-boxes`), shown only when that store exists? Default: yes.
3. **Keep this page** as copy plus `mailto:` plus the emailed link when an address was given? Default: yes.
4. **Email notifications: which provider and sender?** Needs your choice. Resend (default, no new dependency, needs an API key and a verified sender; delivers only to your own address until a domain is verified) or Gmail SMTP (adds `nodemailer`, needs an app password, delivers to any address). And the events listed in step K, with the customer's email optional on the store form: default yes.
5. **AG Grid scope:** the shop's data lists and the catalog as grids, the customer pages and forms not; Community edition only; a spike first. Default: yes.
6. **Product editing:** add and edit a product (name, category, price, food, active, stock), SKU fixed after creation, no delete (deactivate instead), a new product must be assigned to a slot, and catalog edits never change existing quotes. Default: yes.
7. **The shop's quote builder** limited to a quantity, a product per slot and the two fixed notes, the system pricing it. Default: yes.
8. **Six-segment strip** as in the task outline. Default: yes.
9. **390 px** as the one phone width checked. Default: yes.

## 11. Schedule and cut order (read this before approving)

The module is now about fifteen tasks. The submission deadline is 12 Nov 2026, 12:00 PST (13 Nov 01:30 Sri Lanka); the project's own schedule has 11 to 12 Nov for the video, text and final checks, so building should end around 10 Nov. That is feasible only if the work is cut in this order when time runs short, last item first: (1) task 11, the other shop grids; (2) task 12; (3) the real email provider (keep the outbox and the fake, say so); (4) task 8 beyond a price and stock edit; (5) task 9's non-essential emails (keep: the customer's link, the price ready, the shop's decision, and the shop's new request). The customer's journey, Build a quote and the chained tests (tasks 1 to 7, 13) are not cut. Payment and access tests failing on 9 Nov stops all feature work, as before.
