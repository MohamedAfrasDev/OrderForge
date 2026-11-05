# product-pass checkpoint (T16)

Written 5 Nov 2026 against branch `spec-7-product-pass` (T0 to T15 built, one gap closed during this review). Evidence labels used below:
**local** = the real local Supabase stack on this machine; **mocked** = the rule-based stand-in model, the local fake PayPal and the recording fake email provider (nothing reaches
a real service); **CI** = GitHub Actions on the pushed commit; **hosted** = the deployed app and hosted Supabase; **real-email** = a real message through Resend.
Only **local**, **mocked** and **CI** evidence exists today. **Nothing hosted and no real email has been done**: each needs your fresh explicit yes (see "Still to do").

## Result: 11 of 13 criteria met (local, mocked, CI); criterion 12 is met except hosted migration 0010, and criterion 13 (hosted run, real email) is not done: both wait for your yes

| # | Success criterion (spec §8) | Status | Evidence |
|---|---|---|---|
| 1 | A visitor with only the site address reaches the customer flow in one click; shop sign-in stays reachable | Met | `e2e/home.spec.ts` (customer link first, shop sign in second, guarded by the demo store existing), `e2e/banner.spec.ts`; the journey starts at `/` (`e2e/journey.spec.ts`). local, mocked |
| 2 | `journeyOf` pure and total over every combination; strip and headline right at every stage of both chained runs | Met | `tests/journey/{journey,wording,purity}.test.ts` (1,600 combinations, purity); every stage of both runs asserts headline and the one current step (`e2e/journey-support.ts: expectStage`); `e2e/order-room-words.spec.ts` (12 stages). local, mocked |
| 3 | No raw state name, id, SKU or forbidden word to a customer at any stage or in any customer email | Met | Page scans: `e2e/order-room-words.spec.ts`, `tests/customer-vocabulary.test.ts`; email scan over all eight templates with the link removed: `tests/notifications/render.test.ts`. The terms text and the shop's own condition notes are excluded from the vocabulary scan on purpose (not ours to reword). local, mocked |
| 4 | Conversation and "Your order so far" together; a tapped quick reply records the customer's own confirmed answer and the assistant continues; typing still works | Met | `tests/intake/quick-replies.test.ts`, `tests/db/intake-answer.test.ts`, `e2e/intake-customer.spec.ts`; the journey taps "20 boxes". local, mocked |
| 5 | Price itemised; the PayPal box says what is held, what the shop decides, what happens on yes and on no | Met | `e2e/price-and-paypal.spec.ts` (the terms sentence is unchanged and tested). local, mocked |
| 6 | "Keep this page" shows the link, copies it, builds the `mailto:`, says it is the only way back, and says when the link was emailed | Met after a fix | The "says when the link was emailed" half had been deferred at T4 and never built; found in this review and added (`services/notifications/read.ts`, `components/keep-page.tsx`). It says "We also emailed this link to the address you gave." only when the saved-link email is SENT, "We're emailing…" while pending, and nothing when it was skipped or failed or there is no address; never the address. `tests/db/notifications-link-status.test.ts`, `e2e/price-and-paypal.spec.ts`, `tests/keep-page.test.ts`. local, mocked |
| 7 | Today shows three counts, isolated per shop; lists are AG Grids with a detail area; the shop can build and send a quote from a handed-over request, priced by the system, and the customer accepts it | Met | `tests/db/merchant-overview.test.ts` (two shops; no session refused), `e2e/intake-merchant.spec.ts`, `e2e/{payments,fulfillment}-merchant.spec.ts`, `e2e/{quote-review,reservation-holds}.spec.ts`, `tests/db/intake-builder.test.ts` (engine pricing, blocked box, double submit makes one quote, no field for a price), `e2e/shop-quote.spec.ts`, `e2e/journey.spec.ts` run 2. local, mocked |
| 8 | Add a product; edit name, category, price, food, active, stock; every refusal explained and reverts the cell; published and accepted quotes unchanged; every change audited | Met | `tests/catalog-edit/*`, `tests/db/catalog-edit.test.ts` (accepted quote byte for byte unchanged and checkout, approval and capture still work; stock never below held, 12 parallel edits; template written last; two adds at once both land), `e2e/shop-catalog.spec.ts`. Audit holds the product id and the names of the fields, never values. local |
| 9 | Emails queued once per event, sent through the port, retried then FAILED without touching any order step, no customer free text, no test sends a real email | Met (mocked) | `tests/db/notifications-outbox.test.ts` (once however often or in parallel; three attempts then FAILED; throwing and slow providers; the cap of 8; a provider that always fails changes nothing through pay, accept, prepare, collect), `tests/notifications/*`, `tests/notify-step.test.ts`, `tests/email/resend.test.ts` (local fake HTTP server only), `tests/env.test.ts`. The real provider is never built under test or CI, and the e2e server blanks the three variables. mocked |
| 10 | Whole journey from `/` to collected, and the handed-over journey to an accepted quote, with the recorded emails checked | Met | `e2e/journey.spec.ts` (five emails, once each, right recipients and amounts; three for the handed-over path). Ran 4 times in a row and in six full-suite runs after the last fix. mocked |
| 11 | No horizontal scroll at 390 px on the listed pages; a wrong or revoked link gets the calm 404 | Met | `e2e/journey-phone.spec.ts` (home, store, every order stage, Today, an order to decide, a job, Build a quote), `e2e/shop-catalog.spec.ts`, `e2e/catalog-page.spec.ts`, `e2e/home.spec.ts` (forged, expired, garbage and revoked links are indistinguishable, a real 404). local, mocked |
| 12 | Typecheck, lint, unit, database and E2E green locally and in CI; payment and access tests stay green; migration 0010 applied locally and, after a fresh yes, to hosted with checks before and after | Partly met | Local: typecheck, lint, build clean; unit 1384; database 1329; E2E 134. CI green on the last code commit. Payment and access tests are in those runs. Migration 0010 is applied **locally only**; hosted 0010 waits for your yes. |
| 13 | The hosted run (real model, real PayPal sandbox, a real email to your own address) after merge and deploy, only after a fresh yes, recorded separately | Not done | Waits for your yes. |

