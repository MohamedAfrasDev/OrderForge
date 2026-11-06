# Checkpoint: impact-innovation (P1 and P2)

Date: 6 Nov 2026 · Module: `impact-innovation` · Reviewed against: [doc/spec/SPEC-impact-innovation.md](../spec/SPEC-impact-innovation.md) section 11 · Code reviewed: the working tree on top of `73cdb18` (tasks T1 to T7). **Nothing is committed or pushed yet**, so there is no CI run for this work.

Evidence is labeled **mocked** (stand-in model, fake PayPal, fake email), **scripted** (hand-written model answers in the real shape), **local** (Docker Supabase on this machine) and **hosted** (the deployed site). Nothing in this checkpoint was run against the hosted site; the hosted database, Vercel and the live site were not touched.

## Verdict

**Criteria 1 to 3 and 6 are met. Criteria 4 and 5 are met locally; their hosted halves are open and need your yes. Criterion 9 is met locally; CI and the secret scan of a pushed commit are open.** P3 (the agent endpoint) was not started: criterion 7 is not applicable yet.

Local gates on the reviewed tree (all from one `npm run proof -- --with-e2e` run, exit 0, plus lint and build): typecheck 0 errors, lint 0 problems, build succeeds (`/how-it-works` is prerendered static), **1473 unit, 1361 database and 142 browser tests passed, 0 failed, 0 skipped**. The generated file is [doc/evidence/proof-points.md](../evidence/proof-points.md).

## Criteria

