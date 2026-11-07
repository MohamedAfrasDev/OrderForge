# Checkpoint: judge-readiness (J1 to J5)

Date: 7 Nov 2026 · Module: `judge-readiness` · Reviewed against: [doc/spec/SPEC-judge-readiness.md](../spec/SPEC-judge-readiness.md) section 10 · Code reviewed: merge commit `4ca3e21` (pull request 15) on `main`; pull request 16 adds only documents.

Evidence is labeled **mocked** (stand-in model, fake PayPal, fake email), **scripted**, **local** (Docker Supabase on this machine), **hosted** (the deployed site, read through public pages or the browser) and **real-model hosted** (a real model answered on the hosted site).

## Verdict

**Criteria 1 to 7 and 9 are met. Criterion 8 is not met: no fresh tester has run.** Finding 1 (the hosted gift-box stock) was found and fixed on 7 Nov 2026. The module is not finished until the fresh-tester run is recorded.

## Findings (read these first)

1. **FIXED 7 Nov 2026: the hosted gift-box shop could not make the 20-box demo request.** On 7 Nov 2026 the 20-box request on the live gift-box shop (pressed from the live `/demo` page, and again through the public agent interface) came back **blocked**: not enough steel water bottles, **4 available, 20 needed**, with the desk organizer offered at $36.00 a box, $720.00 in total. Earlier real-sandbox runs on the hosted site used up the stock. So on the live site the first step of the demo path does not give the $35.00 and $700.00 the home page, `/demo`, `/developers`, the Devpost text and the video script quote, and the 30-box story (24 bottles in stock) cannot be shown. (`/demo` and `/developers` take their figures from the seed data, not from the live stock, so they read correctly while the live shop does not.) The second shop is not affected: 20 kits came back valid at $33.50 and $670.00 the same day. **This is hosted data, not code.** It needs your decision, because every way of fixing it changes the hosted database: (a) the shop owner raises the steel bottle's stock to 24 in the shop's own catalog editor (the safe way: it keeps held and committed units consistent; needs the shop login); (b) `npm run demo:reset` on the hosted project (wipes all hosted application data, including the evidence orders, then re-seeds both shops; needs the second shop's login variables); (c) `npm run seed -- --only=demo-gift-boxes --reset-stock-despite-orders` (puts stock back to fixture levels; the README and the 6 Nov incident warn this breaks reserved and committed units when orders exist). I recommend (a). **Resolution:** you chose (a) and raised the steel bottle's stock in the shop's catalog editor. Re-checked the same day through the public agent interface (**hosted**): 20 boxes valid at **3500 cents a box, 70000 in total**; 30 boxes blocked, `INSUFFICIENT_STOCK`, 30 needed, **24 available**, one swap at **3600 and 108000**. Those are the figures on the home page, `/demo`, `/developers`, the Devpost text and the video script. **It will drain again:** one accepted 20-box order uses 20 of the 24 bottles, so check the live figures again right before recording the video and right before the fresh-tester run.
2. **No complete journey on the second shop has been run on the hosted site.** The real-model run reached the price review ($33.50 and $670.00; 50 kits blocked, mug at $29.50 and $1,475.00). Accepting, PayPal with the sandbox buyer and the shop's decision need your logins. The Devpost text says only what was run.
3. **No fresh tester has run** (criterion 8). The instructions are in `doc/submission/fresh-tester-script.md`. An assistant that has built the project cannot stand in for someone who has never seen it.
4. **The first hosted soak was not a pass** (one request of ten took 26.4 s against a 20 s limit); the second was. Both are recorded and no reliability claim is made. During this checkpoint the live `/demo` button took about 30 seconds to reach the order room once (a real model answer on the hosted site); the video script says to cut the wait.

## Criteria

| # | Criterion (spec section 10) | Verdict | Evidence |
|---|---|---|---|
| 1 | The hosted baseline is recorded and every claim matches what the hosted site serves, including the number of shops | Met (the gift-box stock was wrong on 7 Nov and was fixed the same day, finding 1) | `doc/evidence/judge-readiness-hosted-baseline.md` (**hosted**; baseline 6 Nov: one shop; re-check 7 Nov after the merge: both shops listed, all pages 200); `doc/evidence/second-shop-hosted.md` (**real-model hosted**). The Devpost text claims two shops and only the second shop's journey to the price review |
| 2 | The model soak passes (ten of ten, none above 20 s) and is recorded with the model name, or the result is recorded as it is and no reliability claim is made | Met | `doc/evidence/model-soak.md` (**real-model hosted**, not a pass: 10 of 10 answered, one at 26.4 s) and `doc/evidence/model-soak-run2.md` (a pass: 10 of 10, slowest 14.3 s). `openai/gpt-oss-120b` set on Vercel; key limit $10 stated by you. The text says "that is how the model behaved on those two runs, not a promise" |
| 3 | A provider failure reaches the shop hand-off after one timeout | Met (**mocked**; not shown on the hosted site, where a failure cannot be forced) | `tests/intake/provider-failure-handoff.test.ts` (9: a 429 and a hang each make one request; the defaults make two), `tests/db/intake-outage.test.ts` (14, **local**: the outage note, nothing invented, retry works) |
| 4 | `/demo` starts the real flow from a prepared request, marks where human approval begins, names the credentials needed and links the other pages; its figures equal the engine's | Met; on the live site the gift-box button opened the order room with the prepared message sent when pressed on 7 Nov (it landed on a stock-blocked answer before the fix in finding 1; 20 boxes now price at $35.00) | `tests/demo/scripts.test.ts` (10), `tests/db/demo-start.test.ts` (4, **local**, scripted model), `e2e/demo.spec.ts` (9, **mocked**), the hosted press (**real-model hosted**) |
| 5 | `/developers` shows the contract, a copyable `curl`, a real shortened response, the diagram, the OpenAPI link and the sentence about what the agent cannot do; its examples are tested against the real handlers and schemas | Met | `tests/developers/example.test.ts` (13), `e2e/developers.spec.ts` (7, **mocked**); the live page returns 200 with $35.00 and the coded stock answer. The README example was run against production (**hosted**, baseline file) |
| 6 | The six frames of section 3.4 are done and the existing browser journeys pass | Met | Home (T11), request and specification with labels (T10, T12), price and stock (T12), PayPal panel (T12), merchant decision and result (T13). 172 browser tests pass (**mocked**). Screenshots: `doc/evidence/screenshots/` (**local**; the gallery shots must be taken on the live site after finding 1 is fixed) |
| 7 | The submission opens with the new paragraph, the video script is at or under 2:45 on the story in section 3.5, the checklist is current and `proof-points.md` names the merge commit | Met | `doc/submission/devpost-text.md` ("What makes it different" first), `video-script.md` (beats of 12, 33, 20, 30, 20, 25, 18 and 7 seconds; tested), `final-checklist.md` (updated 7 Nov), `doc/evidence/proof-points.md` names `4ca3e21` |
| 8 | One fresh-tester run is recorded | **Not met** | Instructions written (`doc/submission/fresh-tester-script.md`); no run, no `doc/evidence/fresh-tester-run.md` |
| 9 | Payment, approval and access suites green on the last commit, CI green, no secret in the repository, claim scan clean on all new pages | Met; the secret scan is of this commit | CI on `4ca3e21`: all three jobs passed. `npm run proof -- --with-e2e` on `4ca3e21`: 1675 unit, 1414 database (includes the payment, approval, access and fulfillment suites), 172 browser tests passed. Claim scan: `tests/claims-scan.test.ts` covers the home page, `/demo`, `/developers`, the README and the submission pack. Secret scan on 7 Nov 2026: 576 tracked files searched for key, token and private-key patterns (none found) and each secret value in the local `.env` checked against every tracked file (the only matches are the public demo e-mail addresses documented in the README and `.env.example` and a sender address in two tests; no password, key or token). Rerun on the final commit |

## What changed in existing behaviour

- `lib/ai/config.ts` and `lib/ai/wiring.ts`: an explicitly set `OPENROUTER_MODEL` counts as the opt-in for a paid primary; an unset fallback resolves to the primary (one attempt). Defaults unchanged.
- `app/store/[slug]/start-flow.ts`: the typed form and the `/demo` buttons share one start function; the form action behaves as before.
- `proxy.ts`: posts to `/demo` are limited to 10 a minute per address.
- `scripts/lib.ts`, `scripts/seed.ts`: `--only=<shop>` seeds one shop; without it the seed is as before.
- Customer and shop screens (T10 to T13): wording and layout, plus one read-only query (`listRecentlyDecided`). No payment, approval, state-machine or access logic changed.

## Evidence labels used

mocked: browser specs, the soak report's unit tests, the demo and developers tests · scripted: the database demo-start tests · local: database suites, screenshots · hosted: public page and agent-interface checks · real-model hosted: the two soak runs, the second-shop run and the `/demo` press.

## What is left, and who does it

| Item | Owner |
|---|---|
| Run the fresh-tester run and record it | A person who has not seen it |
| One complete journey on the kit shop (accept, PayPal, decision) | You (logins) |
| Take the gallery screenshots and record the video on the live site, checking the stock figures first | You, with `screenshots.md` and `video-script.md` |
| Put the sandbox buyer and shop logins in the Devpost notes; paste the text | You |
| Rerun the secret scan on the final commit; add the repository description | Me, on your yes for the description |
