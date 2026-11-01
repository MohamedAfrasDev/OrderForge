# Plan: foundation

Spec: [doc/spec/SPEC-foundation.md](../../doc/spec/SPEC-foundation.md) · Task list: [todo.md](todo.md)

## Approach
Build everything that needs no cloud account first, then add PayPal behind mocks, and leave the hosted-account work for last. This protects the schedule: accounts are created later, and the 3 Nov CAPTURE tripwire needs only the final phase.

Local Supabase (Supabase CLI + Docker) stands in for the hosted project until the human creates it. If Docker is unavailable, phase B tasks that run `supabase db reset` are blocked and the SQL is still written and reviewed.

## Dependency graph
```
T1 repo+vitest ─┬─ T2 playwright+shadcn ─┐
                ├─ T3 CI (core) ─────────┤
                ├─ T4 money              │
                ├─ T5 env                ├─ T6 banner/landing
                ├─ T7 correlation+audit  │
                └─ T8 customer link      │
T9 supabase init + core tables ─ T10 payment/constraint tables ─ T11 RLS+seed+reset ─ T12 DB tests ─ T13 CI db job
T5,T11 ─ T14 supabase clients + merchant auth ─ T15 customer link routes
T4,T5 ─ T16 paypal client (mocked) ─ T17 webhook ─┐
T5,T11 ─ T18 cron route + 0004 + health ──────────┤
T16 ─ T19 paypal spike CLI + dev page ────────────┘
[needs accounts] T20 hosted wiring ─ T21 real sandbox evidence ─ T22 README final
```

## Phases and checkpoints
| Phase | Tasks | Needs accounts? | Checkpoint |
|---|---|---|---|
| A. Tooling and pure libs | T1–T8 | No | `typecheck`, `lint`, `test`, `build` green locally and in CI |
| B. Database and access | T9–T15 | No (local Supabase) | `supabase db reset` clean; `test:db` green; access tests green |
| C. PayPal behind mocks | T16–T19 | No | Mocked and replayed PayPal tests green; spike CLI dry-runs against a fake server |
| D. Hosted proof | T20–T22 | Yes | Real sandbox authorize+capture and authorize+void recorded; README final |

## Risks and mitigation
| Risk | Mitigation |
|---|---|
| Accounts created late, shrinking slack before the 3 Nov tripwire | Phases A–C need none; T20–T21 are sequenced right after the accounts exist and T21 is the first thing run |
| No Docker, so no local Supabase | Write SQL anyway; run DB tests on the hosted project as soon as it exists |
| Next.js 16 API differences (`proxy.ts`, `cacheComponents`) | Read the relevant doc in `node_modules/next/dist/docs/` before T6, T14, T17, T18 |
| PayPal webhook event names or verification details differ from memory | T17 checks PayPal docs first and records verified names in the spec |
| `pg_cron` / `pg_net` / Vault unavailable locally | `0004_cron.sql` is guarded, so skipped rather than failing |
| shadcn with Tailwind 4 and the custom turbopack CSS rule | T2 verifies `build` after init and stops to ask if it conflicts |

## Parallelism
T4, T5, T7, T8 are independent after T1. T16 can run alongside phase B. Everything else follows the graph.
