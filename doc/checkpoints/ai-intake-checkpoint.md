# Checkpoint: ai-intake review

Date: 4 Nov 2026 · Module: `ai-intake` · Reviewed against: [doc/spec/SPEC-ai-intake.md](../spec/SPEC-ai-intake.md) §11
· Code reviewed: branch `spec-6-ai-intake` (T1 to T10; no pull request opened yet).

Evidence is labeled **scripted** (hand-written model answers in the real shape, through the scripted fake provider; the spec calls
this **mocked**), **stand-in** (the rule-based local model, used only for the screens), **replayed** (answers a real model gave,
recorded and played back through the real pipeline), **real-model** (a live evaluation, kept in
[doc/evidence/ai-intake-real-model.md](../evidence/ai-intake-real-model.md)), **local** (Docker Supabase on this machine) and **CI**
(GitHub Actions). Nothing was applied to the hosted project: migration 0009 is local only. No hosted run has been done.

## Verdict

**10 of 10 criteria met locally.** Two things are open and are the user's: the free primary has not been shown to work (Gemma, the
configured one, was rate limited upstream all day and has not been evaluated), and the three hosted steps below are waiting for a
fresh yes. The module is not ready to rely on in the hosted demo until migration 0009 is applied and the branch is merged.

Local gates on the reviewed code: typecheck 0 errors, lint 0 problems, 1025 unit, 1253 database, 91 end-to-end tests.
Of those, the intake tests are 238 unit (13 files in `tests/intake`), 142 database (11 files, `tests/db/intake-*`) and 11 end-to-end.

## Criteria

| # | Criterion (spec §11) | Verdict | Evidence |
|---|---|---|---|
| 1 | Demo path A to H passes with exact figures, labeled replayed and mocked; the real-model evaluation of at least 15 scenarios is run and reported separately with its method and every failure | Met | **Scripted + local:** A and C (`intake-turn`: the specification with sources, no question, the bottle box at $35.00 per box, $700.00 for 20 boxes; the exact figure the spec gave as $36 was wrong, the $36.00 box is the organizer one, spec corrected). B one question about exactly the blocking field, in the model's words when they pass the check (`intake-turn`). D the same box at 30 boxes blocked by `INSUFFICIENT_STOCK`, the desk organizer offered at $36.00 per box, $1,080.00 (`intake-turn`). E picking it publishes a quote of $1,080.00 (`intake-choose`). F hostile text changes nothing (`intake-injection`, E2E). G outage and unusable output keep everything (`intake-outage`, E2E). H the clarification cap, a persisting conflict, the run cap and the customer's own request hand the inquiry over (`intake-turn`, `intake-handoff`). **Replayed + local:** recorded real answers replay through the same pipeline for all 19 scenarios, including the plain full request and the quantity change that breaks stock (`intake-eval-replay`). **Real-model:** 19 scenarios, 5 runs, method and every miss in the evidence file. The demo-path tests use scripted answers; the recorded real answers are the separate replay. |
| 2 | No model output can set a price, a discount, a quantity, stock, a blocking status or a state; strict schemas reject extra fields; an injection set leaves every figure unchanged | Met | Strict schemas with no price field (`tests/intake/extraction`, `questions`, `alternatives`, `stored`); an extraction carrying a price, discount, total, status, text for a number or a negative quantity is refused and nothing is saved; a proposal with an invented product, an extra field or a missing slot is refused; ranking and question wording that carry money of their own are dropped or replaced by code's (`intake-injection`, 16 tests). **Real-model:** 0 violations in every run that produced answers, with the two hostile messages in the set. local + scripted + real-model |
| 3 | Every configuration shown and every draft created passed `validateConfiguration` in the same step; unknown product, food under a no-food rule, over budget or out of stock is rejected before display | Met | The turn validates each proposal through the dispatcher; `chooseConfiguration` revalidates against live stock and the price shown, then `createQuoteDraft` validates again (`intake-turn`, `intake-choose`: stale stock, moved price, edited specification). A proposal that breaks the customer's own rules is BLOCKED by code (`intake-injection`). Unknown or disallowed products never reach display (`intake-injection`, `tools`). local + scripted |
| 4 | Code decides what blocks: `blockingFields` is pure and tested over every status combination; one question per turn, a fixed fallback always available, accepted from the model only after its check | Met | `tests/intake/requirements` (every status combination, the fixed order), `questions` (single question, no figures, no sensitive words, on topic), and the fallback when the model's wording fails or the model is down (`intake-turn`, `intake-injection`, `intake-outage`). local |
| 5 | A customer message gets exactly one assistant reply under races and retries (unique index test); a double submit stores one message | Met | Unique partial index on `messages.reply_to` (`intake-messages`: five replies at once leave one); five turn requests for one message at once leave one reply, one version, one state change (`intake-turn`); five identical submits store one message (`intake-start`, through the atomic `intake_post_message`). local |
| 6 | A provider failure, a timeout and two malformed answers keep the inquiry and messages, offer retry or handoff, never show a ready state; the fallback model is used only for provider failures | Met | `intake-outage`: each kind keeps the message with one note and no reply, retry works, a failed ranking or question carries on without the model. `tests/intake/openrouter`: the fallback only after a provider failure, never after a bad answer, 401 and 403 stop, at most four requests per question, the key never in a result. E2E: the outage screen offers "Try again" and "Ask the merchant to take over", no quote or proposal. **Real-model, observed:** 15 of 22 messages failed on timeouts and dropped connections in one run and nothing broke. local + scripted + real-model |
| 7 | The caps (messages, clarification turns, model runs, message length) hand over or refuse as specified | Met | 40 messages: refused and handed over with one note, once (`intake-start`); 3 clarification turns and a persisting conflict: handed over with the specification attached; 20 model runs: handed over with no model call (`intake-turn`); 4,000 characters, empty and NUL refused (`intake-start`, `shared`). local |
| 8 | Access: customers and merchants act only on their own inquiries | Met | Customer entry points take only a verified inquiry id; another customer's inquiry has no proposal to choose, a ghost is not found (`intake-choose`, `intake-handoff`); a forged link is not found and another customer's request shows nothing (E2E). Merchants: the list runs under the merchant's own session, so another merchant's id returns nothing and a visitor with no session is refused; a reply from another merchant is "not found" (`intake-merchant`, E2E). local |
| 9 | `domain/intake` passes the purity test; typecheck, lint, unit, database and E2E green locally and in CI; payment and access tests green | Met | `tests/intake/purity.test.ts` limits the domain's imports and bans clock, environment and `Math.random`. Local: figures above, including every payment and access test. **CI: green on pushes of the branch, all 8 most recent pushes, the last (`e5ad8de`) on the final code; the commit carrying this checkpoint is to be confirmed after it is pushed.** |
| 10 | The customer can describe a request, see and edit the specification, and reach a quote they can accept | Met | E2E (7 tests): no quantity, one question, "Make it 30 boxes", the organizer offered at $36.00 per box and $1,080.00, "Use this one", the quote card, accepted; a full request gets the $35.00 box and a changed specification gets a new proposal; plus the merchant side (4 tests): a handed-over inquiry, a reply the customer reads, isolation. local + stand-in |

