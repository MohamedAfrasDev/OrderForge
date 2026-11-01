# Spec: foundation

Module id: `foundation` · Depends on: none · Index: [../../SPEC.md](../../SPEC.md) · Brief: [../OrderForge Build Brief v1.1.md](../OrderForge%20Build%20Brief%20v1.1.md)

Status: DRAFT, awaiting review. Target window: 1–2 Nov 2026.

## 1. Objective

Provide everything every other module stands on, and prove the riskiest external dependency (PayPal authorize → capture → void) on a hosted preview before more is built.

**Users:** the developer and the coding agents (primary), then the merchant (login) and the customer (signed access link).

**Delivers:**
1. A pinned, reproducible Next.js app with test tooling, deployed to Vercel.
2. Supabase schema, constraints, migrations and synthetic seed data for the seeded gift-box merchant.
3. Access: merchant login (Supabase Auth) and a customer signed access link, both enforced on the server.
4. Cross-cutting plumbing: typed env/config, integer-minor-unit money type, audit events, correlation IDs, sandbox indicators.
5. A thin PayPal sandbox gateway proving authorize, capture and void on the deployed preview, plus a webhook endpoint that verifies signatures.
6. A scheduled reconciliation route skeleton, triggered by **Supabase `pg_cron` + `pg_net`** (Vercel Hobby limits cron frequency, so Vercel Cron is not used). Inngest is explicitly not used in v1.
7. A GitHub Actions CI workflow running typecheck, lint, unit tests, DB tests and build on every push and pull request.
8. Repository hygiene for submission: MIT license, README skeleton, `.env.example`, no secrets.

**Not in scope:** pricing and validation (`catalog-engine`), quote versions (`quote-approval`), the reservation RPC (`reservation`), the payment-attempt state machine and merchant decision flow (`payments`), preparation jobs (`fulfillment`), and any AI (`ai-intake`). Foundation creates those tables empty, with constraints, but not their business logic.

### Acceptance criteria
- A fresh clone plus `.env` filled from `.env.example` runs `npm run dev`, `npm run test`, and `npm run build` successfully.
- `supabase db reset` (or documented equivalent) applies all migrations and the seed with no errors, and is repeatable (`npm run demo:reset`).
- A real PayPal sandbox authorize, capture and void each succeed on the hosted Vercel preview (**exit condition of the 1–2 Nov window**), with the evidence labeled "real sandbox".
- The webhook route rejects an unsigned or forged request and acknowledges a duplicate event ID without a second effect.
- A request without a valid merchant session cannot read merchant routes; a customer link for inquiry A cannot read inquiry B (server-side, tested).
- Every page shows a visible "Sandbox · simulated data" indicator.
- No secret appears in the repository or in any client bundle.

## 2. Assumptions
1. Next.js 16.4.3, React 19.3.0 as already installed. `next.config.ts` enables `cacheComponents` and `partialPrefetching`; routes must be written with those on (verify against `node_modules/next/dist/docs/01-app/01-getting-started/08-caching.md` before writing data-fetching code).
2. In this Next.js version `middleware` is replaced by `proxy.ts` (see `01-app/01-getting-started/16-proxy.md`). Use it only for coarse gating; real authorization is checked in server code per query.
3. The existing `@/*` → `./*` path alias is kept, so there is no `src/` directory. Code goes under `app/`, `lib/`, `domain/`, `services/` at the repo root.
4. One Supabase project serves local dev, preview and demo, with a local Supabase stack for DB tests.
5. Customer identity is a signed, unguessable access link per inquiry, with no customer accounts.
6. Merchant login is **Supabase Auth email + password** (decided) for one seeded merchant user. No magic link, no sign-up page: the merchant user is created by the seed or the Supabase dashboard.
7. The account-creation steps (Supabase project, PayPal sandbox merchant and buyer, Vercel project, webhook registration) are done by the human. The agent cannot create accounts or enter credentials. They are listed as prerequisites.
8. License: **MIT**. Reconciliation: **scheduled route**, triggered by **Supabase `pg_cron`** calling it over HTTP with `pg_net` (decided: Vercel Hobby limits cron). CI: **GitHub Actions**.
9. Supabase, PayPal and Vercel accounts do not exist yet. `.env` and `.env.example` hold placeholders only, and every task that needs a real account is blocked until the human fills them in. Work that needs no account (money, env validation, access links, domain code, mocked tests, local Supabase via the CLI) proceeds first.

