# Plan: reservation

Spec: [doc/spec/SPEC-reservation.md](../../doc/spec/SPEC-reservation.md) · Task list: [todo.md](todo.md)

## Approach

Pure logic first (quantities, the transition table, the stock invariant), test first, with no database. Then migration 0006 and the
database tests that prove the hard parts on real Postgres: all-or-nothing reservation, the last-units race, no deadlocks, and the
rule that nothing in flight can be released. The operation and settle RPCs come next, then the sweep (the part with the timer-versus-
in-flight race), then the services, and last the two small screens. A schedule squeeze can therefore cut only the screens, never the
state machine, the RPCs or the sweep.

Every task is about five files or fewer, has its own verify step, and leaves `npm run typecheck`, `lint` and `test` green.
No new dependencies. The hosted database is touched only in the last task, after a fresh yes.

## Dependency graph

```
T1 pure logic ─ T2 migration 0006: columns, guard, reserve, release ─ T3 begin/settle/resolve ─ T4 sweep + invariant + reconcile wiring
T4 ─ T5 services: reserve, operations, release ─ T6 customer hold line + merchant holds page (cuttable) ─ T7 checkpoint
```

T3 depends on T2 because every RPC shares the guard trigger and the locking order. T4 needs T3 because the sweep's race is with `begin_operation`.

## Phases and checkpoints

| Phase | Tasks | Needs a database or account? | Checkpoint |
|---|---|---|---|
| A. Pure logic | T1 | No | Table, quantities and invariant pass; purity green |
| B. Database | T2 to T4 | Local Supabase only | Demo path A to H on real Postgres; races, guards and the invariant proven |
| C. Services | T5 | Local Supabase | Services refuse unaccepted or tampered quotes; audit events written |
| D. Screens and review | T6, T7 | Local Supabase; hosted only after a fresh yes | Spec criteria ticked or explained |

## Risks and mitigation

| Risk | Mitigation |
|---|---|
| Stock changes twice for one transition | Every stock change lives inside one RPC under the reservation's row lock and is attached to one transition; a repeat call returns the existing result; tests repeat and race each call |
| Deadlock between two multi-product reservations | Stock rows always locked in product-id order; a test runs opposite-order reservations in parallel |
| A timer releases stock while PayPal may be moving money | Timer can only update `HELD` rows with a conditional update; a test races the sweep against `begin_operation` and asserts one winner |
| TypeScript and trigger transition tables disagree | One test enumerates every state, event and operation pair against both |
| Stock drifts from reservations without anyone noticing | `check_stock_invariants()` is asserted after every database test file and exposed to the reconcile heartbeat |
| Changing the reconcile route breaks foundation's tests | The sweep is an injected dependency with a default no-op; the existing reconcile tests keep passing unchanged |
