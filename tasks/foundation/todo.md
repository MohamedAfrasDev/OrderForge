# Tasks: foundation

Spec: [doc/spec/SPEC-foundation.md](../../doc/spec/SPEC-foundation.md) · Plan: [plan.md](plan.md)
Status: DRAFT, awaiting approval. Tick a box only after its Verify step passes.

## Phase A: Tooling and pure libraries (no accounts)

- [x] **T1 Repo hygiene and Vitest**
  - Acceptance: MIT `LICENSE` (already existed in the initial commit, holder Mohamed Afras, kept as is); `package.json` has `typecheck`, `test`, `test:db`, `test:e2e`, `seed`, `demo:reset`, `paypal:spike` scripts (the last four may print "not implemented yet" until their tasks); Vitest runs a smoke test; pinned versions and lockfile committed.
  - Verify: `npm run typecheck && npm run lint && npm run test`
  - Files: `LICENSE`, `package.json`, `package-lock.json`, `vitest.config.ts`, `tests/smoke.test.ts`
  - Ask first: any dependency beyond Vitest.

- [x] **T2 Playwright and shadcn/ui**
  - Acceptance: Playwright configured with a smoke E2E hitting `/`; shadcn initialised for Tailwind 4 with a Button component; `npm run build` still passes with the existing turbopack CSS rule.
  - Verify: `npm run build && npm run test:e2e`
  - Files: `playwright.config.ts`, `e2e/smoke.spec.ts`, `components.json`, `lib/utils.ts`, `components/ui/button.tsx`
  - Depends on: T1. Read `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md` first.

- [x] **T3 GitHub Actions CI (core)** (written; YAML parses; waiting for first green run after push)
  - Acceptance: workflow runs on push and pull_request with `npm ci`, `typecheck`, `lint`, `test`, `build` (placeholder env from `.env.example`); separate non-blocking E2E job; no secrets used.
  - Verify: workflow YAML lints locally (`npx --yes @action-validator/cli` or equivalent); after the first push the run is green.
  - Files: `.github/workflows/ci.yml`
  - Depends on: T1, T2.

- [x] **T4 Money library**
  - Acceptance: `Cents` branded integer type; `cents()` rejects non-integers and unsafe integers; `add`, `mulInt`, `roundHalfUp`, display-only `format()`; tests cover $12+$3+$14+$2+$5 = 3600 per box and 30 boxes = 108000.
  - Verify: `npm run test -- tests/money.test.ts`
  - Files: `lib/money.ts`, `tests/money.test.ts`
  - Depends on: T1.

- [x] **T5 Env validation**
  - Acceptance: Zod-validated server env and a separate client env; errors name the variables, never values; `PAYPAL_ENV` other than `sandbox` fails; `SANDBOX_MODE` must be `true`; server env module imports `server-only`.
  - Verify: `npm run test -- tests/env.test.ts`
  - Files: `lib/env.ts`, `tests/env.test.ts`
  - Depends on: T1. Add the `server-only` dependency (ask first).

- [x] **T6 Sandbox banner and landing page**
  - Acceptance: root layout renders a visible "Sandbox · simulated data" banner on every route; landing page links to the merchant area; nothing breaks under `cacheComponents`.
  - Verify: `npm run build && npm run test:e2e` (E2E asserts banner text on `/`).
  - Files: `components/sandbox-banner.tsx`, `app/layout.tsx`, `app/page.tsx`, `e2e/banner.spec.ts`
  - Depends on: T2, T5. Read the caching and layouts docs first.

- [x] **T7 Correlation ID and audit writer**
  - Acceptance: correlation ID helper; `audit()` takes an injected insert function, redacts payloads through an allowlist, and never logs secrets; tests prove redaction.
  - Verify: `npm run test -- tests/audit.test.ts`
  - Files: `lib/correlation.ts`, `lib/audit.ts`, `tests/audit.test.ts`
  - Depends on: T1.

- [x] **T8 Customer signed access link**
  - Acceptance: create and verify HMAC token (inquiry ID, expiry, version) with constant-time compare; tests cover valid, expired, tampered, wrong-secret and bumped-version cases.
  - Verify: `npm run test -- tests/customer-link.test.ts`
  - Files: `lib/access/customer-link.ts`, `tests/customer-link.test.ts`
  - Depends on: T5.

### Checkpoint A

`npm run typecheck && npm run lint && npm run test && npm run build` pass locally and CI is green. Review with the human before phase B.

## Phase B: Database and access (local Supabase)

- [x] **T9 Supabase init and core tables**
  - Acceptance: `supabase/config.toml`; migration `0001_core_tables.sql` creating `merchants, products, stock, business_rules, inquiries, messages, requirement_versions, quote_versions, approvals, assets, audit_events` with brief-exact state names as CHECK-constrained text, `bigint` money, `currency` fixed to USD.
  - Verify: `supabase start && supabase db reset` completes with no errors.
  - Files: `supabase/config.toml`, `supabase/migrations/0001_core_tables.sql`
  - Depends on: T1. Needs Docker.