## 3. Prerequisites (human actions, to be done later)
`.env` (gitignored) and `.env.example` (committed) already exist with placeholder values. Replace placeholders in `.env` / Vercel env as each account is created.
- [ ] Supabase project created; URL, anon key and service-role key placed in `.env` and Vercel env. Enable the `pg_cron`, `pg_net` and Vault (`supabase_vault`) extensions.
- [ ] PayPal developer sandbox: one business (merchant) account and one personal (buyer) account; REST app created; client ID and secret stored in env; webhook registered against the Vercel preview URL with its webhook ID stored in env.
- [ ] Vercel project linked (Hobby plan); env vars set, including `CRON_SECRET` and `APP_BASE_URL` (the deployed URL).
- [ ] Vault secrets created in Supabase for the cron job: `app_base_url` and `cron_secret` (same value as `CRON_SECRET`).
- [ ] GitHub repo created as public; repository secrets added for CI only if a CI step needs them (none expected: CI uses mocks and a local Supabase stack).

## 4. Tech stack (additions to SPEC.md)
`@supabase/supabase-js`, `@supabase/ssr`, `zod`, `vitest`, `@playwright/test`, shadcn/ui (with its Tailwind 4 setup), a PayPal server client via plain `fetch` (no heavy SDK on the server) and `@paypal/react-paypal-js` for the browser approval button. Versions are pinned exactly when installed; each addition is listed in the PR. Adding anything beyond this list requires asking first.

## 5. Commands

```
Dev:            npm run dev
Build:          npm run build
Lint:           npm run lint
Typecheck:      npm run typecheck        # tsc --noEmit
Unit tests:     npm run test             # vitest run
Coverage:       npm run test -- --coverage
DB tests:       npm run test:db          # vitest against local Supabase (supabase start)
E2E:            npm run test:e2e         # playwright test
Local DB:       supabase start | supabase db reset | supabase db push
Seed:           npm run seed
Demo reset:     npm run demo:reset       # reset DB + reseed, refuses to run if SANDBOX_MODE != "true"
PayPal spike:   npm run paypal:spike     # CLI authorize→capture→void against sandbox, prints labeled evidence
```

## 6. Project structure

```
app/
  layout.tsx, page.tsx            landing with sandbox banner
  store/[slug]/                   customer intake placeholder (built out by ai-intake)
  o/[token]/                      customer order room placeholder (signed link)
  merchant/                       login + portal shell (protected)
  api/
    webhooks/paypal/route.ts      signature verify, dedupe, ack
    cron/reconcile/route.ts       scheduled route skeleton (CRON_SECRET)
    health/route.ts               env/DB/PayPal reachability, no secrets in output
proxy.ts                          coarse gate for /merchant only
lib/
  env.ts                          Zod-validated server env; client env separate
  money.ts                        Cents type, add/mul, rounding policy
  supabase/{server,browser,admin}.ts
  paypal/{client,auth,types}.ts   token, request id, authorize/capture/void/get, webhook verify
  audit.ts                        audit_events writer
  correlation.ts                  correlation ID per request
  access/{merchant,customer-link}.ts
domain/                           (empty; filled by later modules) pure logic, no framework imports
services/                         (empty; filled by later modules)
components/ui/                    shadcn components
components/sandbox-banner.tsx
supabase/
  migrations/                     0001_core_tables.sql, 0002_constraints.sql, 0003_rls.sql, 0004_cron.sql
  seed/seed.sql (+ seed.ts)       synthetic merchant, products, stock, rules
  config.toml
tests/                            vitest (unit) and tests/db (database)
e2e/                              playwright
scripts/{seed.ts,demo-reset.ts,paypal-spike.ts}
doc/spec/                         these specs
LICENSE                           MIT
.env                              placeholders only, gitignored (created)
.env.example                      names only, placeholder values, committed (created; .gitignore has `!.env.example`)
.github/workflows/ci.yml          typecheck, lint, test, test:db, build
README.md                         env names, migrate/seed, cron, demo reset, sandbox buyer, limitations
```

## 7. Data and schema scope

Create all tables from the brief's core list, with primary keys, foreign keys, timestamps and state columns as CHECK-constrained text enums, using the exact state names in the brief:

