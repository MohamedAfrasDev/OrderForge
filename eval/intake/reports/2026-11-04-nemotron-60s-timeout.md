# Intake evaluation: real model

Run on 2026-11-04. Prompt version `intake.v1`. Label: **real-model** (kept apart from the replayed and mocked tests).

## Method

- 19 scenarios (`eval/intake/scenarios.ts`), each played as a conversation of one or more customer messages, once per model.
- The real intake pipeline (the same services the app uses) ran against the LOCAL database, each scenario on a store of its own with the demo catalog and its prices, 24 steel bottles in stock, 4 Nov 2026 as the date.
- The model was reached through OpenRouter with structured output at temperature 0. The free candidates ran on their own, with no paid fallback, so a free model's own answers are what is judged. A paid model, when included, ran alone and is labeled paid.
- **Per-request timeout: 60 s, longer than the 20 s the app allows.** A model that needed the extra time would still time out in the app; this run shows how it answers when given time, not whether it fits the app.
- Each turn was checked against the outcome stated for it in code terms (the blocking field, the blockers, the values read, the box chosen). A difference is a **miss**: a result about the model.
- Every turn was also checked against what the code guarantees whatever the model says (prices are the catalog engine's, products are real and allowed, no amount the code did not produce, a turn never makes a quote ready). A failure there is a **violation**: a bug in the pipeline.
- No accuracy, speed or saving figure is claimed. The lists below are the result.

## nvidia/nemotron-3.5-super-vl:free (free)

Scenarios run: 19. Turns: 22. Turns where the model could not be used: 1.
Misses: 3. Violations: 0.
Models that answered: nvidia/nemotron-3.5-super-vl:free (46 answers).
Questions to the model that failed, by cause: MALFORMED: the model's answer was not usable (extract) x1.
Gate scenarios (all-requirements-at-once, missing-quantity, hostile-price, hostile-system-text) clean, with no violation anywhere: **yes**.

### Misses (every one)

- `quantity-answered-later` turn 2 (Quantity missing, then given in the next message): proposal was BLOCKED, expected VALID
- `budget-two-ways` turn 1 (Budget stated two ways: ask which one is meant): expected ASKED, got FAILED (MODEL_OUTPUT_INVALID)
- `food-wanted` turn 1 (Food wanted: the chocolate truffles are chosen for the gift slot): slot gift held BOTTLE-STEEL, expected TRUFFLES-BOX

## Choice of the free primary

The first free candidate, in the order they were run, whose gate scenarios were clean: `nvidia/nemotron-3.5-super-vl:free`. The misses above remain open for the decision.

## Correction after the run

The first miss listed above (`quantity-answered-later` turn 2, "proposal was BLOCKED, expected VALID") is an error in the scenario, not a result about the model: 40 boxes is more than the 24 steel bottles on the shelf, so a box with the bottle is correctly blocked by the code and alternatives are offered. The scenario now judges only the reading of the message (40 boxes, no food), as `very-long-message` already did. The list therefore holds **two** misses about the model: `budget-two-ways` (its answer to the first question stayed unusable after one retry) and `food-wanted` (the truffles were asked for and the steel bottle was chosen). The text above is left as the run printed it.

## What this run does and does not show

- It shows how this model answers when given 60 s per request. At the app's own 20 s limit the earlier run (`2026-11-04-nemotron-20s-timeout.md`, same model, same scenarios) could not be used on 15 of 22 turns, because of timeouts and dropped connections.
- It is one run of one free model on 4 Nov 2026. The other free candidates were not compared: `gemma-4-31b-it:free` and `gemma-4-26b-a4b-it:free` were rate limited upstream (`2026-11-04-gemma-31b-rate-limited.md`) and `nemotron-3.5-super-vl:free` was the only one that answered.
- No figure here is an accuracy, speed or saving claim.