## Hosted steps (not done; each needs a fresh yes)

1. **Apply migration 0009 to the hosted project,** with a dry run first and read-only checks before and after, as for 0007 and 0008. It
   adds one column, a unique index, a guard trigger and one function. Do this **before** merging and deploying: the new code reads and writes `messages.reply_to`.
2. **Set `OPENROUTER_MODEL` and `OPENROUTER_FALLBACK_MODEL` on Vercel.** They are optional and the code's defaults are the two models you chose, so I
   recommend not setting them (one fewer hosted change). `INTAKE_MODEL` must stay unset on Vercel; the app refuses the stand-in there.
3. **One hosted run of the full journey,** with you as the customer, real model. With Gemma rate limited, the paid fallback will
   answer most turns (cents). Recorded separately and labeled hosted.

## Findings from this review

1. **The first real-model run found a defect in this module** (the proposal schema, above in the evidence file), fixed with tests. The scripted and stand-in tests could not have found it.
2. **No free model has been shown to fit the app.** Gemma 31B and 26B were rate limited upstream; Nemotron was unusable at the 20 s limit and usable at 60 s. The paid fallback was reliable at 20 s. Decision recorded: keep Gemma as the primary and verify it when its limit lifts, then decide. Until then the first turn of a real inquiry on Gemma may fall back to the paid model after the free one fails.
3. **A turn that waits out a failing free primary can be slow.** A question that times out at 20 s goes to the fallback; a turn can ask up to three questions, and the page allows 60 s. A primary that mostly times out could push a turn past the page limit (the customer then sees the outage note and can retry). Not tested on Vercel; recommended when Gemma is evaluated: a shorter timeout for the free primary only.
4. **Two of my scenario expectations were wrong** (25 and 40 boxes against 24 bottles). Both were found by reading the real-run reports, corrected, and the report says so. The tests that exercise them were not weakened.
5. **The quote gate's "held" branch is exercised only by tests that supply a mandatory condition.** Intake itself produces no conditions today (`conditionsFor` defaults to none), so a customer's request never goes to `REVIEW_REQUIRED` through the gate, only through a handoff. If you want a real rule (for example artwork acceptance when a logo is required), it adds a merchant confirmation step to the demo.
6. **The stand-in model is not evidence about any model.** It reads quantities and keywords by rule, and the screens' E2E tests use it.
7. **Two intermittent test problems were found and fixed:** the E2E tests picked random client addresses that could collide with the addresses `access.spec` exhausts on purpose (now a private range, four clean runs); and the post-message tests used identical timestamps for two messages (earlier). Still seen occasionally and not diagnosed: the Supabase CLI sometimes reports "Stopped services" mid-run, which fails one database test file at load; and Docker Desktop stopped on its own several times. Both pass on rerun.
8. **Not covered by any test or run:** the 60-second page limit on Vercel; the logo check and file uploads (cut from this module); a real model on the hosted site; free providers may log prompts (the order room says the data is synthetic and not to enter real details).
9. **Customer edits announce themselves** with a numbered customer message ("I updated my requirements (change N).") so the assistant makes a fresh proposal; it appears in the conversation.

## Open items

1. Evaluate Gemma 31B free when its upstream limit lifts (`EVAL_MODELS=google/gemma-4-31b-it:free npm run eval:intake`), record it, and decide the primary.
2. The three hosted steps above, after a fresh yes; then open the pull request (none yet).
3. Optional, from earlier modules: the sandbox merchant id for `PAYPAL_PAYEE_MERCHANT_ID`.