`merchants, products, stock, business_rules, inquiries, messages, requirement_versions, quote_versions, approvals, merchant_decisions, reservations, reservation_lines, payment_attempts, payment_events, preparation_jobs, preparation_events, assets, audit_events` plus a `purchases` table (the single record created at acceptance, linking quote, approval, reservation, payment attempts and at most one preparation job).

Constraints that **foundation must land now** (so later modules cannot forget them):
- UNIQUE on `payment_attempts.paypal_order_id`, `.authorization_id`, `.capture_id`, and on `payment_events.provider_event_id`.
- Partial unique index: at most one active payment attempt per purchase (state not in CAPTURED, VOIDED, EXPIRED, FAILED).
- UNIQUE `preparation_jobs.purchase_id`.
- `quote_versions` and accepted snapshots are immutable: an UPDATE-blocking trigger on rows once PUBLISHED or later, except for the status transition columns.
- `payment_attempts.unknown_operation` column (authorize | capture | void), required when state = OUTCOME_UNKNOWN.
- All money columns are `bigint` minor units with `currency char(3)` and a CHECK that currency = 'USD' in v1.
- Row Level Security enabled on every table; the service-role client is the only writer from server code; merchant policies scope by `merchant_id`; no anon policy.

Seed (all synthetic, labeled): one merchant "Demo Gift Boxes", one merchant auth user, and products matching the demo: notebook ($12), pen ($3), organizer ($14), branded card ($2), packaging ($5), water bottle with 24 in stock, plus one food item flagged `food: true`. Seed prices are fixtures (1200, 300, 1400, 200, 500 cents). Business rule `food: false` is a per-inquiry constraint, not a global one.

Module-specific column details beyond the above are finalized by each owning module's spec. Foundation creates a first draft and later modules may change it through a new migration (ask first).

## 8. PayPal sandbox gateway (the spike)

`lib/paypal/*` is a thin typed wrapper, not the payment state machine. It must:
- Obtain and cache the OAuth token server-side.
- `createOrder({ amount, currency, referenceId, requestId })` with intent **AUTHORIZE**; amount always passed in by the caller, never read from the browser.
- `authorizeOrder(orderId, requestId)` and return `purchase_units[0].payments.authorizations[0].id`.
- `captureAuthorization(authId, requestId)` via `POST /v2/payments/authorizations/{id}/capture`.
- `voidAuthorization(authId, requestId)` via the void endpoint.
- `getOrder` / `getAuthorization` / `getCapture` for later reconciliation.
- Always send a caller-supplied `PayPal-Request-Id`.
- Return a typed result that distinguishes `ok`, `provider_error` and `timeout` so that `payments` can map `timeout` to OUTCOME_UNKNOWN. Never retry internally.
- Redact secrets from logs.
- `verifyWebhook(headers, rawBody)` using the PayPal verification API with the configured webhook ID. Check the exact event names against PayPal's current docs before wiring handlers, and record the verified names in this spec.

The spike deliverable is a hosted `/merchant/dev/paypal` page (merchant-only, sandbox only) and `npm run paypal:spike` that exercise authorize → capture and authorize → void with a hard-coded demo amount, and write `payment_events` and `audit_events` rows. Also confirm in the real sandbox whether authorizations expire, and record the result here.

**Tripwire:** if authorize and capture do not both succeed in the sandbox by end of 3 Nov, notify the human immediately; the fallback is intent CAPTURE, which requires updating every spec before building continues.

## 9. Access control
- **Merchant:** Supabase Auth session cookie via `@supabase/ssr`. `proxy.ts` redirects unauthenticated `/merchant/*` requests. Every merchant server action and route re-checks the session and the `merchant_id`; the proxy is never the only check.
- **Customer:** `lib/access/customer-link.ts` creates and verifies a signed token (HMAC with `ACCESS_LINK_SECRET`, inquiry ID + expiry + version, constant-time compare). Every server read of inquiries, messages and assets takes the verified inquiry ID and filters on it. Revocation is by bumping a per-inquiry token version.
- **Rate limit:** a simple DB- or memory-backed limiter on `/store/[slug]` intake and the access-link verification route.
- **Assets:** Supabase Storage bucket is private; access only via short-lived signed URLs minted after the server check.

