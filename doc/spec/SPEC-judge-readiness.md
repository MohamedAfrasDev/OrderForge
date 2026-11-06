# Spec: judge-readiness

Module id: `judge-readiness` · Depends on: `impact-innovation` and every module before it (all built) · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: **APPROVED 6 Nov 2026 (defaults for all six open questions).** Task list: [tasks/judge-readiness/](../../tasks/judge-readiness/todo.md), awaiting approval. Origin: an outside review of the project (pasted by you on 6 Nov) whose diagnosis is that the weakest links are presentation, design polish and impact evidence, not backend depth. This spec keeps the parts of that review that raise the Devpost scores without touching the money path, and drops the rest (section 11).

## 1. Objective

Make a Devpost judge understand and trust OrderForge within three minutes, and make sure everything we claim is true on the hosted site.

The one sentence every artifact must reinforce: **AI proposes. Code prices. PayPal holds. The shop decides.**

Positioning: the safest complete path from an AI or agent request to a binding, human-approved PayPal transaction.

Why now: the product is built and checkpointed (`doc/checkpoints/impact-innovation-checkpoint.md`). Open problems that a judge would hit, taken from the repository itself:

1. The submission text and video script claim a second shop (Demo Event Kits), but the hosted site seeds only the gift-box shop (`doc/submission/final-checklist.md`, last open line). A claim the live site does not back is the most damaging kind of flaw.
2. The configured primary model is a free one that was rate-limited or timing out in the recorded runs (`doc/evidence/ai-intake-real-model.md`: Gemma 429 on all 22 messages; Nemotron needed 60 s). A judge who waits 20 to 60 seconds for a failure may stop.
3. The agent API exists (`/api/agent/v1`, OpenAPI file) but nothing on the site points to it, so the strongest Innovation evidence is invisible.
4. A judge has no prepared path: they must invent a request, know about the 30-box stock limit, and find the sandbox login.
5. The key screens work but are visually plain.
6. The impact case rests on a plausible problem with no evidence from anyone who has it.

**Users:** a judge with a few minutes (primary); a small shop owner reading the pitch; an AI agent developer reading `/developers`.

### The five parts

| Part | What | Type | Cuttable |
|---|---|---|---|
| J1 | **Production truth and reliable model.** Decide and fix the second-shop claim; make the paid evaluated model the primary; prove ten hosted requests in a row | Config, one small seed option, one script, docs | No |
| J2 | **Judge quick path.** A public `/demo` page that starts the real flow from a prepared messy request, says where human approval begins and which credentials are needed | One page, one server action | No |
| J3 | **`/developers`.** The agent contract made visible: five fields, one `curl`, a shortened real response, the hand-off diagram, the OpenAPI link, "the agent can request and read; it cannot accept or pay" | One page, one test | No |
| J4 | **Focused visual polish** on the six frames the video shows, plus visible provenance of each fact (AI-derived, you confirmed, calculated by code) | Components and CSS only | Yes, after J1 to J3 |
| J5 | **Submission rewrite and honest impact.** New opening, video script rebuilt on one story, final checklist and proof regenerated for the merge commit, seller conversations recorded only if they happen | Docs | No |

## 2. Assumptions (correct me now or I proceed)