- [x] **T10 Purchase, payment and preparation tables with constraints**
  - Acceptance: migration `0002_constraints.sql` creating `purchases, merchant_decisions, reservations, reservation_lines, payment_attempts, payment_events, preparation_jobs, preparation_events`; unique on PayPal order ID, authorization ID, capture ID and provider event ID; partial unique index for one active attempt per purchase; unique `preparation_jobs.purchase_id`; `unknown_operation` required when state is OUTCOME_UNKNOWN; immutability trigger on published quote versions.
  - Verify: `supabase db reset` clean (constraint behaviour is proven in T12).
  - Files: `supabase/migrations/0002_constraints.sql`
  - Depends on: T9.

- [x] **T11 RLS, seed and demo reset**
  - Acceptance: `0003_rls.sql` enables RLS on every table with merchant-scoped policies and no anon policy; seed creates "Demo Gift Boxes", products at 1200/300/1400/200/500 cents, bottle stock 24, one `food: true` item, one merchant auth user; `npm run seed` and `npm run demo:reset` work and refuse to run unless `SANDBOX_MODE=true`; against any non-local Supabase host they also require `--confirm-host=<host>`.
  - Verify: `npm run demo:reset` twice gives identical row counts.
  - Files: `supabase/migrations/0003_rls.sql`, `supabase/seed/fixtures.ts` (replaces seed.sql: one seed source for local and hosted), `scripts/lib.ts`, `scripts/seed.ts`, `scripts/demo-reset.ts`, `package.json`, `tsconfig.json`
  - Depends on: T10, T5.

- [x] **T12 Database tests**
  - Acceptance: tests prove duplicate PayPal IDs and provider event IDs are rejected; two active attempts for one purchase are rejected while a new one after VOIDED is allowed; second preparation job for a purchase is rejected; published quote edit is blocked; OUTCOME_UNKNOWN without `unknown_operation` is rejected; anon and cross-merchant reads are denied.
  - Verify: `npm run test:db`
  - Files: `tests/db/constraints.test.ts`, `tests/db/rls.test.ts`, `tests/db/helpers.ts`, `vitest.db.config.ts`, `package.json`
  - Depends on: T11.

- [x] **T13 CI database job** (green on GitHub: 63 DB tests on a local Supabase stack, ~2m)
  - Acceptance: CI starts local Supabase via the Supabase CLI action and runs `test:db`; a failure blocks merge.
  - Verify: CI run shows the `test:db` job green.
  - Files: `.github/workflows/ci.yml`
  - Depends on: T12, T3.

- [x] **T14 Supabase clients and merchant auth (email + password)** (no browser client: sign-in is a server action; E2E needs a local Supabase and runs a production build, see spec)
  - Acceptance: server, browser and admin Supabase clients; `/merchant/login` email + password form; `proxy.ts` redirects unauthenticated `/merchant/*`; `lib/access/merchant.ts` re-checks session and `merchant_id` in server code; no sign-up page.
  - Verify: `npm run test` (unit for the access helper) and `npm run test:e2e` (unauthenticated `/merchant` redirects to login; seeded merchant can sign in).
  - Files: `lib/supabase/server.ts`, `lib/supabase/browser.ts`, `lib/supabase/admin.ts`, `lib/access/merchant.ts`, `proxy.ts` (plus the login page and an E2E; this task may split in two if it exceeds five files)
  - Depends on: T5, T11. Read `01-app/01-getting-started/16-proxy.md` and `01-app/02-guides/authentication.md` first.

- [ ] **T15 Customer link routes and server-side isolation**
  - Acceptance: `/o/[token]` verifies the token and loads only that inquiry; every server read filters on the verified inquiry ID; asset URLs are short-lived signed URLs after the check; a simple rate limit on token verification and `/store/[slug]`.
  - Verify: `npm run test:e2e` where link A cannot open inquiry B, and `npm run test:db` for the read helpers.
  - Files: `app/o/[token]/page.tsx`, `app/store/[slug]/page.tsx`, `lib/access/inquiry-reads.ts`, `lib/rate-limit.ts`, `e2e/access.spec.ts`
  - Depends on: T8, T14.

### Checkpoint B

`supabase db reset`, `npm run test:db`, `npm run test`, `npm run test:e2e` all green and CI green with the DB job. Review with the human before phase C.

## Phase C: PayPal behind mocks (no accounts)

- [ ] **T16 PayPal client with mocked tests**
  - Acceptance: token fetch and cache; `createOrder` (AUTHORIZE, caller-supplied amount), `authorizeOrder` returning `purchase_units[0].payments.authorizations[0].id`, `captureAuthorization`, `voidAuthorization`, `getOrder`, `getAuthorization`, `getCapture`; every call sends `PayPal-Request-Id`; results are `ok | provider_error | timeout`; no internal retry; secrets redacted from logs.
  - Verify: `npm run test -- tests/paypal-client.test.ts` (mocked fetch, labeled `mocked`).
  - Files: `lib/paypal/client.ts`, `lib/paypal/auth.ts`, `lib/paypal/types.ts`, `tests/paypal-client.test.ts`
  - Depends on: T4, T5. Check PayPal's current Orders v2 / Payments v2 docs before coding.

