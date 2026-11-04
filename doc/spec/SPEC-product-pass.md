# Spec: product-pass

Module id: `product-pass` · Depends on: `ai-intake` (built; PR 8 open, to be merged first) and every module before it · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: **DRAFT, 4 Nov 2026, awaiting your approval.** Added at your request, after the question "does this feel like an end-to-end product?" The capability map had no separate UI module (each module built its own screens); this is the pass that makes those screens read as one product. It adds **no new business logic**: money, stock, quotes, payments, jobs and the intake pipeline do not change.

## 1. Objective

A first-time visitor, with nothing but the site address, can start as a customer, see where they are in the whole journey at every moment, never lose their request, and finish; and the merchant can see at a glance what needs them. One automated test walks the entire chain in a browser to prove it.

Why: every stage is built and tested alone, but nothing has ever run the whole chain as one flow, and the product has seams a visitor falls into (checked on 4 Nov): the home page has only a "Merchant portal" button, so a customer cannot find the store; the order room prints raw states (`Status: CONFIGURING`); the only way back to a request is the long link in the address bar; and the merchant home is a list of links with no sign of what is waiting.

**Users:** a first-time customer (a judge or a fresh tester), the merchant.

### The demo path this module must reproduce

| Step | Action | Required result |
|---|---|---|
| A | A visitor opens `/` | They see what OrderForge is and a primary action "Try it as a customer" that opens the demo store; the merchant portal is a secondary link. If the demo store does not exist, the primary action is not shown (no dead link) |
| B | The customer is anywhere in their order room | A journey strip names the seven steps (Describe, Choose, Accept, Pay, Merchant confirms, We prepare it, Pick it up), marks done / current / still to come, and a plain headline says what happens next and who it waits on. No raw state name appears anywhere on the page |
| C | A request goes to the merchant, a payment is declined, a payment needs a retry, a quote expired | The strip and headline say so in plain words (for example "Waiting for the merchant", "Declined: you were not charged", "Your quote expired"), never a code |
| D | The customer wants to come back later | The order room shows "Keep this page": the link with a copy button, an "email it to myself" action (a `mailto:` link built in the browser; the server sends nothing) and a plain line saying that anyone with the link can open the request and that it is the only way back |
| E | The merchant opens their home page | Each area shows what is waiting: inquiries handed over, quotes held for review, payments awaiting a decision, jobs to prepare, as counts; zero reads "nothing waiting"; each is a link to its page |
| F | A customer completes the whole journey in one browser run (stand-in model, fake PayPal; labeled mocked) | From `/` to "collected": start, specification, one question answered, alternative picked, quote accepted, pay, merchant accepts, job prepared, customer sees "collected"; the strip is right at every step |
| G | The same pages at a phone width (390 px) | No horizontal scroll on the home page, store page, order room (every stage) and merchant home; the main action of each page is visible without zooming |
| H | The customer's link is wrong or the request is gone | A calm "we could not find that request" page that points back to the home page, not a bare 404 |

### Acceptance criteria
- Steps A to H pass as automated tests (E2E against the local stack; the journey function as unit tests), labeled mocked where the fake PayPal or the stand-in model is involved.
- The journey function is pure and total: every combination of inquiry, quote, payment and job state maps to one headline and one current step (a table test over all combinations).
- No page shows a raw state name (`CONFIGURING`, `REVIEW_REQUIRED`, `WAITING_MERCHANT`, a SKU or an id) to a customer. A test scans the order room at every stage.
- No change to any money, stock, quote, payment, job or intake logic, no migration, no new table, no new dependency, no new environment variable.

## 2. Assumptions (correct me now or I proceed)

1. **Branching.** PR 8 (`ai-intake`) is merged first; `product-pass` is built on a branch cut from `main` after that. (The spec branch is stacked on the PR 8 branch only so the spec can be reviewed now.)
2. **One pure function names the journey.** `journeyOf({ inquiry, quote, payment, job })` in `domain/journey` returns the seven steps with `done | current | upcoming | stopped`, the current step, a headline and a one-sentence detail. Inputs are the views the order room already reads (`inquiry.status`, the customer quote view, `CustomerPaymentView`, `CustomerJobView`). It owns all customer-facing state wording; the components only draw it.
3. **The seven steps** and when each is current:

   | Step | Current when |
   |---|---|
   | 1 Describe your order | inquiry `NEW` or `CLARIFYING` |
   | 2 Choose your box | inquiry `CONFIGURING`, or `REVIEW_REQUIRED` with no quote yet (headline says the merchant has it) |
   | 3 Accept your quote | a published quote is not yet accepted (including `QUOTE_READY`); an expired quote stops here with "expired" |
   | 4 Pay with PayPal | quote accepted and payment `NONE`, `PAYING` or `FAILED` |
   | 5 Merchant confirms | payment `WAITING_MERCHANT` or `CHECKING`; `DECLINED` stops here: "declined, you were not charged" |
   | 6 We prepare it | payment `PAID` and the job `PREPARING` or delayed (or not yet created) |
   | 7 Pick it up | job `READY`; `COLLECTED` marks all seven done |