1. **Money, states and schema do not change.** No migration, no new dependency, no change to a state machine, pricing, hashing or the agent API's behaviour. All five parts are pages, copy, config, seed data and docs. If a task would need otherwise, it stops and asks.
2. **Facts first.** The first task of J1 reads what the hosted site actually serves (home page store list, `/api/agent/v1/stores`, `/api/health`, the Vercel environment variable names for the model) and records it in `doc/evidence/`. Nothing below is built on the review's word that production has one shop; we check.
3. **The second-shop decision is a gate with a default.** Default: seed Demo Event Kits on the hosted site through the additive option proposed in the impact-innovation checkpoint (`npm run seed -- --only=demo-event-kits`, touching only the second shop, never the first shop's stock), then run one complete hosted journey on it. **If that is not approved and finished by the end of 8 Nov, every second-shop claim is removed** from `devpost-text.md`, `video-script.md`, `screenshots.md` and the README, and the home page continues to list only stores that exist. A smaller true demo beats a broader inconsistent one.
4. **Model choice uses only evaluated models.** The only paid model with a recorded evaluation is `openai/gpt-oss-120b` (22 of 22 messages usable, gate scenarios clean, 0 violations, one miss; run `2026-11-04-gpt-oss-120b-paid-20s.md`). The default is to make it the primary through `OPENROUTER_MODEL` (an environment change on Vercel plus one small code change found while doing T2: `lib/ai/openrouter.ts` refuses a paid primary unless `allowPaidPrimary` is set and `lib/ai/wiring.ts` never sets it, so the variable alone would make the intake throw; the change is that an explicitly set `OPENROUTER_MODEL` counts as the opt-in, with no new variable and the free defaults unchanged) and to leave no free fallback in front of a judge (an unset fallback variable resolves to `gpt-oss-120b`, the same model, which the client treats as no fallback, so one attempt only), so a provider failure becomes the existing model-outage hand-off to the shop within one timeout, not after two. Changing the model or the prompt's behaviour is a new evaluation run; we do not change the prompt.
5. **Cost is bounded outside the code too.** A hard credit limit is set on the OpenRouter key by you (the dashboard, not the repo). Inside the code, the existing intake rate limits and the agent API caps stay; J1 checks that the public intake route has a per-address limit and reports if it does not (adding one is ask-first).
6. **`/demo` uses the real application.** Pre-populated synthetic input is allowed; faking results is not. Each "use this request" button runs the same start action a visitor's own typing runs, with text from a fixed server-side list chosen by key (never text taken from the URL, so there is nothing to inject and no personal data in a query string).
7. **No credentials are committed.** `/demo` says which credentials are needed and where to find them (the Devpost notes), and shows the shop owner's sign-in address; it does not print passwords. The sandbox buyer account is a PayPal sandbox account and goes only in the Devpost notes, as the checklist already plans.
8. **`/developers` shows real output.** The displayed request body, `curl` and shortened response are taken from the real handlers' schema and a real code-priced result for the 20-box demo ($35.00 a box, $700.00; figures from the engine, asserted by a test), not typed by hand. The base URL comes from `APP_BASE_URL`.
9. **Claims policy is unchanged and binding.** Everything is sandbox, data is synthetic, and no time-saved, demand, revenue or accuracy figure appears unless this repository measured it and the method is stated beside it. The existing claim-scan test is extended to cover `/demo`, `/developers` and the new submission opening. Test counts are allowed but kept to a few seconds in the video: the guarantee matters, not the number.
10. **Impact evidence is observed or absent.** If you speak to three to five people who handle custom orders, `doc/submission/seller-conversations.md` records only what each said, in their words or close paraphrase, without names unless they agree, and the submission quotes at most one sentence that is literally true of them (for example, "Three of the five sellers we spoke to described confirming changes by hand across chat and spreadsheets"). If the conversations do not happen, the submission says the problem is described from the brief and has not yet been validated with sellers. No invented percentages, time savings or market sizes.
11. **This module ends by 9 Nov for code; 10 Nov is polish and README; 11 Nov is video; 12 Nov is final checks only** (the brief's schedule). The 9 Nov tripwire applies: payment or access tests failing stops everything.

## 3. Behaviour

### 3.1 J1: production truth and a reliable model

| Step | Action | Required result |
|---|---|---|
| A | Read the hosted site | `doc/evidence/judge-readiness-hosted-baseline.md` lists the stores the home page offers, the agent API's store list, the health result, the configured model names (names only, from Vercel's variable list, never values), and the date. This is the baseline every later claim is checked against |
| B | Second shop decision (assumption 3) | Either the hosted site offers both stores and one complete hosted journey on the second is recorded in `doc/evidence/`, or every second-shop claim is removed and the checklist says so |
| C | Set the model | `OPENROUTER_MODEL=openai/gpt-oss-120b`, no free fallback ahead of a judge (the fallback variable is unset or equal to the primary). Applied only after your yes; recorded in the baseline file |
| D | Model soak | `npm run soak:model -- --base <url> --n 10` sends ten consecutive real requests to the hosted intake (a fixed set of the prepared demo messages), one at a time, and writes `doc/evidence/model-soak.md`: date, model name, ten wall-clock durations, any provider failure, and the plain verdict. **Pass:** ten of ten complete with no provider failure and none above 20 s. Anything else is reported as it is, and the claim "reliable" is not made. The script uses only the public customer flow and a throwaway request each time; it is labeled **real-model, hosted** |
| E | A provider failure while a judge waits | The customer sees the existing hand-off to the shop within one timeout (20 s), with a plain message and the way to retry; nothing is left half-written. A test with a failing provider asserts the message appears after one attempt, not two |

### 3.2 J2: the judge quick path

`/demo` is public, linked from the home page ("See the complete flow") and from the top of the README and Devpost text. It shows, in order:

1. One sentence: what OrderForge is and the four-part line.
2. "Try the real flow": two buttons per shop that exists. **"20 welcome boxes"** starts the real request with a prepared messy message (notebooks, no food, a logo, under $40 a box). **"Change it to 30"** is shown as step two of the story: after the first quote, the judge types or taps the quantity change, and the page explains in one line that only 24 bottles are in stock, so code blocks the bottle and reprices the replacement ($36.00 a box, $1,080.00 for the gift-box shop's demo path). Exact figures are asserted against the engine in a test, not retyped.
3. A strip showing the journey with **where human approval begins** marked: AI understands, code prices, you accept the exact price, **PayPal holds the money (no charge)**, the shop decides, charge or release.
4. "What you need": the sandbox buyer account (in the Devpost notes), the shop owner's sign-in page for the merchant side, and the sandbox notice ("no real money").
5. Links: `/how-it-works`, `/developers`, the OpenAPI file, the repository, `doc/evidence/proof-points.md`.

| Step | Action | Required result |
|---|---|---|
| F | A judge presses "20 welcome boxes" | The real start action runs and lands in the normal order room with the prepared message sent; no fake data, no shortcut around the model or the engine |
| G | The judge follows to the stock-limited quantity | The same figures the engine produces for that shop; a missing store's button is not shown |
| H | The page is read by a scanner | No unmeasured claim, no raw state names, no secrets, no password text; page works at 390 px width |

### 3.3 J3: `/developers`

Public page, linked from the home page footer and `/demo`. Contents, in order:

1. The sentence: **"The agent can request and read; it cannot accept or pay."**
2. The five-field request contract (`boxCount`, `noFood`, `logoRequired`, `maxPricePerBoxMinor`, optional `requestedPickupDate`), types and ranges, generated from the same Zod schema the route uses.
3. One copyable `curl` for the 20-box demo (sandbox, no secret), with the token header explained for the read call.
4. A shortened real response: request id, the code-priced proposal in cents, `humanUrl`, coded blockers example for the stock-limited quantity.
5. The agent-to-human hand-off diagram: agent posts requirements, code prices, a person opens the link, accepts the exact price, approves on PayPal, the shop decides. Marked with what the agent cannot do (set a price, approve, pay, publish).
6. The link to `/api/agent/v1/openapi.json` and the limits (rate limits and daily cap, read from the constants in the code, not typed).

| Step | Action | Required result |
|---|---|---|
| I | A test posts the example body from the page to the real handlers | 201 with the cents shown on the page |
| J | A test parses the displayed response sample against the response schema | Passes; any drift fails the build |
| K | The claim scan runs on the page text | Clean; the page names no MCP, no autonomous payment and no feature that does not exist |

### 3.4 J4: focused visual polish (the six frames)

Only the screens the video shows. No design-system rewrite, no new dependency, no change to merchant pages other than the decision screen.

| Frame | Change |
|---|---|
| Home | A stronger hero stating the problem and the four-part line, a compact flow diagram, "See the complete flow" and "Try it as a customer" |
| Request and specification | Each fact visibly marked **from your message (AI read it)**, **you confirmed**, or **calculated by code** (extends the existing requirement status; text from the customer glossary; not colour alone) |
| Price and stock warning | The exact price and any stock blocker are the most prominent thing on the screen; the swap and the reprice are shown as one change |
| PayPal authorization | A trust panel in plain words: "PayPal sets aside $X. You are not charged yet. If the shop says no, it is released." with the sandbox notice |
| Merchant decision | Presentation-ready: the one exact price, the held amount, one Accept and one Decline, each saying what it does (charge or release) |
| Result | A conclusive status after the decision: captured and prepared, or released and stock freed, with the customer's view matching |

Accessibility: contrast and focus kept at the existing standard; reduced-motion respected; no information carried only by colour; 390 px width checked (existing e2e pattern).

### 3.5 J5: the submission

- **New opening** in `devpost-text.md`, leading with the product difference (the review's proposed paragraph, edited to our claims policy and to what is built). Feature inventory and technical depth follow it.
- **Video script** rebuilt as one story at or under 2:45: problem (12 s), AI understanding (33 s), the guardrail (20 s), PayPal hold (30 s), merchant decision (20 s), the agent API and hand-off (25 s), proof (18 s), close (7 s). The test-count moment is a few seconds at most. Shows the demo path from the brief's section 1.
- **Checklist and proof:** `final-checklist.md` brought up to date; `npm run proof` regenerated on the merge commit; the README's "For agents" example run against the hosted site and the result recorded.
- **Fresh-tester run:** one run of the hosted journey by someone who has not seen it, using only the README and the Devpost notes; what they got stuck on is recorded and the top fixes are made if small.
- **Seller conversations** (assumption 10), if done.

## 4. Interfaces (sketch; exact names in the task list)

```ts
// J1  scripts/soak-model.ts   npm run soak:model -- --base https://... --n 10   (public flow only; no admin client)
// J2  app/demo/page.tsx       server component; app/demo/actions.ts startDemoRequest(key: "welcome-20" | ...) -> redirect to the order room
//     domain/demo/scripts.ts  fixed prepared messages keyed by store slug and key (no text from the URL)
// J3  app/developers/page.tsx server component; reads lib/agent-api/schemas.ts and limits constants; example built by code
// J4  components/** and app/globals.css only; domain/journey glossary gains the three provenance labels
```

## 5. Commands

```
npm run soak:model -- --base <url> --n 10   # J1: new script; hosted, real model, public flow only
npm run proof                               # J5: regenerate doc/evidence/proof-points.md on the merge commit
npm run test && npm run test:db && npm run test:e2e && npm run typecheck && npm run lint
```

## 6. Project structure (additions only)

```
app/demo/{page.tsx,actions.ts}   app/developers/page.tsx
domain/demo/scripts.ts           scripts/soak-model.ts
doc/evidence/{judge-readiness-hosted-baseline,model-soak}.md
doc/submission/seller-conversations.md      (only if the conversations happen)
tests/ e2e/                      (next to the existing ones)
```

## 7. Code style

As the project: TypeScript strict, money as integer cents, pure domain logic, strict Zod at boundaries, customer text from the glossary and tone in `SPEC-product-pass.md` section 1. Generated files say which command wrote them and on which commit.

## 8. Testing strategy

- **J1:** unit test of the soak script's report builder (durations in, verdict out, pass/fail rule); a provider-failure test that the hand-off message appears after one attempt (mocked provider, labeled); the soak run itself is **real-model, hosted**, and recorded as evidence, not as a unit test.
- **J2:** a browser test that each prepared button reaches the real order room with the message sent (mocked: stand-in model, fake PayPal, labeled); a test that no prepared text can come from the URL; the claim scan and 390 px check.
- **J3:** tests I, J, K above; a check that the limits shown equal the constants.
- **J4:** existing browser journeys stay green; a visual check of the six frames at desktop and 390 px recorded as screenshots in `doc/submission/`; the provenance labels have unit tests on the mapping.
- **Always:** payment, approval and access suites stay green and unweakened; no test sends real email or contacts a real model or PayPal; mocked, replayed, scripted and real results are labeled separately.

## 9. Boundaries

- **Always:** keep every figure measured or generated; label sandbox and simulated data; treat agent and customer input as untrusted; update this spec before changing behaviour; run tests before commits.
- **Ask first:** every hosted action (the Vercel model variable, the additive hosted seed, the soak run, a deploy); the additive `--only` seed option (touches `scripts/`); adding or changing any rate limit; any dependency; any migration; any new environment variable.
- **Never:** let any page or text claim an unmeasured benefit or invent seller evidence; print or commit a password or key; fake a result on `/demo`; let an agent approve, pay, capture, void or set a price; add MCP, refunds, subscriptions, Payouts, multi-currency, delivery, a third shop, or extra sponsor integrations; weaken or skip a payment, approval or access test; publish to Devpost or YouTube on your behalf.

## 10. Success criteria

1. The hosted baseline is recorded, and every claim in `devpost-text.md`, `video-script.md` and the README matches what the hosted site serves, including the number of shops.
2. The model soak passes (ten of ten, none above 20 s) and is recorded with the model name, or the result is recorded as it is and the reliability claim is not made.
3. A provider failure reaches the shop hand-off after one timeout.
4. `/demo` starts the real flow from a prepared request, marks where human approval begins, names the credentials needed, and links the other pages; its figures equal the engine's.
5. `/developers` shows the contract, a copyable `curl`, a real shortened response, the diagram, the OpenAPI link and the sentence about what the agent cannot do; its examples are tested against the real handlers and schemas.
6. The six frames of section 3.4 are done and the existing browser journeys pass.
7. The submission opens with the new paragraph, the video script is at or under 2:45 on the story in section 3.5, the checklist is current, and `proof-points.md` names the merge commit.
8. One fresh-tester run is recorded.
9. Payment, approval and access suites green on the last commit, CI green, no secret in the repository, claim scan clean on all new pages.

## 11. Not building (from the review, decided)

No MCP server; no more PayPal products, refunds, subscriptions or Payouts; no autonomous agent payment; no multi-currency or delivery workflow; no third demo shop; no general design-system rewrite; no tests added only to raise a count; no extra sponsor integrations. Also not taken from the review: its "88 to 91 out of 100" estimate (nobody can know the judges' scores) and its instruction to rank by an assumed scoring model.

## 12. Open questions (defaults apply if you say "defaults")

1. **Second shop.** *Default:* seed it on the hosted site via the additive option and record one hosted journey; remove all second-shop claims if not finished by the end of 8 Nov. Alternative: remove the claims now and save the effort.
2. **Primary model.** *Default:* `openai/gpt-oss-120b` as primary, no free fallback, an OpenRouter credit limit set by you. Alternative: keep the free primary with the paid fallback (cheaper, but a judge may wait up to 40 s on a failure).
3. **Where `/demo` is linked.** *Default:* home page button, README top, Devpost text. 
4. **Seller conversations.** *Default:* you try for three before 10 Nov and I provide the question list and the recording file; if fewer than three happen, we state honestly that validation is pending.
5. **Polish scope.** *Default:* exactly the six frames; anything else is a separate request.
6. **Video.** *Default:* you record it from my script; I generate or publish nothing to YouTube or Devpost.

## 13. Schedule and cut order

| Date | Work | Exit |
|---|---|---|
| 6 Nov | Spec approval; task list written and approved | `tasks/judge-readiness/` exists |
| 7 Nov | J1 A to E (baseline, model change with your yes, soak), J3 | Criteria 1 to 3 and 5 |
| 8 Nov | J2; second-shop gate (default: done or claims removed by end of day) | Criterion 4; claim consistency |
| 9 Nov | J4 on the six frames; critical tests; deploy with your yes | Criterion 6; payment and access suites green |
| 10 Nov | J5 text, README, fresh-tester run | Criteria 7 and 8 |
| 11 Nov | Video, screenshots | Submission drafted |
| 12 Nov | Final checks only | Submitted by 18:00 Sri Lanka time |

**Cut order if behind:** J4 (keep the price/stock panel and the PayPal trust panel), then the second shop's hosted journey (remove its claims), then seller conversations (state honestly that validation is pending). Never cut J1's truth and model checks, J2, J3, the submission rewrite, or any payment, approval or access correctness.
