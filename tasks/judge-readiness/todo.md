# Todo: judge-readiness

Spec: [../../doc/spec/SPEC-judge-readiness.md](../../doc/spec/SPEC-judge-readiness.md) · Plan: [plan.md](plan.md) · Status: **task list approved 6 Nov 2026; T1 to T3 done.**

Each task: acceptance, verify, files (about five or fewer), dependencies. Tick on completion and add a "Done <date>" line with the evidence. Hosted steps need a fresh yes and are marked **[YES]**.

- [x] **T1 Hosted baseline (read-only)**
  - Acceptance: `doc/evidence/judge-readiness-hosted-baseline.md` records, with the date: the stores the live home page offers; the agent API's store list; the health result; the configured model variable NAMES from Vercel (never values); whether the live site runs the merged code (commit shown by the deployment); whether the public intake route has a per-address limit (read from code). Only public GETs and read-only listings; nothing is changed.
  - Verify: read by you; every line cites the command or page it came from.
  - Files: `doc/evidence/judge-readiness-hosted-baseline.md`
  - Depends on: none.
  - **Done 6 Nov 2026**: `doc/evidence/judge-readiness-hosted-baseline.md`. Findings: (1) the live site and the agent API list one shop only; the second-shop claims are untrue today; (2) the live site runs the merged code (deployment 12:08 IST = merge commit `ce206ad`), so the checklist's "PR 12 open" is stale; (3) `OPENROUTER_MODEL` and the fallback are NOT set on Vercel, so production uses Gemma free primary with a 20 s timeout and gpt-oss-120b as fallback; (4) [corrected in T2: the public flow IS rate limited in `proxy.ts`, 30 a minute under /store and 60 under /o per address, in memory per instance]. `/demo` and `/developers` are 404 as expected.

