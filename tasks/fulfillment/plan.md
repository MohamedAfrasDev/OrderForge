# Plan: fulfillment

Spec: [doc/spec/SPEC-fulfillment.md](../../doc/spec/SPEC-fulfillment.md) · Task list: [todo.md](todo.md)

## Approach

Pure logic first, test first: the job state machine, the worksheet builder and the customer wording, with no database or network.
Then migration 0008 in two slices (create, then move and the missing-jobs query), each proven on real Postgres with its races
before any service calls it. Then the services, then the two wirings (the accept action and the reconcile route), and last the
screens. A schedule squeeze can therefore cut only the status wording and the optional auto-refresh, never the uniqueness, the paid
check, the frozen worksheet or the access checks.

Every task is about five files or fewer, has its own verify step, and leaves `npm run typecheck`, `lint` and `test` green.
No new dependencies and no new environment variables. This module sends nothing to PayPal; the fake PayPal is used only to produce
paid purchases through the existing `payments` services. The hosted database is touched only in the last task, after a fresh yes.

## Dependency graph

```
T1 pure logic ─ T2 migration 0008: create ─ T3 move + missing jobs ─ T4 services ─ T5 wiring (accept action, reconcile route) ─ T6 screens ─ T7 checkpoint
```

T3 depends on T2 because both functions share the guard triggers and the event rules. T5 depends on T4 because it only calls the
services. T6 needs T5 so the screens show jobs that real flows create.

## Phases and checkpoints

| Phase | Tasks | Needs a database or account? | Checkpoint |
|---|---|---|---|
| A. Pure logic | T1 | No | Table, worksheet and wording pass; purity green |
| B. Database | T2, T3 | Local Supabase only | One job per paid purchase under ten parallel creations; unpaid refused in the database; immutability and double-click proven on real Postgres |
| C. Services and wiring | T4, T5 | Local Supabase and the local fake PayPal (labeled mocked) | Demo path A to F and H pass; the reconcile run creates missed jobs |
| D. Screens and review | T6, T7 | Local Supabase; hosted only after a fresh yes | Spec criteria ticked or explained; hosted check recorded and labeled |

## Risks and mitigation

| Risk | Mitigation |
|---|---|
| Two jobs for one purchase (repeated click, accept racing the reconcile run) | The unique constraint on `purchase_id` already exists; creation is `on conflict do nothing` under the purchase lock; parallel and racing tests |
| A job for money that was not really taken | The database function re-checks a `CAPTURED` attempt and a `COMMITTED` reservation itself; tests cover every unpaid state, including a caller that lies |
| The worksheet drifts from what the customer accepted | Built only from the verified snapshot (`verifyApprovalBinding`), frozen by a trigger; a test changes the catalog afterwards |
| A missed job (capture settled out of doubt, accept action failed) | The reconcile route creates jobs for every paid purchase without one; the accept action's failure never fails the accept; tested |
| The customer sees merchant-only information | The customer read returns a fixed coarse shape; a test asserts exactly its keys |
| The reconcile run is slowed or broken by job creation | Runs after payments and before the sweep, per-purchase isolation, bounded batch; an error still lets the rest finish and then fails visibly |
| A hosted migration surprise | 0008 is local until a fresh explicit yes, with read-only checks before and after, as for 0005 to 0007 |
| Payment or access tests fail on 9 Nov | The brief's tripwire stops all feature work; they run in CI on every push |
