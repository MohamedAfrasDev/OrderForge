# Spec: impact-innovation

Module id: `impact-innovation` · Depends on: `product-pass` and every module before it (all built) · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: **APPROVED 6 Nov 2026 (defaults for all seven open questions)**. Task list: [tasks/impact-innovation/](../../tasks/impact-innovation/todo.md) (approved; T1 to T14 built and checkpointed locally on 6 Nov, see [the checkpoint](../checkpoints/impact-innovation-checkpoint.md)). Findings while writing the tasks (6 Nov): (1) `demo_reset` truncates `merchants` and every table, so it already handles two shops and **needs no migration** (open question 5 is closed: no migration 0011 for it); (2) the shop's "kind of product" has no column, so the intake prompt reads it from a new `shop_profile` business rule (`{ "productKind": "..." }`, seed data, no schema change); (3) with the default for open question 4, P3 needs no migration either. So **no migration is planned in this module**.

## 1. Objective

Raise two Devpost judging criteria without touching the money path:

- **Potential Impact** ("a credible, specific case for solving a real problem for a real audience"). Today the project looks like one toy gift-box shop. After this module a judge can see (a) the specific problem and who has it, (b) proof that the engine is not hard-coded to one shop, and (c) evidence for every safety claim that is a test result, not an adjective.
- **Innovation/Idea** ("how creative and novel is the concept"). "AI quote then pay" is common. The unusual part is that the model never touches money and PayPal's authorization is bound to the hash of one exact quote. This module makes that visible and, optionally, lets another AI agent use the shop while a human still approves the payment.

Why now: the product is built and verified end to end on the hosted site (`doc/evidence/product-pass-hosted.md`). What is missing is the case for it. The submission is due **12 Nov 2026 12:00 PST (13 Nov 01:30 Sri Lanka)**; target submission 18:00 on 12 Nov Sri Lanka time.

**Users:** (a) a Devpost judge with a few minutes; (b) a small-business owner who sells custom or small-batch orders (the audience we claim); (c) optionally, an AI agent acting for a buyer.

### The four parts

| Part | What | Type | Cuttable |
|---|---|---|---|
| P1 | **The case and the proof.** A "How it stays safe" page, generated proof points from real test runs, and the README / Devpost text / video script written around the framing in section 2 | Pages, docs, one script | No (cheapest, biggest effect) |
| P2 | **A second seeded merchant** with a different catalog, template and rules, so the engine is shown to be data-driven | Seed data, small code changes | Yes (after P1) |
| P3 | **An agent-facing request endpoint**: a machine can ask a shop for a priced box; only a human can approve the PayPal hold | New API route, new access surface | Yes, first to go |
| P4 | **Submission pack** in `doc/submission/`: Devpost text, tools-used section, video script with timings, screenshot list, final checklist | Docs | No |

### The framing (the story every artifact must tell)

1. **Problem, specific audience.** Shops that sell custom or small-batch orders (corporate gifts, event kits, merch, packaging) quote by email or chat. Three things go wrong: the price drifts from what the customer agreed, the customer pays before anyone has checked stock, and a retry or a timeout charges twice. The audience is the owner of such a shop and the first-time buyer who fears paying for something that cannot be made.
2. **Idea.** The model understands the request and proposes. Code decides everything that matters: what is in stock, what is allowed, what it costs. PayPal sets the money aside for **one exact quote version** (bound by a SHA-256 over canonical JSON) and the merchant's yes or no decides capture or void.
3. **Proof, not adjectives.** Each guarantee is tied to named tests and, where it exists, a real sandbox run (section 5).

**Claims policy (unchanged and binding).** Everything is sandbox, data is synthetic. No claim about time saved, demand, revenue or accuracy appears anywhere unless it is a number this repository measured and the method is stated beside it. Words like "saves hours", "increases conversion", "trusted by" are banned in every artifact of this module. Counts of tests and eval scenarios are allowed because they are measured; they are labeled with their method.

