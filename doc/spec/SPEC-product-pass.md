# Spec: product-pass

Module id: `product-pass` · Depends on: `ai-intake` (built; PR 8 open, to be merged first) and every module before it · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: **DRAFT 2, 4 Nov 2026, awaiting your approval.** Rewritten after you asked for something a real, non-technical person would want to use, not a technical demo. It replaces the first draft, which only patched seams. Almost everything here is customer-facing design and wording. The one real piece of new behaviour is the shop's **Build a quote** screen, because without it a handed-over request is a dead end. Money, stock, quote rules, payments, jobs and the intake pipeline do not change.

## 1. Objective

A person who has never heard of this project can open the site, order custom gift boxes by talking about what they need, understand every price and every PayPal step in plain words, always know where their order is and who is next, and never lose it. The shop owner opens one page, sees only what needs them, and can answer a request, send a price, confirm an order and prepare it without any technical step. One automated run proves the chain from the home page to "collected".

Why: every stage is built and tested alone, but nothing has run as one flow, and a first-time visitor falls into seams (checked on 4 Nov): the home page offers only "Merchant portal"; the order room prints raw states (`Status: CONFIGURING`); the only way back to a request is the long link in the address bar; the specification and the conversation are separate blocks; the PayPal hold is unexplained; the shop home is a list of links; and a request handed to the shop can be answered but not turned into a price except through the developer demo page.

**Users:** a first-time customer such as an office manager or team lead (not technical, wants a price and reassurance); the shop owner (small business, wants to know what needs them today).

### Design principles (the tests every screen must pass)

1. **One next step per screen:** one main button and a plain line saying what happens after it.
2. **The order builds itself:** a live "Your order so far" card beside the conversation; missing facts read "Tell us"; any line can be tapped and changed.
3. **Quick answers:** when the assistant needs one answer, tappable choices sit under the question; typing is optional.
4. **Say what PayPal will and won't do:** the hold, the shop's decision, what happens on yes and on no, in one short box next to the button.
5. **Always know where you are:** a thin progress strip and a plain headline on every customer page, naming who is next.
6. **Never lose the order:** the link is shown, copyable and mailable, with an honest line that it is the only way back.
7. **The shop sees only what needs it:** counts and one button each; everything else under "More".
8. **Words a customer says:** sentence case, contractions, no jargon, no "successfully", no "please"; a fixed glossary (below) is the only vocabulary on customer pages.

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
| B | The customer writes their request | The conversation and "Your order so far" sit side by side (stacked on a phone); the card fills in as facts are read, each line with where it came from; unknown lines read "Tell us"; tapping a line edits it |
| C | The assistant needs one answer | The question shows with tappable choices decided by code from the open field: a number box with presets for the quantity, Yes / No for food and logo, a few budgets plus "Other", "Any day" plus a date picker for the pickup date; a tap records the customer's own answer and the assistant carries on. Typing still works |
| D | The customer sees suggested boxes | Each box lists its items with names and prices, the price per box and the total, a friendly line when something was swapped ("We swapped the steel bottle for the desk organizer: only 24 bottles are left"), and one button "Choose this box" |
| E | The customer reads their price | An itemised price (items, per box, number of boxes, total), how long the price is held, any conditions in plain words, and the PayPal box ("You won't be charged yet. PayPal sets aside $X. The shop reviews your order and, only if they accept, you're charged. If they say no, the hold disappears.") next to "Approve on PayPal" |
| F | The customer is anywhere in their order | A progress strip (Describe, Choose, Review price, Approve, Shop confirms, Pick up) marks done / current / still to come and a headline says what happens next and who it waits on; no raw state name appears anywhere; "Keep this page" shows the link with Copy and "Email it to me" and says it is the only way back |
| G | A request is handed to the shop | The customer sees "With the shop" and what to expect; the shop's Today shows "requests need a reply"; the shop opens it, reads the conversation and the order so far, and chooses **Build a quote** |
| H | The shop builds a quote | One screen: the customer's wishes at the top; the quantity; one choice per slot of the box (products the catalog allows, with stock shown); optional disclosed notes ("Needs artwork approval", "Production slot to confirm"); the price is computed by the system from the catalog (the shop cannot type a price); "Send price to customer" creates and publishes the quote through the existing services; a box that cannot be made (stock, budget) is explained in plain words and not sent |
| I | The shop's other daily jobs | Today shows counts for requests to answer, orders waiting for the shop's OK, and orders to prepare, each with one button; the pick list can be printed; replying has three one-tap starting phrases |
| J | A customer completes the whole journey in one browser run (stand-in model, fake PayPal; labeled mocked) | From `/` to "collected": start, order builds up, a tapped answer, a box chosen, price read, accepted, PayPal, shop accepts, prepared, collected; a second run covers the handed-over path (shop builds a quote, the customer accepts); the strip and headline are right at every step |
| K | The same pages at 390 px width | No horizontal scroll on the home page, store page, order room (every stage) and the shop's Today and Build a quote; the main button of each page is visible without zooming |
| L | A wrong or revoked customer link | A calm "we couldn't find that request" page with a link home; the response stays a 404 and says nothing about whether the request exists |