## 10. Cross-cutting plumbing
- `lib/env.ts` validates env at boot with Zod and fails with the variable *names* only, never values. Server-only modules import `server-only`.
- `lib/money.ts`: `type Cents`, `toCents(int)`, `add`, `mulInt`, a rounding policy `roundHalfUp` for any future percentage, and `format()` for display only. No function accepts a float amount from outside.
- `lib/audit.ts`: `audit({ actor, action, entity, entityId, correlationId, data })`; payload passes a redaction allowlist.
- Correlation ID created per request and propagated to audit and payment events.
- `components/sandbox-banner.tsx` rendered in the root layout; also appears on the PayPal approval step.
- Reconciliation route `/api/cron/reconcile`: requires `Authorization: Bearer ${CRON_SECRET}`, is idempotent, and in this module only logs a heartbeat audit event.
- **Scheduler: Supabase `pg_cron`.** Migration `0004_cron.sql` enables `pg_cron` and `pg_net` and schedules a job (every 5 minutes) that calls `net.http_post` on `<app_base_url>/api/cron/reconcile` with header `Authorization: Bearer <cron_secret>`. Both values are read from Supabase Vault (`vault.decrypted_secrets`) inside the job, so no secret or URL is hardcoded in a migration. The migration is guarded so it is skipped (not failed) when the extensions or secrets are missing, which keeps local `supabase db reset` and CI green. `cron.job_run_details` and `net._http_response` are the evidence for the run history. The merchant dev page keeps a manual "run reconcile now" button. A reservation-expiry sweep that needs no HTTP call may later run as a pure SQL `pg_cron` job (owned by `reservation`); anything that talks to PayPal stays in the route.

## 11. Environment variables (names only; values never committed)
Already present as placeholders in `.env` and `.env.example`.
```
APP_BASE_URL                         # deployed origin; also stored in Supabase Vault for pg_cron
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY            # server only
PAYPAL_ENV=sandbox                   # must be "sandbox"; app refuses "live"
PAYPAL_CLIENT_ID                     # also exposed as NEXT_PUBLIC_PAYPAL_CLIENT_ID for the JS SDK
PAYPAL_CLIENT_SECRET                 # server only
PAYPAL_WEBHOOK_ID                    # server only
OPENROUTER_API_KEY                   # server only (used by ai-intake)
ACCESS_LINK_SECRET                   # server only
CRON_SECRET                          # server only
SANDBOX_MODE=true
```

## 12. Code style

```ts
// lib/money.ts, style reference: branded integer type, no floats
declare const brand: unique symbol;
export type Cents = number & { readonly [brand]: "Cents" };

export function cents(n: number): Cents {
  if (!Number.isSafeInteger(n)) throw new RangeError("money must be an integer minor unit");
  return n as Cents;
}

export const add = (a: Cents, b: Cents): Cents => cents(a + b);
export const mulInt = (a: Cents, q: number): Cents => cents(a * q);
```

```ts
// lib/paypal/client.ts, style reference: typed result, timeouts are data, not exceptions
export type PayPalResult<T> =
  | { kind: "ok"; data: T; requestId: string }
  | { kind: "provider_error"; status: number; body: unknown; requestId: string }
  | { kind: "timeout"; requestId: string };
```

Conventions: strict TypeScript; named exports; kebab-case files; domain functions pure and returning typed results; env access only through `lib/env.ts`; no `any`; comments only where the reason is non-obvious.

## 13. Testing strategy

| Level | Tool | What |
|---|---|---|
| Unit | Vitest | `money.ts` (integers, overflow, rounding), env validation, access-link sign/verify/expiry/tamper, audit redaction, PayPal client result mapping (mocked fetch) |
| Database | Vitest + local Supabase | Migrations apply cleanly; unique constraints reject duplicates; partial unique index allows only one active attempt; immutability trigger blocks edits; RLS denies anon and cross-merchant reads |
| Route | Vitest | Webhook rejects forged/unsigned, acknowledges duplicate event ID with no second effect (verification mocked and replayed); cron rejects missing bearer |
| E2E | Playwright | Merchant login gate; customer link A cannot open inquiry B; sandbox banner on every page |
| Real sandbox | `paypal:spike` + hosted dev page | Authorize → capture and authorize → void against the actual PayPal sandbox; evidence stored and labeled |