## 2. Assumptions (correct me now or I proceed)

1. **Money, states, schema of payments/reservations/quotes do not change.** P1, P2 and P4 add no migration. P3 may add one table (rate-limit counters) or none (section 3.3); that is an open question.
2. **P1's proof numbers come from a script, never typed by hand.** `npm run proof` runs the unit and database suites with a JSON reporter, reads the eval reports in `eval/intake/reports/`, and writes `doc/evidence/proof-points.md` (counts, dates, the exact commands, and which results are mocked, replayed, scripted or real-sandbox). The page and README link to that file; they do not repeat the numbers.
3. **The safety page is static text plus links.** `/how-it-works` (public, no login) explains the three failure modes and the two design rules in the customer glossary's tone, with a small diagram. It contains no figures that can go stale.
4. **The second merchant fits the existing requirement fields.** The intake pipeline reads fixed fields (`boxCount`, `noFood`, `logoRequired`, `maxPricePerBoxMinor`, `requestedPickupDate`, `preferences`) and its prompt says "custom gift-box merchant". Changing the field set is a bigger change than this module allows. So the second shop is a **different catalog and template with the same fields**, for example an event welcome-kit shop (tote bag, lanyard, water bottle, sticker pack, card, packaging; one slot where stock runs short; a merch-print `logo_print` rule; a food-free catalog so `noFood` is trivially satisfied but still asked). The prompt's first sentence takes the shop's kind of product from data (the `shop_profile` rule) instead of the literal "gift-box"; the shop's name is not put in the prompt (decided 6 Nov while building T5: the model does not need it, and it keeps the first shop's prompts byte-for-byte unchanged). No new field, no change to blocking rules.
5. **The second shop has its own owner login.** `ensureMerchantUser` in `scripts/lib.ts` creates one user from `DEMO_MERCHANT_EMAIL`. A second shop needs a second user (`DEMO_MERCHANT2_EMAIL` / `DEMO_MERCHANT2_PASSWORD`, new variable names, placeholders only in `.env.example`) so shop A's owner cannot see shop B's data. The existing row-level-security and server ownership checks are the proof, and a database test asserts it.
6. **The home page lists the demo stores** instead of one hard-coded `DEMO_STORE_SLUG`. A store that does not exist on a deployment is not shown (no dead link), as today.
7. **`demo:reset` and `seed` must handle two merchants.** The `demo_reset` RPC and the seed's "refuse if orders exist" guard are checked in the first task; if `demo_reset` assumes one merchant, fixing it is part of P2 (a migration only if it is a SQL function that must change; that would make P2 an ask-first item, see boundaries).
8. **P3 never lets an agent pay, approve or confirm.** The agent can create a request with structured, confirmed requirements and read priced proposals. The order room link it receives is the existing customer credential; a human opens it, accepts the exact quote and approves on PayPal's own page. The merchant decision is unchanged.
9. **P3 reuses the existing services** (create inquiry, `editRequirements` with source `customer_edit`, the catalog engine's own validation and alternatives, `createQuoteDraft`/`publishQuote` only via the existing merchant-review gate). No second pricing path exists. Exact function names are confirmed when the task list is written.
10. **P3 is read-only toward the money.** It cannot publish a quote on its own unless the shop's existing review gate allows it; by default a request from an agent ends in "with the shop" exactly like a handed-over human request.
11. **Video and text are written for the 3-minute limit.** The script is timed to 2:45 and rehearsed against the hosted site. The demo shown is the hosted one.
12. **This module ends by 9 Nov.** The brief's 9 Nov tripwire (payment or access tests failing stops all feature work) applies; 10 Nov is polish and README; 11 Nov is video; 12 Nov is final checks only.

## 3. Behaviour

### 3.1 P1: the case and the proof

| Step | Action | Required result |
|---|---|---|
| A | A visitor opens `/how-it-works` | Plain-language page: the problem for a shop owner and a first-time buyer; the three failure modes (stale price paid, double capture, selling stock you do not have); the two design rules (the model never does money; PayPal is bound to one exact quote); what PayPal does at each step in the glossary's words; "Sandbox demo, synthetic data". A link back to the demo and to the repo. No raw state names, SKUs or ids; no unmeasured claim |
| B | A judge or the owner runs `npm run proof` | Writes `doc/evidence/proof-points.md`: date, commit, the commands, counts of unit / database / end-to-end / eval tests with pass and fail, the AI evaluation (scenario count, model, method, every failure, labeled per the existing reports), and a table mapping each of the three failure modes to the named tests that cover it and the real-sandbox evidence file where one exists. Anything mocked, replayed or scripted is labeled |
| C | The README opens | The first screen states the problem, the idea in two sentences, the demo link, and "see `doc/evidence/proof-points.md`"; the setup, env-var names, migrate and seed commands, worker setup, demo reset, sandbox buyer guidance and known limitations (already required by the brief) follow |
| D | The home page loads | One sentence naming the problem, the "Try it as a customer" button, and a visible link "How it stays safe" to `/how-it-works` |

### 3.2 P2: the second merchant

| Step | Action | Required result |
|---|---|---|
| E | `npm run seed` on an empty database | Two merchants exist with fixed ids and slugs, each with products, stock, and the rules `box_template`, `logo_print`, `production_lead_days`, `fulfilment`; the second shop has its own owner user |
| F | A visitor opens the home page | Both demo stores are offered by name, labeled simulated; a missing store is not shown |
| G | The customer opens the second store and describes a request | The same pipeline runs against that shop's catalog: confirmed and unknown fields, one blocking question at a time, a valid configuration, a quote from catalog prices. The prompt names this shop and its kind of product, not "gift box" |
| H | The second shop has a product that runs out at a higher quantity | Code makes the configuration invalid at that quantity, proposes the shop's alternative, and revalidates, as in the gift-box demo. The exact figures are fixed in the fixture and asserted in a test |
| I | The second shop's owner signs in | They see only their own requests, orders, catalog and jobs. Shop A's owner cannot read or change shop B's data by any route (server action, page, API) |
| J | `npm run demo:reset` | Both shops return to the fixture state; the guard that refuses to reseed over live orders still applies to both |

### 3.3 P3: the agent-facing request endpoint (cuttable)

**How the box is chosen (T10).** For each part of the box, in the shop's template order, code takes the first allowed product that is active and, when the request says no food, not food; if none qualifies it takes the first allowed product and lets the engine report why it cannot be used. The engine (`validateConfiguration`) then validates and prices it; when it is blocked, `proposeAlternatives` supplies the options. Both are the same functions the web flow uses, so for the same inputs the figures are the web flow's (a test compares them). The first message of the conversation is built by code from the validated values ("Request sent through the agent interface: 20 boxes, no food, logo needed, budget up to $40.00 per box."), never from agent text. The human who opens the returned link sees the proposal in the normal order room and chooses, accepts and pays there.

A small versioned API so another AI agent can use a shop on a person's behalf. It exists to make "agentic commerce" literal without weakening any rule.

```
GET  /api/agent/v1/stores                 list demo stores (slug, name, kind, simulated: true)
GET  /api/agent/v1/stores/{slug}          what the shop can make: the fields the shop needs, their types,
                                          allowed ranges, currency, that payment is approved by a human
POST /api/agent/v1/stores/{slug}/requests structured requirements -> a request
GET  /api/agent/v1/requests/{id}          status and proposals (token in the Authorization header)
```

`POST` takes only the intake fields with their values (`boxCount`, `noFood`, `logoRequired`, `maxPricePerBoxMinor`, optional `requestedPickupDate`), strictly validated by Zod with no extra keys. The service stores them as the customer's own confirmed answers, proposes a box **in code, with no model call** (decided 6 Nov while writing T10: an API call should be fast and deterministic, and a model adds nothing to a request that is already structured), and returns: the request id, a **request token** (a signed, expiring, read-only token under its own key, so a customer link is not valid as one and the reverse; nothing is stored, and bumping the request's access version revokes it, like the customer link), the order-room URL for a human, and the proposals the code produced with every price as integer cents computed by code. It returns coded blockers (for example `INSUFFICIENT_STOCK`, `OVER_BUDGET`) instead of prose.