### Acceptance criteria
- Steps A to L pass as automated tests (E2E on the local stack; pure logic and services as unit and database tests), labeled mocked where the stand-in model or the fake PayPal is involved.
- The journey function is pure and total over every combination of states (table test). Quick-reply choices are pure and decided by code, never by the model.
- A scan test walks the order room at every stage and finds no raw state name, SKU, id or glossary-forbidden word.
- The shop cannot set a price, a discount or a status: the quote builder accepts only a quantity, a product per slot and the two fixed notes, and the price comes from `createQuoteDraft` (which validates against live stock).
- No migration, no new table, no new dependency, no new environment variable; no change to any state machine; the payment and access tests stay green.

## 2. Assumptions (correct me now or I proceed)

1. **Branching.** PR 8 (`ai-intake`) is merged first; `product-pass` is built on a branch cut from `main` after that.
2. **One pure module owns the words and the stage.** `journeyOf` (stage, strip, headline, who is next) and the customer glossary live in `domain/journey`; components only draw what it returns. Inputs are views the order room already reads.
3. **The strip has six segments:** Describe (request `NEW` or `CLARIFYING`, including checking the order so far), Choose (`CONFIGURING`, or `REVIEW_REQUIRED` with no quote), Review price (a published quote not yet accepted; `QUOTE_READY`; an expired quote stops here), Approve (accepted and payment `NONE`, `PAYING` or `FAILED`), Shop confirms (payment `WAITING_MERCHANT` or `CHECKING`; `DECLINED` stops here with "declined, you weren't charged"), Pick up (paid: being prepared, ready, delayed, collected). The eight moments in the journey diagram collapse to these six segments: Check belongs to Describe, Prepared to Pick up.
4. **Quick replies are chosen by code from the open field and applied as the customer's own edit** (`editRequirements`, source `customer_edit`, confirmed), then the existing numbered message makes the assistant continue. The model never sees a button; a tap is deterministic and tested. Only fields the pipeline can block on get choices (quantity, a conflicting budget, an ambiguous food, logo or date); other lines are edited by tapping them in the summary.
5. **The order room becomes one conversation layout** (conversation plus "Your order so far" side by side on a desktop, stacked on a phone), with the quote, payment and order status sections below it in the order the customer meets them. Behaviour is unchanged: the same services and server actions.
6. **Price and PayPal wording is accurate to the flow:** PayPal authorizes at accept, the shop's decision captures or voids, and the hold is released on decline. The box states exactly that and nothing more (no promised timings: "usually within a day" is shown only if the shop sets a response time; otherwise "the shop will answer here").
7. **Keep this page** is a small client component: Copy (with a visible select-all fallback) and a `mailto:` link built in the browser; the server sends and stores nothing. The link is already a credential in the address bar, so showing it adds no exposure; it never goes into logs, audit rows or analytics.
8. **The shop's Today** shows four counts from existing reads under the shop's own session (row level security): inquiries in `REVIEW_REQUIRED`, payments awaiting a decision, jobs not collected, and held draft quotes folded into "requests to answer". One small service, `merchantOverview`. Catalog, stock holds, quote history and the developer pages sit under "More".
9. **Build a quote is the one new behaviour** (service `buildQuoteForInquiry`, page `/merchant/inquiries/[id]/quote`): the shop must own the inquiry and it must be `REVIEW_REQUIRED`; the quantity defaults from the confirmed quantity; each slot offers the active products the template allows with available stock; the two notes map to the existing `ARTWORK_ACCEPTANCE` and `PRODUCTION_SLOT_CONFIRMATION` conditions with fixed text; `createQuoteDraft` validates and prices; `publishQuote` publishes it (the publish function sets the inquiry to `QUOTE_READY`); the customer gets a system note and sees the quote in their order room. A box the catalog engine blocks is shown with its blockers in plain words and nothing is sent. The shop cannot enter a price, discount or free-text condition.
10. **No notifications or email.** The customer's way back is the kept link; the shop's is the Today counts. Email to the customer and to the shop is named openly as the next step in the checkpoint and the submission text, not hidden.
11. **Print and phrases are cuttable.** The printable pick list (a print stylesheet and a Print button on the shop's job page) and the three one-tap reply phrases are the first things cut if time runs short; nothing else depends on them.
12. **Sandbox honesty stays.** The sandbox banner stays (smaller on a phone). No claim about time saved, demand or accuracy is added anywhere.
13. **The chained tests** use the stand-in model and the local fake PayPal (mocked). The hosted run of the same journey, with the real model and the real PayPal sandbox, is a separate step after merge and deploy, needs your yes, and is recorded separately.

## 3. Interfaces

```ts
// domain/journey (pure)
journeyOf(input: { inquiry; quote: "NONE"|"PUBLISHED"|"EXPIRED"|"ACCEPTED"; payment: CustomerPaymentStatus | null; job: CustomerJobStatus | null }):
  { steps: Array<{ id; label; state: "done"|"current"|"upcoming"|"stopped" }>; current: number; headline: string; detail: string; waitingOn: "you"|"shop"|"nobody" }
// domain/intake (pure, new file)
quickRepliesFor(question: { field: BlockingField }, fields: RequirementsDoc): { kind: "number"|"choice"|"money"|"date"; choices: Array<{ label: string; edit: Record<string, unknown> }> }
// services (shop session / service role as for the existing merchant services)
merchantOverview(db, merchantId): Promise<{ requestsToAnswer: number; paymentsToDecide: number; ordersToPrepare: number }>
quoteBuilderView(db, merchantId, inquiryId): Promise<{ wishes: CustomerSpecField[]; boxCount: number | null; slots: Array<{ id; label; choices: Array<{ sku; name; unitPriceMinor; available: number }> }> } | null>
buildQuoteForInquiry(db, actor: { userId; merchantId }, inquiryId, input: { boxCount: number; selections: Record<string,string>; notes: Array<"ARTWORK_ACCEPTANCE"|"PRODUCTION_SLOT_CONFIRMATION"> }, ctx):
  Result<{ quoteId; perBoxMinor; totalMinor }>   // codes: INQUIRY_NOT_FOUND, ILLEGAL_TRANSITION, INVALID_INPUT, CONFIGURATION_BLOCKED (with blockers)
```

## 4. Database changes

None. No migration, no new table, no new policy.

## 5. Structure

```
domain/journey/            journey.ts, wording.ts, index.ts (pure)
domain/intake/quick-replies.ts (pure)
components/journey-strip.tsx, keep-page.tsx (client), customer-header.tsx
app/page.tsx               the customer entry
app/o/[token]/             conversation layout, summary card, quick replies, price and PayPal sections
app/not-found.tsx          calm wording and a link home (status stays 404)
app/merchant/page.tsx      Today
app/merchant/inquiries/[id]/quote/{page,actions,quote-form}.tsx   Build a quote
services/merchant/overview.ts, services/intake/merchant-quote.ts
e2e/journey.spec.ts, e2e/shop-quote.spec.ts
tests/journey/, tests/db/ (overview, builder)
```

## 6. Code style and testing

TypeScript strict, Tailwind and the existing shadcn button, the repo's patterns (pure domain with a purity test, services behind the shop's session, server actions verified on every call). Tests first for every task.

