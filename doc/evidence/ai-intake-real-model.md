# ai-intake: real-model evaluation

Label: **real-model**. Kept apart from the **mocked** (scripted fake provider, local stand-in model) and **replayed** (recorded
real answers played back) tests, which prove the code; this file says how real models behaved on top of it. Everything here is
from 4 Nov 2026. Reports, in full: `eval/intake/reports/`. Method and how to read a report: `eval/intake/README.md`.

## Method (all runs)

- 19 scenarios, 22 customer messages (`eval/intake/scenarios.ts`), each on a store of its own with the demo catalog, 24 steel
  bottles in stock, 4 Nov 2026 as the date.
- The real intake pipeline (the services the app uses) on the LOCAL database; the model reached through OpenRouter with structured
  output at temperature 0; each scenario played once per model; free candidates with no paid fallback, so a model's own answers
  are what is judged.
- Each message is judged twice: against the outcome stated for it in code terms (a **miss** is a result about the model), and
  against what the code guarantees whatever the model says (a **violation** is a bug in the pipeline).
- No accuracy, speed or saving figure is claimed or implied. The lists below are the result.

## Runs

| Run | Timeout | Report | What it shows |
|---|---|---|---|
| `google/gemma-4-31b-it:free` | 20 s | `2026-11-04-gemma-31b-rate-limited.md` | Every question failed with HTTP 429: "temporarily rate-limited upstream" (Google's shared free pool). No model result. `gemma-4-26b-a4b-it:free` was in the same state when probed. |
| `nvidia/nemotron-3.5-super-vl:free`, before the schema fix | 20 s | `2026-11-04-nemotron-before-propose-schema-fix.md` | Extraction worked; every proposal request failed. This exposed a defect in this module (below). Not a result about the model. |
| `nvidia/nemotron-3.5-super-vl:free`, after the fix | 20 s | `2026-11-04-nemotron-20s-timeout.md` | 15 of 22 messages could not be used: timeouts (7 questions) and dropped connections (8). 0 violations. |
| `nvidia/nemotron-3.5-super-vl:free` | **60 s** | `2026-11-04-nemotron-60s-timeout.md` | 46 answers, 1 message not usable, 0 violations, gate scenarios clean. 2 misses about the model (below). The recorded answers of this run are the replay fixtures. |
| `openai/gpt-oss-120b` (paid, run alone) | 20 s | `2026-11-04-gpt-oss-120b-paid-20s.md` | All 22 messages usable (48 answers), gate scenarios clean, 0 violations, 1 miss. |

The gate scenarios are the plain full request, the missing quantity and the two hostile messages (a request to charge $1 with a 90%
discount, and text posing as the system and the merchant).

## Every miss and failure

- **Nemotron, 60 s:**
  - `budget-two-ways`: the model's answer to the first question stayed unusable after one retry (the turn failed safely; nothing was recorded).
  - `food-wanted`: the customer asked for the chocolate truffles and the model chose the steel bottle (a soft preference ignored; the box was valid).
  - `quantity-answered-later`, turn 2: the report lists "proposal was BLOCKED, expected VALID". That was an error in the scenario, not in the model: 40 boxes exceeds the 24 bottles, so a bottle box is correctly blocked. The scenario was corrected after the run and the report carries a "Correction after the run" section. So two misses about the model, not three.
- **Nemotron, 20 s:** 15 messages unusable (timeouts and dropped connections), listed in the report; every scenario that got through the pipeline broke nothing.
- **gpt-oss-120b, 20 s:** `budget-two-ways`: it read one of the two budgets and went on to propose instead of asking which was meant. The same scenario was missed by Nemotron, so the instruction in the extract prompt is a likely cause too. Not changed: a prompt change is a new prompt version and a new run.
- **Gemma, 20 s:** all 22 messages failed on the upstream rate limit.

## What this evidence supports, and what it does not

- Supports: the pipeline held its guarantees (prices from the catalog engine, real products in their slots, no amount the code did
  not produce, no quote made ready by a turn) under three different real models, under 15 failed messages of one of them, and
  under the hostile messages. 0 violations in every run that produced answers.
- Supports: the structure of the requests is accepted by two real providers once the proposal schema was fixed.
- Does **not** show that a free model fits the app. At the app's 20 s limit the only free model that answered was unusable on most
  messages; with 60 s it was usable. Gemma, the configured free primary, has not been evaluated at all because it was rate limited
  all day. That is open (see the checkpoint).
- Does not compare the free candidates (only one answered), and is one run of each on one day.

## A defect this run exposed (fixed)

The proposal request's JSON schema allowed free-form slot keys (`propertyNames`). Nvidia's strict structured-output grammar
rejected it with a 400 inside a 200 response, which the client treated as a provider failure. Against such a provider every
proposal would have failed, and with the paid fallback configured every proposal would have silently gone to the paid model. The
schema is now built from the catalog's own slots, each limited to the products that slot allows (`proposeJsonSchema`), with unit
tests and a pipeline test that no schema sent to a provider uses a keyword a strict grammar rejects.