**CI (GitHub Actions, `.github/workflows/ci.yml`):** runs on push and pull_request, Node LTS, `npm ci` with the lockfile, then in order: `typecheck`, `lint`, `test`, start local Supabase via the Supabase CLI action and run `test:db`, then `build` with placeholder env from `.env.example`. CI uses no real credentials and never calls PayPal or OpenRouter. Playwright E2E runs in a separate job against the local stack and may be marked non-blocking until stable. A failing `typecheck`, `lint`, `test` or `test:db` blocks merge.

Evidence labeling: every recorded result is tagged `mocked`, `replayed` or `real-sandbox`. Coverage target for `lib/money.ts`, `lib/access/*` and `lib/paypal/*`: ≥90% lines; no global coverage number is promised.

Rows from the brief's test table owned here: *Another customer opens the order or a file → denied on the server*; *Forged or duplicate webhook → rejected or acknowledged with no second effect* (route level; payment effects tested in `payments`).

## 14. Boundaries
- **Always:** run `npm run typecheck && npm run lint && npm run test` before each commit; keep secrets in env only; check the server session or token on every protected read; label evidence as mocked, replayed or real-sandbox; check PayPal docs for exact event names and endpoints before coding them.
- **Ask first:** adding a dependency not listed in §4; changing a table or constraint after approval (use a new migration); choosing Inngest over the scheduled route; changing the `pg_cron` schedule; switching intent to CAPTURE.
- **Never:** commit `.env*` or any key; expose the service-role or PayPal secret to the client; accept an amount from the browser; allow `PAYPAL_ENV=live`; retry a timed-out PayPal call without querying; use real personal data; put authorization only in `proxy.ts`.

## 15. Success criteria (testable)
- [ ] `npm run typecheck`, `lint`, `test`, `test:db`, `build` all pass in GitHub Actions CI and locally.
- [ ] `pg_cron` job exists after migration, calls `/api/cron/reconcile` with the bearer secret, and `cron.job_run_details` shows successful runs on the hosted project; the route returns 401 without the bearer.
- [ ] Migrations apply on a clean DB; `npm run demo:reset` restores the seed exactly.
- [ ] Real sandbox: authorize + capture succeeds on the Vercel preview; authorize + void succeeds; evidence recorded as `real-sandbox`.
- [ ] Webhook: forged request rejected (4xx), valid replay acknowledged once, duplicate acknowledged with no new row effect.
- [ ] Access: cross-inquiry and unauthenticated reads denied (DB and E2E tests).
- [ ] Sandbox banner visible on every route; `.env.example` lists every variable above; repo contains MIT `LICENSE`; secret scan of the tree is clean.
- [ ] Sandbox authorization-expiry behaviour observed and recorded in this spec.

## 16. Task outline (becomes tasks/plan.md after approval)
1. Repo hygiene: LICENSE (MIT), README skeleton, scripts, Vitest + Playwright + shadcn setup, GitHub Actions CI workflow (`.env` / `.env.example` already created).
2. `lib/env.ts`, `lib/money.ts`, `lib/audit.ts`, correlation ID, sandbox banner, with tests.
3. Supabase project wiring, migrations 0001–0003, seed, `demo:reset`, DB tests.
4. Merchant auth (login, `proxy.ts`, session checks) and customer signed link, with tests.
5. PayPal client + `paypal:spike` CLI against the sandbox (local), then the hosted dev page on Vercel.
6. Webhook route with verification and dedupe; cron route skeleton; `0004_cron.sql` (`pg_cron` + `pg_net` + Vault); health route.
7. Deploy preview, run real-sandbox authorize/capture/void, record evidence; decide the CAPTURE tripwire.

Tasks 1–2 and the account-free parts of 3–6 can start immediately; the hosted-account parts of 3, 5, 6 and all of 7 wait for the human to create Supabase, PayPal and Vercel accounts. Note the 3 Nov tripwire: the later accounts are created, the less slack remains.

## 17. Open questions
All resolved: accounts will be created later (placeholders in `.env`); Vercel Hobby, so cron runs on Supabase `pg_cron`; GitHub Actions CI; merchant sign-in is email + password; the README includes a short step-by-step account-creation walkthrough (Supabase, PayPal sandbox buyer and merchant, Vercel, webhook registration, Vault secrets).