- [x] **T2 One-attempt hand-off when the model fails**
  - Acceptance: with no fallback model configured, a provider failure (timeout, 429, 5xx) makes the customer see the existing hand-off to the shop after one attempt, with a plain message and a retry, and nothing half-written. A test with a failing mocked provider asserts one call, the message, and no stored partial state. If T1 shows the intake route has no per-address limit, report it here and stop (adding one is ask-first).
  - Verify: `npm run test -- tests/intake && npm run typecheck`
  - Files: `tests/intake/provider-failure-handoff.test.ts` (and a one-line config or copy change only if the test shows a gap)
  - Depends on: T1.
  - **Done 6 Nov 2026**: 9 unit tests in `tests/intake/provider-failure-handoff.test.ts` (mocked: local fake HTTP server, no real model) plus the existing `tests/intake/openrouter.test.ts` (36 together pass) and `tests/db/intake-outage.test.ts` (14 pass on the local database: outage note, nothing invented, retry works). **A real gap found and fixed (spec amended first):** `lib/ai/openrouter.ts` refuses a paid primary model unless `allowPaidPrimary` is set, and `lib/ai/wiring.ts` never set it, so setting `OPENROUTER_MODEL=openai/gpt-oss-120b` on Vercel (T4) would have made every intake request throw. New `lib/ai/config.ts` (`openRouterConfigFromEnv`): an explicitly set `OPENROUTER_MODEL` is the opt-in; unset still means the free primary and the paid fallback (a test keeps that), and a paid primary chosen any other way is still refused. With the paid model as primary and the fallback variable unset, the fallback resolves to the same model, which the client treats as no fallback: tests show a 429 and a hang each make exactly one request, and a timeout is reported after one 300 ms timeout (so the wait on the hosted site is one 20 s timeout, not two). The defaults, for contrast, make two requests. **Rate limits:** the public flow is limited per address in `proxy.ts` (T1's finding 4 was wrong and is corrected in the baseline file). Files: `lib/ai/config.ts`, `lib/ai/wiring.ts`, `tests/intake/provider-failure-handoff.test.ts`.

- [x] **T3 Model soak script**
  - Acceptance: `npm run soak:model -- --base <url> --n 10` sends n sequential requests to the public customer flow using fixed prepared messages (no admin client, no secrets), measures wall-clock per request, and writes `doc/evidence/model-soak.md` (date, model name from the response or config name, durations, any provider failure, verdict). Pass: n of n complete, none above 20 s. The report builder is a pure function.
  - Verify: `npm run test -- tests/soak && npm run typecheck && npm run lint`
  - Files: `scripts/soak-model.ts`, `scripts/soak-report.ts`, `tests/soak/report.test.ts`, `package.json` (script entry only)
  - Depends on: T1.
  - **Done 6 Nov 2026**: `scripts/soak-report.ts` (pure verdict and report), `scripts/soak-model.ts` (drives the public flow with Playwright: open the store page, type one fixed prepared request, press "Start my request", time until the order room, read whether the hand-off message is shown), the `soak:model` script, 8 unit tests in `tests/soak/report.test.ts`. Pass rule: all n planned requests answered and none over 20 s; anything else is reported as "Not a pass" with no reliability claim. The report labels itself "real model, hosted" only for a non-local address, and a local run writes no file unless `--out` is given, so it cannot overwrite the hosted evidence. The model name is a `--model` label stated by the person running it (the public flow does not reveal it). **Smoke-tested only against a tiny local stand-in page** (4 requests, one made a hand-off): the output and verdict were right; it has not run against a real site yet (that is T4). It leaves n throwaway requests in the shop's inbox; n is capped at 20. The first version of the "T2 and T3" shell command wrote nothing because of a quoting error; the files were then written with the file tool. Full unit suite 1618 passed, typecheck and lint clean.

- [ ] **T4 Switch the hosted primary model and run the soak [YES]**
  - Acceptance: with your yes, `OPENROUTER_MODEL=openai/gpt-oss-120b` is set on Vercel (the code from T2 must be deployed first, or the variable would break the intake) and the fallback variable is unset or equal to it; you have set a credit limit on the OpenRouter key; redeploy; the soak runs against the hosted site and `doc/evidence/model-soak.md` is committed with the real result. A fail is recorded as it is and the reliability claim is not made.
  - Verify: the evidence file; the Devpost "Tools used" table matches the configured model.
  - Files: `doc/evidence/model-soak.md`, `doc/evidence/judge-readiness-hosted-baseline.md` (updated), `doc/submission/devpost-text.md` (tools table line only)
  - Depends on: T2, T3.

- [ ] **T5 `/developers` page**
  - Acceptance: public page with: the sentence "The agent can request and read; it cannot accept or pay."; the five-field contract generated from the route's Zod schema; one copyable `curl` for the 20-box demo; a shortened real response ($35.00 a box, $700.00 in cents, `humanUrl`, a coded-blocker example for the stock-limited quantity) built by code; the hand-off diagram with what the agent cannot do; the OpenAPI link; the limits read from the code's constants. No MCP, no autonomous payment. Linked from the home page footer. Claim scan clean; works at 390 px.
  - Verify: `npm run test -- tests/developers tests/claims-scan.test.ts && npm run test:e2e -- e2e/developers.spec.ts`
  - Files: `app/developers/page.tsx`, `lib/developers/example.ts`, `tests/developers/example.test.ts` (posts the page's example to the real handlers; parses the sample against the response schema), `e2e/developers.spec.ts`, `app/page.tsx` (link)
  - Depends on: none.

- [ ] **T6 Prepared demo requests**
  - Acceptance: `domain/demo/scripts.ts` holds fixed prepared messages keyed by store slug and key (the 20 welcome boxes messy request: notebooks, no food, a logo, under $40 a box; the change to 30). `startDemoRequest(key)` runs the same start action a typed request runs, redirects to the order room, and accepts only a known key (an unknown key does nothing; no text from the URL or form). The 30-box figures ($36.00 a box, $1,080.00; the kit shop's own figures) are asserted against the real engine in a test, not retyped.
  - Verify: `npm run test -- tests/demo && npm run test:db -- tests/db/demo-start.test.ts && npm run typecheck`
  - Files: `domain/demo/scripts.ts`, `app/demo/actions.ts`, `tests/demo/scripts.test.ts`, `tests/db/demo-start.test.ts`
  - Depends on: none.

- [ ] **T7 `/demo` page**
  - Acceptance: public page per spec 3.2: the four-part sentence; a button per existing store that starts the real flow; the "change to 30" story step with the plain stock explanation; the journey strip with where human approval begins; "What you need" (sandbox buyer in the Devpost notes, the shop owner's sign-in page, sandbox notice) with no password text; links to `/how-it-works`, `/developers`, the OpenAPI file, the repository, `proof-points.md`. Home page gets "See the complete flow". A missing store's button is not shown. Claim scan clean; 390 px.
  - Verify: `npm run test -- tests/claims-scan.test.ts && npm run test:e2e -- e2e/demo.spec.ts` (mocked: stand-in model, fake PayPal; the button reaches the real order room with the message sent)
  - Files: `app/demo/page.tsx`, `app/page.tsx`, `e2e/demo.spec.ts`, `tests/claims-scan.test.ts` (extend page list)
  - Depends on: T5, T6.

- [ ] **T8 Additive seed option for the second shop [ask first: touches scripts/]**
  - Acceptance: `npm run seed -- --only=demo-event-kits` creates or completes only the second shop and its owner (needs `DEMO_MERCHANT2_*`), never touches the first shop's stock, products or orders, is idempotent, refuses an unknown `--only` value, and still requires `--confirm-host` for a non-local database. Tests cover: first shop's rows unchanged with orders present, idempotent twice, unknown value refused.
  - Verify: `npm run test -- tests/seed && npm run test:db -- tests/db/seed-only.test.ts && npm run typecheck && npm run lint`
  - Files: `scripts/seed.ts`, `scripts/lib.ts`, `tests/seed/only-option.test.ts`, `tests/db/seed-only.test.ts`, `README.md` (command line only)
  - Depends on: your approval of the option.

- [ ] **T9 Second-shop gate: hosted journey or remove the claim [YES]**
  - Acceptance (default path): with your yes, add `DEMO_MERCHANT2_EMAIL` and `DEMO_MERCHANT2_PASSWORD` to Vercel and the hosted seed environment, run the additive seed once with `--confirm-host`, redeploy if needed, and run one hosted journey on Demo Event Kits (real model, PayPal sandbox), recorded in `doc/evidence/second-shop-hosted.md`. **If this is not done by the end of 8 Nov:** remove every second-shop claim from `devpost-text.md`, `video-script.md`, `screenshots.md`, the README and the checklist, and record the decision. Either way the claims equal what T1's baseline re-run shows.
  - Verify: the home page on the live site and the agent API's store list match the claims; `rg -i "event kit" doc/submission README.md` consistent with the outcome.
  - Files: `doc/evidence/second-shop-hosted.md` or the edited submission files, `doc/submission/final-checklist.md`
  - Depends on: T1, T8.

- [ ] **T10 Provenance labels**
  - Acceptance: the customer glossary gains three labels, "From your message", "You confirmed", "Calculated by us", mapped from the existing requirement statuses and quote lines, with a unit test on the mapping; not colour alone.
  - Verify: `npm run test -- tests/journey && npm run typecheck`
  - Files: `domain/journey/glossary.ts` (or its current home), `tests/journey/provenance.test.ts`
  - Depends on: none.

- [ ] **T11 Polish: home hero and flow diagram**
  - Acceptance: hero states the problem and the four-part line; a compact four-step diagram; "See the complete flow" and "Try it as a customer" buttons; no unmeasured claim; no sideways scroll at 390 px.
  - Verify: `npm run test:e2e -- e2e/home.spec.ts e2e/how-it-works.spec.ts` and a screenshot recorded
  - Files: `app/page.tsx`, `app/home-actions.tsx`, `app/globals.css`
  - Depends on: T7, T10.

- [ ] **T12 Polish: order room (request, price and stock, PayPal trust panel)**
  - Acceptance: provenance labels shown on the order card; the exact price and any stock blocker are the most prominent element, the swap and reprice shown as one change; the PayPal panel says in plain words that PayPal sets aside the amount, nothing is charged yet, and a "no" releases it, with the sandbox notice. Contrast and focus unchanged or better; reduced motion respected.
  - Verify: `npm run test:e2e` (order-room and journey specs) plus screenshots at desktop and 390 px
  - Files: the existing order-room components under `app/o/[token]/`, `app/globals.css` (at most five files)
  - Depends on: T10.

- [ ] **T13 Polish: merchant decision and conclusive result**
  - Acceptance: the decision screen shows the exact price and held amount with one Accept (charge) and one Decline (release), each saying what it does; after the decision both sides show a conclusive state (captured and prepared, or released and stock freed). Decision logic untouched.
  - Verify: `npm run test:e2e` (merchant and journey specs) and `npm run test:db -- tests/db/payments*.test.ts` unchanged and green
  - Files: existing merchant decision components under `app/merchant/`, the customer status component, `app/globals.css`
  - Depends on: T10.

- [ ] **T14 Submission rewrite**
  - Acceptance: `devpost-text.md` opens with the new product-difference paragraph (our claims policy, only built things), then technical depth; `video-script.md` rebuilt to the 2:45 story (12/33/20/30/20/25/18/7 seconds) with the test-count moment at a few seconds; `screenshots.md` lists the six frames and `/developers`; README top links `/demo` and `/developers`; seller-conversation file created from a question list only if you ask for it, otherwise the honest "not yet validated with sellers" sentence is used. All text scanned by the claims scan.
  - Verify: `npm run test -- tests/claims-scan.test.ts tests/readme.test.ts`
  - Files: `doc/submission/devpost-text.md`, `doc/submission/video-script.md`, `doc/submission/screenshots.md`, `README.md`, `doc/submission/seller-conversations.md` (optional)
  - Depends on: T4, T7, T9, T13.

- [ ] **T15 Merge, deploy, proof and hosted agent example [YES]**
  - Acceptance: with your yes, merge, deploy; `npm run proof` regenerated on the merge commit; the README "For agents" example run against production and the result recorded; `/demo`, `/developers`, `/how-it-works` and the OpenAPI file open on the live site; `final-checklist.md` updated line by line with evidence.
  - Verify: the evidence recorded; CI green on the merge commit.
  - Files: `doc/evidence/proof-points.md`, `doc/evidence/judge-readiness-hosted-baseline.md`, `doc/submission/final-checklist.md`
  - Depends on: T14.

- [ ] **T16 Fresh-tester run and checkpoint**
  - Acceptance: one person who has not seen the project completes the hosted journey using only the README and the Devpost notes; where they stuck is recorded and small fixes made. `doc/checkpoints/judge-readiness-checkpoint.md` reviews criteria 1 to 9 of the spec with evidence labels; `SPEC.md` status line updated.
  - Verify: read by you; full local gates green and counted.
  - Files: `doc/checkpoints/judge-readiness-checkpoint.md`, `SPEC.md`, `tasks/judge-readiness/todo.md`
  - Depends on: T15.

## Cut order if behind
T12/T13 (keep price and stock prominence and the PayPal trust panel), then T9 hosted journey (remove the claims), then seller conversations. Never T1 to T7, T14, T15, or payment, approval and access correctness.