| # | Criterion (spec section 11) | Verdict | Evidence |
|---|---|---|---|
| 1 | `/how-it-works` is public, free of forbidden words and unmeasured claims, states the problem, the idea and the three failure modes; the home page links to it | Met | `tests/claims-scan.test.ts` (23: the scanner itself, and the page text has no digits, no claim word, no system vocabulary); `e2e/how-it-works.spec.ts` (5: opens without login, rendered text scanned, links, home link, no sideways scroll at 390 px). **local** |
| 2 | `npm run proof` regenerates `proof-points.md` from real runs; every proof-map row points at an existing test; every result is labeled | Met | `tests/proof/proof.test.ts` (20: parsing, labels, a suite that did not run is reported "not run" and exits 1, every proof-map file exists, all 8 evaluation reports parse including their CRLF line endings). Real run today: exit 0 with all three suites. **local** |
| 3 | README first screen states the problem, the idea and the demo link; the brief's README requirements are met | Met, one item for T9 | `tests/readme.test.ts` (13: first screen, whole-file claims scan, every variable of `.env.example` named, required sections present, no secret shapes). The judges' sandbox shop login is deliberately not in the README (it goes in the Devpost notes, T9) |
| 4 | Two merchants seed idempotently; `demo:reset` handles both; the home page offers both; a missing store is not shown | Met locally; hosted open | `tests/seed/fixtures.test.ts` (15), `tests/db/seed-two-shops.test.ts` (5: both shops, two distinct owners, run twice changes nothing, bad logins refused), `tests/home-actions.test.ts`, `tests/db/demo-store.test.ts`, `e2e/home.spec.ts`. Today, against the **local** database with explicit local settings: `demo:reset`, `seed`, `demo:reset` each seeded both shops with an owner. Not run on the hosted project (see "Needs your yes") |
| 5 | The second shop runs the full journey under the stand-in model and fake PayPal, and once on the hosted site | Met locally; hosted open | `e2e/second-shop-journey.spec.ts` (**mocked**): 20 kits $33.50 a kit, $670, accepted, approved at the fake, the kit shop's own owner accepts, prepares and hands over, customer sees Collected, payment CAPTURED; 50 kits: bottle blocked (need 50, have 40), mug offered, $29.50 a kit, $1,475. Figures also asserted through the real engine in `tests/seed/fixtures.test.ts` and through a scripted turn in `tests/db/intake-shop-profile.test.ts`. Hosted run: not done |
| 6 | Cross-shop isolation holds on every server entry point | Met | `tests/db/shop-isolation.test.ts` (16: own-session reads return only the shop's own work; Today's counts A 1/1/1 and B 1/2/1; asking for the other shop's id gets nothing; decide, move a job, edit a product, add a product, reply, build a price by the other shop are all refused with PayPal receiving nothing and the data unchanged). Table-level row security: `tests/db/rls.test.ts` (existing). **local** |
| 7 | Agent endpoint (P3) | Not started | See the P3 decision |
| 8 | Submission pack (P4) | Not started | T9 |
| 9 | Payment, approval and access suites green on the last commit, CI green, no secret in the repository | Met locally; CI open | Payment, approval, reservation, access and fulfillment suites are inside the 1361 database and 142 browser tests above, none skipped or changed (the only edits to existing tests add checks or extend a list; nothing was removed or weakened). A pattern scan of all 38 changed or new files found no key, token or project reference; `.env` is gitignored; the README and `.env.example` are scanned by a test. **CI: not run, nothing is pushed** |

## What changed in existing behaviour

- `scripts/lib.ts`: `runSeed(db, env)` now seeds a list of shops, one owner each, and refuses identical owner emails, a short or placeholder password or a missing email.
- `domain/intake/prompts.ts` and `services/intake/turn.ts`: the first sentence of every prompt takes the shop's kind from the `shop_profile` rule. For the gift-box shop the four prompts are byte-for-byte unchanged (a test compares them), so `PROMPT_VERSION` stays `intake.v1` and the earlier real-model evaluation still describes that shop's prompts.
- `app/page.tsx`, `app/home-actions.tsx`, `lib/demo-store.ts`: the home page lists every demo store that exists.
- No migration, no new dependency. New environment variables: `DEMO_MERCHANT2_EMAIL`, `DEMO_MERCHANT2_PASSWORD` (seed script only; placeholders in `.env.example`).

## Found while checkpointing

1. **A test-isolation bug of mine, fixed.** My first second-shop spec called the shared `readyDemoShop`, which resets the gift-box shop's login and stock; run in parallel with the journey specs it made their shop sign-in fail twice in two full runs (the same two tests each time, passing alone). The spec now only makes sure the gift-box store row exists. After the fix, three full browser runs in a row passed (142 each) and the proof run passed. The single earlier failure noted under T7 was this same race.
2. **Hosted seeding is not as simple as running the seed.** The seed refuses to run when purchases exist, and the hosted project has orders from the recorded hosted runs. `demo:reset` would wipe them (and the evidence they back), and `--reset-stock-despite-orders` would put the first shop's stock back to fixture levels under live data, which is the corruption the guard exists to prevent. **Proposal (needs your approval, it adds a small option to the seed): `npm run seed -- --only=demo-event-kits`, additive, touching only the second shop and never the first shop's stock.** Until then the second shop cannot be added to the hosted site safely.
3. Your local `.env` points at the **hosted** Supabase project and does not have the two new variables. Run the hosted-affecting commands only with an explicit `--confirm-host`. I ran today's seed and reset checks with inline settings aimed at the local database.
4. Customer-facing text still says "boxes" for the event kits (the shared field is `boxCount`). A wording task, not a correctness one.
5. The second shop's behaviour on a real model is untested; only the stand-in and scripted models have run it.

## Needs your yes (none done)

1. Commit, push and open a pull request, so CI runs (criterion 9).
2. If you want the second shop on the hosted site: approve the `--only` seed option above; add `DEMO_MERCHANT2_EMAIL` and `DEMO_MERCHANT2_PASSWORD` to Vercel and the hosted seed environment; deploy; run that seed once with `--confirm-host`; then one hosted run of the second shop with the real model, the real PayPal sandbox and a real email to your address, recorded in `doc/evidence/`.
3. Redeploy so `/how-it-works` and the new README links exist on the live site (the page's proof link points at `main` and works once this is merged).

## P3 decision (the agent endpoint)

The gate in the plan (P1 and P2 checkpointed by the end of 8 Nov) is met two days early. **Recommendation: build the submission pack (T9) first, then P3 only if you still want it.** P3 is the only part that adds a public surface; its payoff is the "Best Use of Agentic Commerce" and Innovation story, its cost is four tasks and a new thing to keep safe. If you say go, T10 to T13 proceed in order with the same safeguards (no free text, no path to payment, rate limits); if you say no, they stay unticked and the cut is recorded.

---

# Update 6 Nov 2026, final: P3 (the agent request API) and the whole module (T14)

Code reviewed: branch `impact-innovation` at `47841d2` (pull request 12 against `main`; pull request 11, which carried P1 and P2, is merged). Evidence labels as above. Nothing hosted was touched.

## Verdict

**All nine criteria are met locally.** Criteria 4 and 5 have their hosted halves open, criterion 7 has its hosted run open, and criterion 9's CI and final secret scan are recorded below. Everything that remains needs a decision or a login only the owner has.

Final local gates, from one `npm run proof -- --with-e2e` run on `47841d2` (exit 0), generated into [doc/evidence/proof-points.md](../evidence/proof-points.md): **1604 unit, 1400 database and 153 browser tests passed, 0 failed, 0 skipped**; typecheck 0 errors, lint 0 problems, build succeeds.

## Criteria added or changed

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 7 | If P3 ships: spec 3.3 steps K to Q pass; the endpoint's figures equal the web flow's; no code path reaches a payment function; no free-text field exists | Met locally | **K, L, M:** `e2e/agent-api.spec.ts` (describe a shop; 20 kits $33.50 a kit, $670.00 in cents; 50 kits blocked, mug at $29.50, $1,475.00) and `tests/db/agent-requests.test.ts` (figures equal a scripted-model web turn: 20 boxes $35.00 / $700.00; 30 boxes blocked, swap $36.00 / $1,080.00). **N:** a price, a total, free text, a string number, zero boxes, an impossible date: 400 with coded issues, nothing stored (`tests/agent/schema.test.ts`, the browser spec with a canary budget, `tests/db/agent-api.test.ts`). **O:** `e2e/agent-human-handoff.spec.ts`: the person opens `humanUrl`, chooses, accepts the exact price and is sent to PayPal; the payment attempt is 6700 cents, the price the agent was shown. **P:** every wrong token (none, wrong, another request's, expired, revoked, a customer link, in the address) is the same 404 body. **Q:** a burst gets a 429 with `Retry-After` and the refused request creates nothing; reads have their own limit; the daily cap of 200 per shop is tested in the database. **No path to payment:** `tests/agent/no-payment-path.test.ts` walks the import graph from every file of the API. **No free text:** the schema is a strict object of five fields; the first message of the conversation is built by code. **mocked** (no model, fake PayPal) and **local** |
| 8 | Submission pack | Drafted, owner items open | `doc/submission/` (T9). Placeholders for the judges' logins and the Vercel model names; the video is not recorded |
| 9 | Payment, approval and access suites green on the last commit, CI green, no secret in the repository | Met locally; CI recorded | Same suites, none skipped or weakened. **CI on `47841d2`:** typecheck/lint/test/build passed, database tests passed, the Vercel preview deployment completed, and the browser job passed on one of the two runs while the other was still running when this was written. **Secret scan of all 529 tracked files on 6 Nov:** the only matches are placeholders in `.env.example` and obviously fake values in tests (a fake customer link, a fake Resend-shaped key, a fake OpenRouter-shaped key); `.env` is gitignored |

## What P3 added to the product's guarantees

- An agent can ask for a priced box and read it back; it cannot choose a price, accept one, pay, publish a quote or read another request. This is enforced three ways: the strict schema (five fields), the read-only token under its own key, and the import-graph test.
- Code chooses and prices the box with the catalog engine; no model is called for an agent request.
- Limits: 10 creates a minute per address, 60 a minute per shop, 60 reads and 60 browses a minute per address (in memory per server instance), and 200 requests per shop per day (from the audit trail, no table). Every create and read leaves an audit line with the shop, a coded outcome and a short fingerprint of the token; no token, address or input is recorded.
- No migration and no dependency were added by any part of this module.

## Found while building P3

1. **A real defect, found by the browser test and fixed (T13).** The assistant reply stored for an agent request was not linked to the message it answers, so the order room treated the request as unanswered: a stalled headline, and a "Try again" that would have run the assistant, and a real model, from the page. The reply now carries `reply_to`, with a database test. The unit and database tests had passed without noticing, which is why the browser test earns its place.
2. A test-isolation lesson repeated (see "Found while checkpointing" above): specs that share the second shop use `ensureKitShop`, which creates rows only if missing and resets nothing; only the second-shop journey resets that shop's stock and login.
3. Customer-facing text still says "boxes" for event kits, and the agent API's own field is called `boxCount`. A wording task, not a correctness one.

## Needs your yes (none done)

1. **Merge pull request 12** (it carries the submission pack and the whole agent API) and redeploy. Until then the live site has neither the agent routes nor the later commits.
2. **The second shop on the hosted site** still needs the additive `--only` seed option (proposed above), the two new variables on Vercel, a hosted seed with `--confirm-host`, and one hosted run of the second shop with the real model, the real PayPal sandbox and a real email to your address.
3. **The agent API on the hosted site:** after the deploy, one run of the README's example against the hosted address. It needs no new variable (it uses the existing access secret and base address). The limits are in memory per server instance, so a hosted instance counts its own requests.
4. The Devpost items in `doc/submission/final-checklist.md`: logins, model names, the video, the paste, the final rules check.

## Decision for you: how to describe P3 in the submission

The Devpost text now describes the agent API. It is a small, honest feature (five fields in, a code-priced box out, a person pays), so the text does not oversell it; the video script does not include it. If you want it in the video, it fits as five seconds in the "proof and a second shop" beat.
