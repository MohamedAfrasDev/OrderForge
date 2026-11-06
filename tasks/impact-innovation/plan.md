# Plan: impact-innovation

Spec: [doc/spec/SPEC-impact-innovation.md](../../doc/spec/SPEC-impact-innovation.md) · Task list: [todo.md](todo.md)

## Approach

Cheapest and most valuable first. P1 (the case and the proof) changes no behaviour: a script that turns real test runs into a labeled
evidence file, a static page, and the README's first screen. P2 (a second seeded shop) proves the engine is data-driven and is the only part
that touches existing code (the seed, the intake prompt's shop name, the home page). Then a checkpoint, then P4 (the submission pack), then
P3 (the agent endpoint) only if P1 and P2 are checkpointed by the end of 8 Nov. P3 is the riskiest (a new public surface) and is the first
to be cut.

Every task is about five files or fewer, has its own verify step, and leaves typecheck, lint and the existing tests green. Nothing here
changes a state machine, a quote rule, a payment, a reservation or a job. **No migration, no new dependency.** The only new environment
variables are `DEMO_MERCHANT2_EMAIL` and `DEMO_MERCHANT2_PASSWORD` (placeholders in `.env.example`; set on Vercel only after a fresh yes).

## Findings that shaped the tasks (checked 6 Nov in the code)

- `demo_reset` truncates `merchants` and every application table, so two shops reset correctly with no change.
- `scripts/seed.ts` refuses to run when purchases exist; that guard already covers both shops.
- `decideMerchantAccess` takes the signed-in user's own merchant rows (row level security), so a second owner sees only their shop; T7 proves it.
- `domain/intake/prompts.ts` names a "custom gift-box merchant" and the model catalog view, and `app/page.tsx` + `lib/demo-store.ts` hard-code one slug.
  The product kind has no column, so it comes from a `shop_profile` business rule (seed data).
- `lib/rate-limit.ts` is an in-memory fixed-window limiter; P3 reuses it (no table, no migration).

## Dependency graph

```
T1 proof script ─┬─ T2 /how-it-works + home link ── T3 README top ──────────────┐
                 │                                                               │
T4 fixtures + second owner ─ T5 prompt takes shop name ─ T6 home lists stores ─ T7 isolation + second journey ─ T8 checkpoint (P1+P2)
                                                                                                                  │
                                                           T9 submission pack ─────────────────────────────────────┤
                                                                                                                  │
                                              [decision gate end of 8 Nov] T10 agent schema + service ─ T11 routes ─ T12 limits + no-payment test ─ T13 agent E2E ─ T14 final checkpoint
```

T1 to T3 and T4 to T7 are independent chains and can be done in either order; T8 needs both.

## Risks

1. The second shop's intake quality is untested on a real model; the stand-in and replayed models prove the pipeline, not the wording. The hosted run (T8, with a yes) is the real check.
2. `proof` runs the whole suite; the database suite needs the local Supabase. The script reads reports and fails clearly if a suite did not run (never writes zeros as passes).
3. Adding a second shop must not slow or loosen the existing demo path: the first shop's fixtures, ids and figures do not change, and its tests stay green untouched.
4. The 9 Nov tripwire: payment or access tests failing stops all feature work, including this module.
