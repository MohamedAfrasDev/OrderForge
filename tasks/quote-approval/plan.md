# Plan: quote-approval

Spec: [doc/spec/SPEC-quote-approval.md](../../doc/spec/SPEC-quote-approval.md) · Task list: [todo.md](todo.md)

## Approach

Pure parts first, bottom-up and test first: canonical JSON, hash, snapshot, gate and the transition table, all with no database
or network. Then migration 0005 and the database tests that prove the transactions and races. Only then the services, and last
the two screens. A schedule squeeze can therefore cut only the merchant queue polish or quote history, never the gate, the hash
or the accept flow.

Every task is about five files or fewer, has its own verify step, and leaves `npm run typecheck`, `lint` and `test` green.
Money is integer cents through `lib/money.ts`. No new dependencies. The hosted database is touched only in the last task, after a fresh yes.

## Dependency graph

```
T1 types, schemas, canonicalJson, sha256 ─ T2 snapshot, hash, terms ─ T3 gate, transitions, expiry ─ T4 migration 0005 + DB tests
T4 ─ T5 services: draft, publish ─ T6 accept + verifyApprovalBinding ─ T7 customer card + E2E ─┐
T5 ─ T8 merchant review queue + E2E ──────────────────────────────────────────────────────────┴─ T9 checkpoint
```

## Phases and checkpoints

| Phase | Tasks | Needs a database or account? | Checkpoint |
|---|---|---|---|
| A. Pure logic | T1 to T3 | No | Golden hash and transition table pass; purity test green |
| B. Database | T4 | Local Supabase only | Races, guards and RLS proven on real Postgres |
| C. Services | T5, T6 | Local Supabase | Demo path A to F passes; double accept gives one approval |
| D. Screens and review | T7 to T9 | Local Supabase; hosted only after a fresh yes | Spec criteria ticked or explained |

## Risks and mitigation

| Risk | Mitigation |
|---|---|
| Hash input drifts, silently invalidating stored hashes | A committed golden hash; changing the canonical input is ask-first |
| Race between accept and publish | Both lock the inquiry row inside one RPC; a database test runs them concurrently |
| Trigger and TypeScript transition tables disagree | One test enumerates every status pair against both the TS table and the database trigger |
| Customer sees a draft or another inquiry's quote | Reads go only through the verified-inquiry functions; RLS and access tests |
| Intake does not exist yet | The existing dev action creates inquiry, requirement version and draft for tests and the demo |
