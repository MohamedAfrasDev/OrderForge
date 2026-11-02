# Plan: catalog-engine

Spec: [doc/spec/SPEC-catalog-engine.md](../../doc/spec/SPEC-catalog-engine.md) · Task list: [todo.md](todo.md)

## Approach

Build the pure engine first, bottom-up, test first, with no database, network or UI. Only when the whole engine reproduces the
demo path in unit tests do we add the database loader, and last the read-only page. This keeps the risky logic (blockers,
ordering, alternatives) provable on its own, and means a schedule squeeze can only ever cut the page.

Every task is small (about five files or fewer), has its own verify step, and leaves `npm run typecheck`, `lint`, `test`
green. Money is integer cents through `lib/money.ts`. No new dependencies.

## Dependency graph

```
T1 types + schemas ─┬─ T2 calculateQuote ─┐
                    └─ T3 validate: structure + product ─ T4 validate: constraints ─ T5 validate: stock + budget ─┐
T2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
                                                                                  T6 proposeAlternatives ◄──────┘
T6 ─ T7 model view + purity test + public exports ─ T8 seed template + loader + DB tests ─ T9 catalog page (cuttable) ─ T10 checkpoint
```

T2 comes before T3 because a valid result carries a priced configuration.

## Phases and checkpoints

| Phase | Tasks | Needs a database or account? | Checkpoint |
|---|---|---|---|
| A. Pure engine | T1 to T7 | No | Demo path A to D passes in unit tests; purity test green; typecheck, lint, test green |
| B. Data | T8 | Local Supabase only | Loader reads the seeded template from real Postgres; database tests green |
| C. Page and review | T9, T10 | Local Supabase; hosted only after a fresh OK | Success criteria in the spec ticked or explained |

## Risks and mitigation

| Risk | Mitigation |
|---|---|
| Blocker order or wording drifts and breaks consumers | The order is a table in T5's test; blocker codes are stable and changing one needs approval |
| Date arithmetic bugs (time zones, month ends) | Dates are plain `YYYY-MM-DD`, computed with UTC calendar math in one helper with edge-case tests; the engine never reads the clock |
| Alternatives search grows or becomes order-dependent | Bounded by slots x allowed products, capped at 20; a property test shuffles inputs and compares results |
| Seed change affects other tests or the README flow | T8 re-runs the whole suite; the new rule is additive (no existing row changes); README gets one line |
| Hosted data changes unexpectedly | No hosted write before T10, and then only after a fresh explicit OK |
| Scope creep into pricing rules or optional slots | Both are out by decision; any change goes through "ask first" |

## Parallelism

After T1, T2 and T3 are independent. Everything else follows the graph. One person, so in practice sequential.
