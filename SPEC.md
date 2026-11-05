# Capability Map and Project Spec: OrderForge

Source: `doc/OrderForge Build Brief v1.1.md` (content titled v1.2, dated 1 Nov 2026). The brief is the source of truth for product behaviour; this file is the index of module specs plus the project-wide conventions they share.

Status: capability map approved 2026-11-01. Module specs live in `doc/spec/`. `foundation`: DONE (tasks T1 to T22; Checkpoint D passed on 2 Nov, 14 of 15 criteria met, the one unmet is sandbox authorization expiry, which cannot be observed before the deadline; record in `doc/checkpoints/`). Next module in build order: `catalog-engine` (spec first, as `AGENTS.md` requires). CI: GitHub Actions.
`catalog-engine`: DONE (tasks T1 to T10; checkpoint 2 Nov, 9 of 9 criteria met, CI green on the last commit; record in `doc/checkpoints/catalog-engine-checkpoint.md`).
`quote-approval`: BUILT (tasks T1 to T9; checkpoint 2 Nov, 11 of 11 criteria met, CI green on 5c2507c (PR 2); migration 0005 applied to hosted; record in `doc/checkpoints/quote-approval-checkpoint.md`).
`reservation`: BUILT (tasks T1 to T7; checkpoint 2 Nov, 11 of 11 criteria met, CI green on 6609daa (PR 3); migration 0006 applied to hosted; record in `doc/checkpoints/reservation-checkpoint.md`). Next modules in build order: `ai-intake` (spec first) and `payments` (spec APPROVED 2 Nov in `doc/spec/SPEC-payments.md`; tasks approved, T1 to T9 built; checkpoint written 3 Nov, 12 of 12 criteria met, CI green (PR 4, merged), migration 0007 applied to hosted 3 Nov, real-sandbox runs done 3 Nov (race found and fixed in the follow-up PR); record in `doc/checkpoints/payments-checkpoint.md`).
`fulfillment`: BUILT (tasks T1 to T7; checkpoint 3 Nov, 10 of 10 criteria met, CI green on e6f17ea (PR 6, merged); migration 0008 applied to hosted; hosted checks done 3 Nov; record in `doc/checkpoints/fulfillment-checkpoint.md`).
`ai-intake`: spec APPROVED 3 Nov 2026 (`doc/spec/SPEC-ai-intake.md`); task list approved; build in progress: T1 to T10 done; T11 checkpoint written (10 of 10 criteria met locally), 0009 APPLIED to hosted 4 Nov; the hosted journey run and the Gemma evaluation open.

`product-pass`: spec APPROVED 4 Nov 2026 (defaults; `doc/spec/SPEC-product-pass.md`); task list approved 4 Nov 2026 (`tasks/product-pass/`, T0 to T16); T0 to T12 built (AG Grid 36.2.0 spike on the catalog page; the pure `domain/journey` with the customer glossary). A customer-first redesign (journey strip, live order summary with quick replies, plain price and PayPal explanation, keep-this-page, a way in from the home page), the shop's Today, Build a quote, and, at the user's direction, shop product add and edit, email notifications (Resend, chosen 4 Nov; migration 0010, optional environment variables) and AG Grid Community for the shop's data grids (new dependencies), plus chained end-to-end tests. About fifteen tasks; cut order in section 11.

## 1. Objective

OrderForge turns one vague custom-order request into an approved, PayPal-authorized order. The merchant confirms it and then prepares it from an exact worksheet.

- **Scope of v1:** one seeded gift-box merchant, USD only, full payment, customer pickup, one PayPal sandbox merchant as payee.
- **Users:** the customer (sends a request, accepts one exact quote version, authorizes payment, tracks status) and the merchant (confirms or declines production conditions, prepares the order).
- **Principle:** code decides money, stock, permissions and state. The model interprets, proposes and explains.
- **Claims policy:** everything is sandbox-only, data is synthetic, and no demand, time-saving or accuracy claim is made until measured.
- **Deadline:** 12 Nov 2026 12:00 PST (13 Nov 01:30 Sri Lanka). Target submission is 18:00 on 12 Nov Sri Lanka time.

### Demo path (every decision serves this)
1. The customer sends a messy request (20 welcome boxes, notebooks, no food, logo, under $40 per box).
2. The AI shows a visible specification with confirmed and unknown fields, and asks only blocking questions.
3. A configuration with a bottle is valid for 20. At 30 only 24 bottles are in stock, so it becomes invalid and a desk organizer is proposed. Code revalidates every requirement.
4. Code computes the quote: $12 + $3 + $14 + $2 + $5 = $36 per box, $1,080 for 30.
5. The customer accepts that exact quote version, and PayPal authorizes and holds the funds.
6. The merchant records a decision. Accepted means capture. Declined means void and release stock.
7. One worksheet is created from the accepted quote, and the customer sees live status.
8. A labeled duplicate-capture test shows no second charge and no second job.

## 2. Capability map