4. **Plain words come from the journey function** and the existing customer message modules; the raw `Status:` line is removed from the order room header and replaced by the headline.
5. **The home page** shows the demo store's entry only when `getPublicMerchant` finds the seeded slug `demo-gift-boxes` (a code constant, no new environment variable). The merchant portal link stays, as a secondary action.
6. **Keep this page** is a small client component: copy to clipboard (with a visible fallback to select the text), and a `mailto:` link with the link in the body. The server sends no email and stores nothing; the page says plainly that the link is the only way back. The link is already a credential in the address bar, so showing it adds no new exposure; it is never put in logs, audit rows or analytics.
7. **Merchant counts** come from existing reads under the merchant's own session (row level security): inquiries in `REVIEW_REQUIRED`, held drafts, payments awaiting a decision, jobs not collected. One small service, `merchantOverview`, runs the four counts; no new table or view.
8. **No notifications.** Email or push to the merchant is out of scope (it is in the brief's cut order). Counts on the home page are the whole mechanism.
9. **Not-found page.** A wrong or revoked customer link keeps its real 404 status and no information about whether the request exists; only the wording and a link home change.
10. **Sandbox wording** stays on every page, unchanged. No claim about time saved, demand or accuracy is added.
11. **The chained test** (`e2e/journey.spec.ts`) uses the stand-in model and the local fake PayPal, so it is labeled mocked. The hosted run of the same journey, with the real model and the real PayPal sandbox, is a separate step after merge and deploy, needs your yes, and is recorded separately.

## 3. Interfaces

```ts
// domain/journey (pure; imports only itself and types)
type StepState = "done" | "current" | "upcoming" | "stopped";
type JourneyInput = { inquiry: InquiryStatus; quote: "NONE" | "PUBLISHED" | "EXPIRED" | "ACCEPTED";
  payment: "NONE" | "PAYING" | "WAITING_MERCHANT" | "CHECKING" | "PAID" | "DECLINED" | "FAILED" | null;
  job: "PREPARING" | "READY" | "COLLECTED" | "DELAYED" | null };
type Journey = { steps: Array<{ id: string; label: string; state: StepState }>; current: number;  // 0-based; steps.length when all done
  headline: string; detail: string; waitingOn: "you" | "merchant" | "nobody" };
journeyOf(input: JourneyInput): Journey

// services/merchant/overview.ts (merchant session client)
merchantOverview(db, merchantId): Promise<{ inquiries: number; heldQuotes: number; paymentsToDecide: number; jobsOpen: number }>
```

## 4. Database changes

None. No migration, no new table, no new policy.

## 5. Structure

```
domain/journey/            journey.ts, index.ts (pure)
components/journey-strip.tsx, keep-page.tsx (client), plain wording reused from existing customer-message modules
app/page.tsx               the entry for customers
app/o/[token]/page.tsx     header headline, strip, keep-page; raw status removed
app/not-found.tsx          calm wording and a link home (status stays 404)
app/merchant/page.tsx      the overview counts
services/merchant/overview.ts
e2e/journey.spec.ts        the chained run and the phone-width checks
tests/journey/             unit tests for journeyOf (table over all combinations), purity test
```

## 6. Code style and testing

TypeScript strict, Tailwind and the existing shadcn button, the repo's patterns (pure domain with a purity test, services behind the merchant's session, server actions verified on every call). Tests first for every task.

- Unit: `journeyOf` over every combination (a separately written expected table, as for the other state machines), purity test for `domain/journey`, `mailto` link builder.
- Database: `merchantOverview` counts and isolation (another merchant's rows never counted).
- E2E: A, B, C, D, E, G, H and the chained run F; the order-room scan for raw state names at each stage.

## 7. Boundaries

- **Always:** keep wording in the pure function; keep every page truthful about the sandbox; keep customer links out of logs.
- **Ask first:** a new dependency, a migration, an environment variable, sending any email, a notification channel, changing any state machine.
- **Never:** change money, stock, quote, payment, job or intake behaviour; show a raw state name, id or SKU to a customer; add a claim about speed, savings or accuracy; turn the stand-in model on for a hosted site.

## 8. Success criteria (testable)

- [ ] A visitor with only the site address can reach the customer flow from the home page in one click; the merchant portal remains reachable.
- [ ] `journeyOf` is pure and total over every combination, with the table test; the strip and headline are right at every stage of the chained run.
- [ ] No raw state name, id or SKU appears to a customer at any stage (scan test).
- [ ] "Keep this page" shows the link, copies it, builds the `mailto:` link, and says it is the only way back; nothing is sent by the server.
- [ ] The merchant home shows the four counts, isolated per merchant, each linking to its page.
- [ ] The chained journey passes from `/` to "collected" in one browser run (mocked).
- [ ] No horizontal scroll at 390 px on the home page, store page, order room (every stage) and merchant home.
- [ ] A wrong or revoked link gets a calm 404 page with a way home.
- [ ] Typecheck, lint, unit, database and E2E green locally and in CI; payment and access tests stay green; no migration, dependency or environment variable added.
- [ ] The hosted run of the same journey is done after merge and deploy, only after a fresh yes, and recorded separately (hosted).

## 9. Task outline (becomes `tasks/product-pass/` after approval)

1. `domain/journey`: `journeyOf`, the table test over all combinations, the purity test.
2. The order room: headline and strip from `journeyOf`, raw status removed, the "Keep this page" panel, the scan test.
3. The home page entry (with the missing-store guard) and the calm not-found page.
4. `merchantOverview` and the merchant home counts, with the isolation test.
5. The chained E2E run and the phone-width checks.
6. Checkpoint: criteria against evidence, CI, then (after merge, deploy and a fresh yes) the hosted run, recorded separately.

## 10. Open questions (defaults apply if you say "approve defaults")

1. **Merge PR 8 first** and build this module on a branch from `main`? Default: yes.
2. **Demo store link** on the home page from a code constant (`demo-gift-boxes`), shown only when that store exists? Default: yes (no new environment variable).
3. **Keep this page** as copy plus a `mailto:` link, with no server email? Default: yes.
4. **No merchant notifications**, counts only? Default: yes.
5. **The seven steps** exactly as in assumption 3? Default: yes.
6. **Phone width 390 px** as the one mobile check? Default: yes.
