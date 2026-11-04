# Plan: ai-intake

Spec: [doc/spec/SPEC-ai-intake.md](../../doc/spec/SPEC-ai-intake.md) · Task list: [todo.md](todo.md)

## Approach

Pure logic first, test first: the requirements document, what blocks, the checks that decide whether a model-written string may be
shown, the ranking merge, the prompts and the inquiry state machine, with no database, network or model. Then the model port and its
OpenRouter client, proven against a local fake HTTP server (never the real network). Then the one small migration, the services,
and the turn pipeline, each proven with recorded model outputs (labeled **replayed**) and a scripted fake provider for failures
(labeled **mocked**). Only then the screens, the merchant page and the evaluation set. A schedule squeeze can therefore cut the
merchant reply box, richer wording and the evaluation's extra scenarios, never the guards: strict schemas, code-owned blocking and
validation, injection handling, the one-reply rule and the outage handoff.

Every task is about five files or fewer, has its own verify step, and leaves `npm run typecheck`, `lint` and `test` green. Money is
integer cents and comes only from the catalog engine. No new dependencies. Two optional environment variables
(`OPENROUTER_MODEL` free, `OPENROUTER_FALLBACK_MODEL` low-cost paid) were approved with the spec. The real model is touched only by
the manual evaluation (T10), on your OpenRouter key; the hosted database only in the last task, after a fresh yes.

## Dependency graph

```
T1 requirements domain ─ T2 questions, ranking, prompts ─ T3 model port + OpenRouter client ─ T4 migration 0009
T4 ─ T5 start, post, edit, reads ─ T6 turn pipeline ─ T7 choose + handoff ─ T8 customer screens ─ T9 merchant inquiries ─ T10 evaluation ─ T11 checkpoint
```

T3 needs T1 and T2 only for the schemas it validates against. T6 is the first task that calls the model port (always the fake in
tests). T10 comes late on purpose: it measures the finished pipeline, and its recorded outputs become the replayed fixtures.

## Phases and checkpoints

| Phase | Tasks | Needs a database, network or account? | Checkpoint |
|---|---|---|---|
| A. Pure logic and the model port | T1 to T3 | No (a local fake HTTP server only) | Blocking rules, checks and the client's failure handling pass; purity green |
| B. Database and services | T4 to T7 | Local Supabase; the fake model | Demo path A to H and every injection and outage case pass (replayed and mocked); one reply per message under races |
| C. Screens | T8, T9 | Local Supabase; the fake model | The journey works end to end in the browser; merchant sees a handed-over inquiry |
| D. Evaluation and review | T10, T11 | Your OpenRouter key (T10); hosted only after a fresh yes | 15+ scenarios reported with method and every failure, kept apart from the rest; spec criteria ticked or explained |

## Risks and mitigation

| Risk | Mitigation |
|---|---|
| The model sets a price, a discount or a status | Strict schemas with no such field; prices only from `calculateQuote`; blocking decided by `blockingFields`; an injection test set asserts nothing changes |
| A model-written sentence smuggles in an amount or a second question | `acceptQuestion` and `acceptExplanation` checks; a fixed fallback question always exists |
| The model invents a product or recommends an invalid option | Unknown SKUs rejected; every proposal and every alternative passes `validateConfiguration` in the step that shows it; `rankAlternatives` keeps only code's own list |
| A free model is rate limited, slow or disappears | Provider-failure fallback to the paid low-cost model, timeouts, retry or handoff, the inquiry always kept; evaluation checks several free candidates |
| Two requests answer one message twice | `messages.reply_to` with a unique index; the loser reads the winner's reply; a race test |
| An outage leaves the customer stuck or shown a fake ready state | A stored system message, retry and handoff actions, a test per failure kind |
| Evaluation results are over-claimed | The report gives counts, method and every failure only; replayed, mocked and real-model evidence are labeled and never mixed |
| Customer text reaches a free provider that may log it | Everything in this sandbox is synthetic and the order room says so; recorded in the checkpoint |
| Payment or access tests fail on 9 Nov | The brief's tripwire stops all feature work; they run in CI on every push |