- [ ] **T17 Webhook verification and route**
  - Acceptance: `verifyWebhook` using PayPal's verification API and `PAYPAL_WEBHOOK_ID`; route rejects forged or unsigned requests, writes a `payment_events` row keyed by provider event ID, acknowledges a duplicate with no second effect; verified event names recorded in the spec.
  - Verify: `npm run test -- tests/webhook.test.ts` (verification mocked, duplicate replayed; labeled `mocked`/`replayed`).
  - Files: `lib/paypal/verify-webhook.ts`, `app/api/webhooks/paypal/route.ts`, `tests/webhook.test.ts`, `doc/spec/SPEC-foundation.md`
  - Depends on: T16, T12. Read `01-app/01-getting-started/15-route-handlers.md` first.

- [ ] **T18 Cron route, `pg_cron` migration and health route**
  - Acceptance: `/api/cron/reconcile` requires `Authorization: Bearer ${CRON_SECRET}` (401 otherwise), is idempotent and writes a heartbeat audit event; `0004_cron.sql` schedules a 5-minute `pg_cron` job using `pg_net` with URL and secret read from Vault, guarded to skip when extensions or secrets are absent; `/api/health` reports DB and env reachability with no secrets in output.
  - Verify: `npm run test -- tests/cron.test.ts`; `supabase db reset` still clean locally.
  - Files: `app/api/cron/reconcile/route.ts`, `app/api/health/route.ts`, `supabase/migrations/0004_cron.sql`, `tests/cron.test.ts`
  - Depends on: T5, T7, T11.

- [ ] **T19 PayPal spike CLI and merchant dev page**
  - Acceptance: `npm run paypal:spike` runs authorize → capture and authorize → void with a hard-coded demo amount, writes `payment_events` and `audit_events`, and prints evidence labeled `mocked` or `real-sandbox`; `/merchant/dev/paypal` page (merchant-only) with the same actions and a "run reconcile now" button; refuses to run when `PAYPAL_ENV` is not `sandbox`.
  - Verify: spike runs end to end against a local fake PayPal server in a test; E2E confirms the page is merchant-only.
  - Files: `scripts/paypal-spike.ts`, `app/merchant/dev/paypal/page.tsx`, `app/merchant/dev/paypal/actions.ts`, `tests/spike.test.ts`, `e2e/dev-page.spec.ts`
  - Depends on: T14, T16, T18.

### Checkpoint C

All mocked and replayed PayPal tests green. Review with the human, and tell the human the accounts are now the only blocker.

## Phase D: Hosted proof (needs accounts)

- [ ] **T20 Hosted wiring (human + agent)**
  - Acceptance: Supabase project created and migrated (`supabase db push`), Vault secrets `app_base_url` and `cron_secret` set, `pg_cron` job visible; Vercel project deployed with all env vars from `.env.example`; PayPal sandbox merchant, buyer and webhook registered with the webhook ID in env. Agent never enters credentials: the human fills in `.env` and Vercel/Supabase dashboards.
  - Verify: `/api/health` on the preview returns healthy; `cron.job_run_details` shows a successful run; reconcile returns 401 without the bearer.
  - Files: none in git (configuration only); notes appended to `README.md`
  - Depends on: Checkpoint C and human prerequisites in the spec §3.

- [ ] **T21 Real sandbox authorize, capture, void**
  - Acceptance: on the hosted preview, authorize + capture succeeds and authorize + void succeeds with a sandbox buyer; evidence stored and labeled `real-sandbox`; forged webhook rejected and a real webhook event deduped; sandbox authorization-expiry behaviour observed and recorded in the spec; CAPTURE-fallback decision recorded (tripwire: end of 3 Nov).
  - Verify: `payment_events` rows exist for each real operation; screenshot or log of the PayPal sandbox dashboard saved under `doc/evidence/`.
  - Files: `doc/evidence/foundation-real-sandbox.md`, `doc/spec/SPEC-foundation.md`
  - Depends on: T20.

- [ ] **T22 README**
  - Acceptance: README has account-creation walkthrough (Supabase, PayPal sandbox buyer and merchant, Vercel, webhook, Vault secrets), env variable names, migrate and seed commands, demo reset, cron description, sandbox buyer guidance and known limitations; all UI/README sandbox labels present; secret scan of the tree is clean.
  - Verify: a fresh clone follows the README up to a running `npm run dev` and a green `npm run test`.
  - Files: `README.md`
  - Depends on: T21 (walkthrough text can be drafted earlier).

### Checkpoint D (module done)

Every success criterion in §15 of the spec is checked. Update `SPEC.md` status to "foundation: done", then start `doc/spec/SPEC-catalog-engine.md`.
