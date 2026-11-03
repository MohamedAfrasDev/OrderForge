# Intake evaluation

A manual run of the intake pipeline against a **real model**, plus the replay of one such run in CI. Real-model results are kept apart
from everything else: the replayed and mocked tests prove the code, this run says how a model behaves on top of it.

## What it is

- `scenarios.ts`: 19 scenarios, each one or more customer messages and the outcome that is right, in code terms (the field the
  question is about, the catalog blockers, the values read, the box chosen, the exact price per box).
- `harness.ts`: plays a scenario through the **real** intake services (the ones the app uses) on the local database, with any model
  port, and reads back what happened after every message.
- `score.ts`: judges each message two ways (below).
- `run.ts`: the manual real-model run. `report.ts`: writes the report.
- `fixtures/replay.json`: the answers one real run gave, recorded; `tests/db/intake-eval-replay.test.ts` feeds them back through the
  pipeline in CI.

## Running it

It needs the local stack (`supabase start`, Docker) and `OPENROUTER_API_KEY` in `.env`. Only that key is read from `.env`; the
database is always the local one (credentials from `supabase status`), never the hosted project. At the end it clears the local
application data, like the database tests do (run `npm run seed` afterwards if you want the demo data back).

```bash
npm run eval:intake
```

| Variable | Meaning | Default |
|---|---|---|
| `EVAL_MODELS` | Comma-separated free (`:free`) candidates, run one after another, **each on its own with no paid fallback** | the three free candidates in the spec |
| `EVAL_PAID` | Comma-separated paid models to run too, each alone and labeled paid (this spends money: cents) | none |
| `EVAL_ONLY` | Comma-separated scenario ids, for a quick trial | all |
| `EVAL_PACE_MS` | Gap between requests, so the free tier's rate limit does not decide the result | `3000` |
| `EVAL_RECORD` | A model id from this run whose answers become `fixtures/replay.json` | none |

OpenRouter limits free models (a few requests a minute, and a small number a day for an account without credit). A run that hits a
limit shows it as turns where the model could not be used; it is not hidden.

The report is written to `eval/intake/reports/<date>.md`.

## How to read the report

- **Misses** are where a model's result differs from the outcome stated for the scenario: it asked about the wrong field, chose the
  wrong product, read a number wrongly. They are results **about the model**. Every one is listed in full.
- **Violations** are where something the **code** guarantees did not hold: a price that is not the catalog engine's, a product that
  does not exist or is not allowed in its slot, an amount in a reply that code did not produce, a turn that left a quote ready. Any
  violation is a bug in the pipeline, whatever the model did. There should be none; the run fails if there is one.
- **Turns where the model could not be used** count provider failures, timeouts and answers that stayed unusable after one retry.
- **Models that answered** shows which model gave each answer. With no fallback configured it is only the candidate itself.
- **Gate scenarios** (the plain full request, the missing quantity, the two hostile messages) must go cleanly, with no violation
  anywhere, before a model can be the primary. The report names the first free candidate that does, or says that none did, in which
  case the decision is yours before any paid model becomes the primary.

The report gives counts of what was run and lists of what went wrong. It does **not** give an accuracy, a pass rate, a speed or a
saving, and neither should anything quoted from it: the brief does not allow a claim of that kind.

## The replayed fixtures

`EVAL_RECORD=<model id> npm run eval:intake` also writes the parsed answers of that model to `fixtures/replay.json`. In CI the
database test feeds them to the pipeline in place of the model and checks that the same things are observed and that the code's
guarantees hold on every turn. Label them **replayed**: they are real answers played back, not a new run, and a model's misses in
them are not test failures. After a prompt change (`PROMPT_VERSION`), record again.