| Module id | Responsibility | Depends on | Spec file |
|---|---|---|---|
| `foundation` | Next.js app setup, Supabase schema and migrations, seed fixtures, merchant login, customer signed-link access, audit events, env/secrets handling, sandbox banner, thin PayPal sandbox authorize/capture/void spike | none | `doc/spec/SPEC-foundation.md` |
| `catalog-engine` | Products, stock reads, business rules (e.g. `food: false`), `validate_configuration`, bounded candidate search, integer-minor-unit pricing, coded blockers (e.g. `INSUFFICIENT_STOCK`) | foundation | `doc/spec/SPEC-catalog-engine.md` |
| `quote-approval` | Immutable quote versions, SHA-256 over canonical JSON, publish and merchant-review gate, approval bound to the quote hash, supersede/expire | catalog-engine | `doc/spec/SPEC-quote-approval.md` |
| `reservation` | Single Postgres RPC reserving stock with row locks, reservation state machine, release/commit. Timers never release stock while a PayPal operation may be in flight | foundation, quote-approval | `doc/spec/SPEC-reservation.md` |
| `payments` | Payment attempt state machine, Orders v2 AUTHORIZE, capture and void, stable `PayPal-Request-Id`, `OUTCOME_UNKNOWN` reconciliation, webhook verification and dedupe, merchant decision record with confirm/decline exclusivity | reservation, quote-approval | `doc/spec/SPEC-payments.md` |
| `fulfillment` | One preparation job per paid purchase (unique constraint), worksheet from the accepted quote snapshot, live customer status | payments | `doc/spec/SPEC-fulfillment.md` |
| `ai-intake` | OpenRouter extraction with Zod, requirement statuses, clarification limited to code-marked blockers, ranking and explaining alternatives, tool allowlist and iteration cap, prompt-injection handling, model-outage handoff, 15+ scenario eval set. Optional logo check is a separate cuttable slice | catalog-engine, quote-approval | `doc/spec/SPEC-ai-intake.md` |

**Build order:** `foundation` → `catalog-engine` → `quote-approval` → (`reservation` ∥ `ai-intake`) → `payments` → `fulfillment`

Rules for the map:
- Module ids are stable and never renamed.
- Dependencies point one way. Interface contracts live in the provider module's spec.
- UI (customer order room, merchant portal) is built inside each module as vertical slices; there is no separate UI module.
- The test matrix, README and submission checklist are cross-cutting. Each module spec owns its rows of the brief's test table, and submission work gets its own final task list.
- **Payments spike:** the thin PayPal authorize/capture/void spike lives in `foundation` so the 3 Nov tripwire (fall back to intent CAPTURE) can be decided early. If the fallback fires, every spec touching the payment flow must be updated before building continues.

## 3. Project-wide conventions (inherited by every module spec)

### Tech stack
Next.js 16.4.3 (App Router), React 19.3.0, TypeScript, Tailwind CSS 4, shadcn/ui, Supabase (Postgres, Auth, private Storage), OpenRouter + Zod, PayPal JS SDK / Orders v2 / Payments v2, Vitest, Playwright, Vercel. Pin all versions and commit the lockfile when the build starts. `AGENTS.md` warns that this Next.js version differs from older releases. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code.

### Commands
Existing:
```
Dev:   npm run dev
Build: npm run build
Lint:  npm run lint
```
Planned (added by `foundation`; names are proposals):
```
Unit/rules tests: npm run test            # vitest run
Test with coverage: npm run test -- --coverage
DB tests:         npm run test:db         # against local/test Supabase
E2E:              npm run test:e2e        # playwright test
Typecheck:        npm run typecheck       # tsc --noEmit
Migrate:          supabase db push (or documented equivalent)
Seed / demo reset: npm run seed, npm run demo:reset
```

### Project structure (proposed; finalized in `doc/spec/SPEC-foundation.md`)
```
app/                  Next.js routes: /store/[slug], order room, merchant portal, API routes, webhook
src/domain/           Pure business logic, no framework imports (rules, pricing, state machines, hashing)
src/services/         Business services (quote, reservation, payments, fulfillment, ai)
src/lib/              Shared utilities (money, env, supabase clients, paypal client)
supabase/migrations/  SQL schema, constraints, reservation RPC
supabase/seed/        Synthetic fixtures
tests/                Vitest unit and DB tests
e2e/                  Playwright journeys
doc/                  Brief and design notes
SPEC.md, SPEC-<module-id>.md
```

### Code style
- TypeScript strict. Money is an integer minor-unit type with an explicit rounding policy; never floats.
- Domain logic is pure functions returning typed results or coded blockers, not thrown strings.
- Model output is parsed with Zod, then business-validated, before any use.
- State transitions go through a single transition function per state machine.