What it cannot do, by construction: set or suggest a price, approve a quote, create a PayPal order, capture, void, read another request, list requests, or read any merchant data. Its only link to payment is the URL a human opens.

Safety limits: a per-IP and per-store rate limit and a daily cap on requests created through the endpoint (numbers fixed in the task list; stored without raw IPs, as a hashed bucket, in memory or in one small table: open question 4); free-text fields are not accepted at all (so there is nothing to inject); request size capped; responses never include internal ids, SKUs outside the shop's own public catalog view, or other customers' data; every request is audited with the token's hash prefix only.

| Step | Action | Required result |
|---|---|---|
| K | An agent calls `GET /stores/{slug}` | A machine-readable description of what the shop needs and that a human approves payment |
| L | The agent posts valid requirements for the 20-box demo | A request is created; proposals come back with the exact per-box and total cents the web flow shows ($35 / $700 for the standard demo box); a human link is returned |
| M | The agent posts requirements that cannot be met (for example 30 boxes with the bottle) | Coded blockers and a code-chosen alternative; no model is called for arithmetic |
| N | The agent posts an unknown key, a price, a negative number, or text | 400 with a coded error; nothing stored |
| O | A human opens the returned link | The normal order room shows the same request; they accept the exact quote and approve on PayPal |
| P | An agent tries to read another request, or the same request with a wrong token | 404 with no hint whether it exists |
| Q | The endpoint is called faster than the limit | 429; no request is created |