- Unit: `journeyOf` over every combination against a separately written table; the glossary (no forbidden word in any string the module returns); `quickRepliesFor` for every blocking field and status; the `mailto` builder; purity tests for the new domain files.
- Database: `merchantOverview` counts and isolation; `buildQuoteForInquiry` (ownership, stage, blocked box, stale stock, notes mapped to conditions, price equal to the catalog engine's, the customer sees the quote, a double submit makes one quote).
- E2E: A to L, including the scan test at every stage and the two chained runs.

## 7. Boundaries

- **Always:** keep wording in the pure module; keep every page truthful about the sandbox and about what PayPal does; keep customer links out of logs.
- **Ask first:** a new dependency, a migration, an environment variable, sending any email, a notification channel, changing any state machine, letting the shop enter a price.
- **Never:** change money, stock, quote rules, payment, job or intake behaviour; show a raw state name, id or SKU to a customer; promise a response time the shop has not set; add a claim about speed, savings or accuracy; turn the stand-in model on for a hosted site.

## 8. Success criteria (testable)

- [ ] A visitor with only the site address reaches the customer flow from the home page in one click; the shop sign-in stays reachable.
- [ ] `journeyOf` is pure and total over every combination, with the table test; the strip and headline are right at every stage of both chained runs.
- [ ] No raw state name, id, SKU or forbidden word appears to a customer at any stage (scan test).
- [ ] The conversation and "Your order so far" appear together; a tapped quick reply records the customer's own confirmed answer and the assistant continues; typing still works.
- [ ] The price section is itemised and the PayPal box says exactly what is held, what the shop decides and what happens on yes and on no.
- [ ] "Keep this page" shows the link, copies it, builds the `mailto:` link and says it is the only way back; the server sends nothing.
- [ ] The shop's Today shows the three counts, isolated per shop, each with one button; the shop can build and send a quote from a handed-over request, priced by the system, and the customer can accept it.
- [ ] The chained journey passes from `/` to "collected" and the handed-over journey passes from the handoff to an accepted quote (both mocked).
- [ ] No horizontal scroll at 390 px on the listed pages; a wrong or revoked link gets the calm 404.
- [ ] Typecheck, lint, unit, database and E2E green locally and in CI; payment and access tests stay green; no migration, dependency or environment variable added.
- [ ] The hosted run of the same journey is done after merge and deploy, only after a fresh yes, and recorded separately (hosted).

## 9. Task outline (becomes `tasks/product-pass/` after approval)

1. `domain/journey`: `journeyOf`, the glossary, the table and wording tests, the purity test.
2. The order room layout: header with headline and strip, raw status removed, sections in the order the customer meets them, the scan test.
3. The conversation with the live "Your order so far" card and quick replies (`quickRepliesFor`, tap-to-edit lines, the actions).
4. The price and PayPal sections (itemised price, the PayPal box, plain conditions) and "Keep this page".
5. The home entry with its missing-store guard, the shared customer header, and the calm not-found page.
6. `merchantOverview` and the shop's Today with "More".
7. Build a quote: `quoteBuilderView`, `buildQuoteForInquiry`, the page and form, tests (the one new behaviour).
8. Cuttable: the printable pick list and the three one-tap reply phrases.
9. The chained E2E runs (customer from `/`; handed-over path) and the 390 px checks.
10. Checkpoint: criteria against evidence, CI, then (after merge, deploy and a fresh yes) the hosted run, recorded separately.

## 10. Open questions (defaults apply if you say "approve defaults")

1. **Merge PR 8 first** and build this on a branch from `main`? Default: yes.
2. **Demo store link** on the home page from a code constant (`demo-gift-boxes`), shown only when that store exists? Default: yes.
3. **Keep this page** as copy plus a `mailto:` link, no server email? Default: yes.
4. **No email or notifications** in this module, named openly as the next step? Default: yes.
5. **Six-segment strip** as in assumption 3? Default: yes.
6. **The shop's quote builder** limited to a quantity, a product per slot and the two fixed notes, with the system pricing it (no typed price, no free-text condition)? Default: yes.
7. **Printable pick list and reply phrases** are the first things cut if time runs short? Default: yes.
8. **390 px** as the one phone width checked? Default: yes.