```ts
// Style reference: coded result, integer minor units, no model arithmetic
export type Cents = number & { readonly __brand: "Cents" };

export type ValidationResult =
  | { ok: true; lines: QuoteLine[] }
  | { ok: false; blockers: Blocker[] };

export function validateConfiguration(
  config: Configuration,
  catalog: Catalog,
  stock: StockSnapshot,
): ValidationResult {
  const blockers: Blocker[] = [];
  for (const line of config.lines) {
    if ((stock[line.productId] ?? 0) < line.quantity) {
      blockers.push({ code: "INSUFFICIENT_STOCK", productId: line.productId });
    }
  }
  return blockers.length ? { ok: false, blockers } : { ok: true, lines: priceLines(config, catalog) };
}
```

### Testing strategy
- Vitest for domain rules, pricing, hashing and state machines (fast, no network).
- Database tests for the reservation RPC, unique constraints and concurrency (real Postgres).
- Playwright for browser journeys, including the full demo path.
- PayPal: mocked and replayed tests are labeled separately from real sandbox evidence.
- AI: 15+ varied scenario eval set (missing budget, ambiguous packaging, food exclusion, unsupported date, hostile text), reporting scenario count, method and every failure.
- The 15 brief test rows are distributed across module specs. Payment and access tests failing on 9 Nov stops all feature work.
- No accuracy, speed or time-saving figure is published before it is measured.

### Boundaries
- **Always:**
  - Store money as integer minor units.
  - Treat model output, customer messages and uploads as untrusted data.
  - Mark an order paid only on verified PayPal evidence.
  - Send a stable `PayPal-Request-Id` per operation.
  - Query PayPal after any timeout before retrying.
  - Enforce access on the server for every query.
  - Show sandbox and simulated-data indicators in the UI.
  - Run tests before commits.
- **Ask first:**
  - Adding dependencies.
  - Changing the schema after a module spec is approved.
  - Changing a state machine.
  - Switching to intent CAPTURE (the product downgrade).
  - Changing the stack or CI config.
  - Cutting any feature on the cut list.
- **Never:**
  - Let the model do authoritative arithmetic or supply a payable amount.
  - Trust a return URL or a model statement as proof of payment.
  - Release stock while a PayPal operation may be in flight.
  - Transfer an authorization to a changed quote.
  - Commit secrets (placeholder config only) or expose PayPal, model or DB secrets client-side.
  - Remove or skip failing payment, approval or access tests without approval.
  - Cut payment verification, access control, quote integrity or the real preparation handoff.
  - Use real customer data.

## 4. Success criteria (project level)
- The full demo path runs on the hosted preview against the PayPal sandbox, including the decline/void branch and the duplicate-capture test.
- The critical tests in the brief's test table pass with real results recorded, and every mocked, replayed and sandbox result is labeled.
- A fresh tester completes the flow using the README (env var names, migrate and seed commands, worker setup, demo reset, sandbox buyer guidance, known limitations).
- Submission checklist in the brief is satisfied (public repo with license, hosted demo, text description, under-3-minute video, no secrets).

## 5. Schedule and tripwires (from the brief)
| Dates | Work | Exit condition |
|---|---|---|
| 1–2 Nov | Sandbox accounts, webhook, repo and license, schema, seed; authorize/capture/void on preview | Real sandbox authorize and capture succeeds on the hosted preview |
| 3–4 Nov | Validation, pricing, stock engine; quote versions | Valid quote reproduces without model arithmetic |
| 5–6 Nov | Intake agent, clarification, order room | Customer can accept one exact feasible configuration |
| 7–8 Nov | Reservation, merchant portal, capture/void, reconciliation, unique job | Real sandbox purchase reaches preparation view |
| 9 Nov | Concurrency, duplicate, timeout, access, injection tests | Critical tests pass, results recorded |
| 10 Nov | Polish, optional logo check, deploy, README | Fresh tester completes the flow |
| 11 Nov | Video, Devpost text, screenshots | Submission drafted |
| 12 Nov | Final checks, critical fixes only | Submitted by 18:00 Sri Lanka time |

Tripwires:
- Authorize/capture not working in sandbox by end of 3 Nov: switch to intent CAPTURE. Move merchant confirmation before payment and update the UI, README, state model, demo script and claims.
- Validation and pricing engine not done by end of 6 Nov: drop the logo check and reduce to two AI moments.
- Payment or access tests failing on 9 Nov: stop all feature work until they pass.

Cut order if behind: analytics and sponsor tools, CSV import, notifications, richer status UI, then the logo check.

## 6. Open questions (need your input before the affected module spec is approved)
1. **Spec pacing:** all seven module specs in one pass, or one at a time with review? Recommended: one at a time, starting with `doc/spec/SPEC-foundation.md`.
2. **Accounts:** are the Supabase project, PayPal sandbox merchant and buyer accounts, OpenRouter key and Vercel project already created? If not, `foundation` includes setup steps.
3. ~~Background work~~ Decided: scheduled route triggered by Supabase pg_cron + pg_net (Vercel Hobby limits cron); Inngest only as a later upgrade (ask first).
4. ~~License~~ Decided: MIT.
5. **Model choice:** primary and fallback model IDs, to be decided by testing on the eval set (owned by `ai-intake`).
6. **Logo check:** ship or cut? It is decided by the 6 Nov tripwire.