### 3.4 P4: the submission pack

`doc/submission/` holds: `devpost-text.md` (inspiration, what it does, how it was built, challenges, what is next; the problem and idea in the framing above; a "Tools used" section naming the model(s), PayPal APIs, Supabase, Vercel, Resend, AG Grid and how each is used); `video-script.md` (2:45 timed beats, the three-failure-mode proof moment, the hold-then-confirm moment, the duplicate-capture test on screen, a closing line on what is real and what is sandbox); `screenshots.md` (the list and the captions); `final-checklist.md` (the brief's checklist, each line ticked with evidence or marked open).

## 4. Interfaces (sketch; exact names confirmed in the task list)

```ts
// P1
// scripts/proof.ts: reads vitest JSON outputs and eval reports, writes doc/evidence/proof-points.md (no network)
// app/how-it-works/page.tsx: static server component, text from domain/journey glossary where a PayPal step is named

// P2
// supabase/seed/fixtures.ts: exports merchants[], and per-merchant products/stock/rules (fixed ids)
// domain/intake/prompts.ts: the system prompt takes { productKind } from the shop_profile rule (restricted to letters, digits, spaces, hyphens; default "gift box")
// scripts/lib.ts: ensureMerchantUser(db, email, password) called once per merchant

// P3
// app/api/agent/v1/**/route.ts: thin handlers; Zod-validate, call services, map coded results to JSON
// services/agent-requests/: createAgentRequest(db, slug, requirements), readAgentRequest(db, id, token)
// AgentRequestBody (strict): { boxCount: int 1..N, noFood: boolean, logoRequired: boolean,
//   maxPricePerBoxMinor: int, requestedPickupDate?: YYYY-MM-DD }
// AgentResponse: { requestId, humanUrl, proposals: [{ lines, perBoxMinor, totalMinor }], blockers: Blocker[] }
```

## 5. Proof map (what P1 must be able to point at)

| Failure mode | Guarantee | Where it is proved (exists today; named precisely by `npm run proof`) |
|---|---|---|
| Stale price paid | An authorization belongs to one quote version; a changed quote cannot reuse it | quote-approval and payments suites; hash and supersede tests; `doc/evidence/payments-real-sandbox.md` |
| Double charge | A repeated capture produces no second charge and no second job | payments duplicate-capture test (labeled); unique job constraint test; the real-sandbox run |
| Selling what is not there | Stock is reserved under a row lock; timers never release while a PayPal call may be in flight | reservation database tests (concurrency); catalog-engine `INSUFFICIENT_STOCK` tests |
| Model touching money | Model output cannot set a price, quantity, status or state | ai-intake schema and injection tests; the AI eval report |
| Wrong person sees an order | Access is enforced on the server for every query | access tests per module; (P2 adds the cross-merchant test) |

## 6. Commands

```
npm run proof                     # P1: write doc/evidence/proof-points.md (runs unit + db suites first)
npm run seed                      # P2: now seeds both shops (idempotent; same guards as before)
npm run demo:reset                # P2: clears and reseeds both shops
npm run test                      # unit
npm run test:db                   # database
npm run test:e2e                  # browser journeys (new: second store journey; P3 API contract, if built)
npm run typecheck && npm run lint
```

Existing commands are unchanged. The only new scripts are `proof` (P1) and, if the second merchant needs it, nothing else.

## 7. Project structure (additions only)

```
app/how-it-works/page.tsx
app/api/agent/v1/...                         (P3)
services/agent-requests/                     (P3)
scripts/proof.ts
supabase/seed/fixtures.ts                    (extended; a second shop's fixtures)
doc/evidence/proof-points.md                 (generated, committed)
doc/submission/{devpost-text,video-script,screenshots,final-checklist}.md
tests/ ... e2e/...                           (new tests next to the existing ones)
```

## 8. Code style

Same as the project: TypeScript strict, money as integer cents, domain logic pure with coded results, strict Zod at every boundary, one transition function per state machine (none is added or changed here). Customer-facing text follows the glossary and tone in `SPEC-product-pass.md` section 1. Generated files carry a header saying they are generated, by which command, and on which commit.

## 9. Testing strategy

- **P1:** a unit test for `proof` parsing (fixture JSON in, expected markdown out, with the labels); a scan test that `/how-it-works` and the README's first screen contain no forbidden claim words (a short banned list: "saves", "faster than", "increase", "trusted by", "boost", percentages with no source) and no raw state names; an E2E that the page loads without login and links resolve.
- **P2:** database tests for the second shop's fixtures (valid at the base quantity, invalid at the stock-limited quantity, exact cents); a cross-merchant access test over the server entry points (shop A cannot read or write shop B's inquiries, quotes, purchases, jobs, products, stock); seed idempotency for two shops; a chained E2E for the second store (stand-in model, fake PayPal; labeled mocked) and one hosted run after deploy with your yes.
- **P3:** unit tests for the strict body schema (unknown key, price, negative, text, too large); service tests that the proposals equal the web flow's figures; token tests (only a hash stored, wrong token is 404, no enumeration); rate-limit tests; a test that no route can reach a payment function (the module's imports are checked by a lint-style test); an E2E where an API-created request is opened through the human link and accepted.
- **Always:** the payment, approval and access suites stay green, nothing is skipped or weakened, and no test or CI run sends a real email or contacts the real model or PayPal. Mocked, replayed, scripted and real-sandbox results are labeled separately.