## Numbers (after the last code commit)

| Check | Result |
|---|---|
| Typecheck, lint, production build | clean |
| Unit tests | 1,384 passed (77 files) |
| Database tests (local Supabase) | 1,329 passed (55 files) |
| E2E (local Supabase, stand-in model, fake PayPal, fake email) | 134 passed |
| CI on the last code commit (`a7bbadd`) | green (GitHub Actions, 5 Nov 2026) |

AG Grid Community 36.2.0 (MIT, no licence key) is on shop pages only (about 250 KB gzipped); a test loads `/` and a store page and finds no AG Grid code.

## What changed after build started (decisions and corrections)

- Q6 (your change): the shop adds and edits products; Q4 (your change): email through Resend; Q5 (your change): AG Grid for the shop's lists. All three are built.
- A held draft quote's inquiry is already waiting for the shop, so the "requests to answer" count is the inquiries only (T6); Build a quote does not open for an inquiry that already has a draft in Quote review (T7).
- Real defects found and fixed during the build, each with a test: the store form wiped the customer's message when an action returned an error; asking for hundreds of ids in one URL failed ("URI too long") in the email queue; two products added at the same instant could overwrite each other in the box template (CI caught this on the T11 commit; fixed with a compare-and-set in T13); "Keep this page" never said the link was emailed (found in this review).
- Test-only fixes: the journey replay now sends only its own request's rows and retries if the running server's background pass got there first; the fixed demo shop login is found past the first page of users (the local test database collects users from every run).

## Honest limits

- The drain is replayed in the test process; the server's own pass is shown by the rows it queues (SKIPPED with no provider). A send inside the server has not been seen.
- The PayPal sandbox page is not loaded in tests; the fake stands in. Print was tested with a recorder and print-media emulation, not a real printout. No real phone was used.
- The cap of 8 emails per request counts SENT rows: two drains finishing at the same instant for one request could both pass the check (each send is still once-only).
- The shop that owns an inquiry can read its `customer_email` under row level security, like the rest of its inquiry.
- The real model has still not been run on this module's wording (it changed nothing in the prompts); the Gemma free model from ai-intake remains unevaluated because of its rate limit.
- A database test (`payments-decide`) timed out once in a full run under Docker load and passed alone and in the next runs; the known intermittent stall, unrelated to this module.

## CI

CI ran on every push of this branch. The run on the T11 commit failed once, on the template race above (a genuine bug, fixed). Every run since T12 is green. The last code commit (`a7bbadd`) is green.

## Hosted migration 0010 (applied 5 Nov 2026, after your explicit yes)

PR 9 was merged before this, so the deployed code was briefly ahead of the hosted schema (order pages read `notifications`; starting a request writes `customer_email`). Applied with `supabase db push --db-url` against the hosted project (ref `twkepbycivkmhrmurxwi`, the one in `.env`; the URL was read from `.env` and never printed). A dry run first listed exactly one pending migration, `0010_notifications.sql`. Checked read-only before and after. **hosted** evidence; the live site itself was not opened or tested.

| Check | Before | After |
|---|---|---|
| Applied migrations | 0001 to 0009 | 0001 to 0010 |
| `inquiries.customer_email` column | absent | present, with the `inquiries_customer_email_valid` check |
| `notifications` table | absent | present, row level security on, no policy, one unique key (`dedupe_key`), no privileges for anon or authenticated |
| Rows: inquiries / messages / purchases | 6 / 6 / 5 | 6 / 6 / 5 (unchanged) |
| Inquiries with an email / notifications rows | n/a | 0 / 0 |

## Still to do (each needs your fresh explicit yes, with a read-only check before and after, recorded separately)

1. ~~Merge to `main`~~ (PR 9 merged 5 Nov by you).
2. ~~Apply migration 0010 to the hosted project~~ (done 5 Nov, above).
3. Set `RESEND_API_KEY`, `EMAIL_FROM` and (optionally) `EMAIL_REPLY_TO` on Vercel. Until a domain is verified in Resend, `EMAIL_FROM=onboarding@resend.dev` can deliver only to the Resend account owner's address; I need that address and the sender you want to use. Leave `INTAKE_MODEL` unset on Vercel.
4. The first real email, to your own address only, recorded as real-email evidence.
5. One hosted run of the whole journey (real model, real PayPal sandbox, a real email to you), recorded in `doc/evidence/product-pass-hosted.md`.
6. The ai-intake leftovers: the Gemma evaluation when its rate limit lifts, and the optional `PAYPAL_PAYEE_MERCHANT_ID`.
7. Submission work (README, video, Devpost text, screenshots, a fresh-tester pass): no task list exists for it yet.

The tripwire in `SPEC.md` still applies: if the payment or access tests fail on 9 Nov, feature work stops.