## 10. Boundaries

- **Always:** keep every figure in this module measured or sourced; label sandbox and simulated data; treat agent input as untrusted; enforce access on the server; hash tokens; run tests before commits; update this spec before changing behaviour.
- **Ask first:** any migration (including a rate-limit table or a `demo_reset` change); adding a dependency; a new public API surface (P3 in full); a new environment variable (the second owner's login); changing the intake field set or blocking rules; touching the intake prompt beyond naming the shop; the first hosted run of the second shop or of the agent endpoint; publishing anything to Devpost.
- **Never:** let the endpoint or any artifact claim an unmeasured benefit; let an agent approve, pay, capture, void or publish a price; accept free text on the agent endpoint; weaken or skip a payment, approval or access test; put secrets in the repository; use real customer data; claim PayPal endorsement or use PayPal's trademarks beyond naming the integration.

## 11. Success criteria

1. `/how-it-works` is public, free of forbidden words and unmeasured claims, and states the problem, the idea and the three failure modes; the home page links to it. (Test: scan + E2E.)
2. `npm run proof` regenerates `doc/evidence/proof-points.md` from real runs; every row of the proof map points at an existing test or evidence file; every result is labeled. (Test: parser unit test + a manual run recorded in the checkpoint.)
3. The README's first screen states the problem, the idea and the demo link, and the brief's README requirements are met.
4. Two merchants seed idempotently; `demo:reset` handles both; the home page offers both; a missing store is not shown. (P2.)
5. The second shop runs the full journey (request, blocking question, valid configuration, stock-limited quantity becomes invalid with an alternative, exact quote, accept, authorize, decision, job) under the stand-in model and fake PayPal, and once on the hosted site after your yes. (P2.)
6. Cross-merchant isolation holds on every server entry point. (P2.)
7. If P3 ships: all of section 3.3 steps K to Q pass; the endpoint's figures equal the web flow's; no code path from the endpoint reaches a payment function; no free-text field exists. (P3.)
8. The submission pack exists, the video script is timed at or under 2:45, every checklist line in `final-checklist.md` is ticked with evidence or marked open with a reason. (P4.)
9. Payment, approval and access suites are green on the last commit, CI is green, and no secret is in the repository.

## 12. Open questions (defaults apply if you say "defaults")

1. **Scope.** Build P1, P2, P4 and leave P3 out, or include P3? *Default: P1 + P2 + P4 now; P3 only if P1 and P2 are checkpointed by the end of 8 Nov.* P3 is the riskiest (new public surface) and the first to cut.
2. **The second shop's kind.** *Default: an event welcome-kit shop (tote, lanyard, bottle, stickers, card, packaging), same fields, one stock-limited item.* Say if you prefer another kind (merch print, corporate stationery).
3. **Second owner login.** *Default: new env vars `DEMO_MERCHANT2_EMAIL` and `DEMO_MERCHANT2_PASSWORD`, placeholders in `.env.example`, set on Vercel only after your yes.*
4. **P3 rate-limit storage.** *Default: in memory per instance plus a hard daily cap checked by counting rows in the existing inquiries table (no migration).* The alternative is a small table (needs migration 0011, ask first).
5. **`demo_reset` and two shops.** If the SQL function assumes one merchant, *default: fix it in a migration (0011) after you approve it* (hosted apply needs a separate yes, as before).
6. **Proof page numbers.** *Default: counts appear only in `doc/evidence/proof-points.md`, never on the web pages, so the site cannot go stale.*
7. **Video.** *Default: you record it from my script; I do not generate or publish anything to YouTube or Devpost.*

## 13. Schedule and cut order

| Date | Work | Exit |
|---|---|---|
| 6 Nov | Spec approval; task list written and approved | `tasks/impact-innovation/` exists |
| 7 Nov | P1 (page, `proof`, README top); P2 seed and isolation tests | Criteria 1 to 4 and 6 met locally |
| 8 Nov | P2 journey test; P3 only if on schedule; submission pack drafted | Criterion 5 locally; P3 decision |
| 9 Nov | Critical tests, deploy, hosted run of the second shop (with your yes) | Payment and access suites green; checkpoint written |
| 10 to 12 Nov | Per the brief: README polish, video, submission | Submitted by 18:00 Sri Lanka time on 12 Nov |

**Cut order if behind:** P3, then the second shop's hosted run (keep its local tests), then the screenshots list. Never cut P1, P4, or any payment, approval or access correctness.
