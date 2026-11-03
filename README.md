# OrderForge

OrderForge turns one vague custom-order request into an approved, PayPal-authorized order that a merchant confirms and then
prepares from an exact worksheet. Built for the PayPal AI Hackathon 2026.

> **Sandbox only. Synthetic data.** Everything here runs against the **PayPal sandbox** with made-up merchants, products and
> buyers. No real money moves, and the app shows a "Sandbox · simulated data" banner on every page.

**Hosted demo:** https://order-forge.afras.dev (demo login: see the submission notes) · License: [MIT](LICENSE)

## Status

The **foundation** module is complete and verified; the product modules on top of it are specified but not built yet.
Nothing below claims demand, time saved or accuracy: none has been measured.

| Area | State |
|---|---|
| Foundation: schema, row level security, seed, merchant login, customer links, rate limits, audit | Done, tested |
| PayPal client, webhook verification, reconciliation job, health route | Done, tested |
| PayPal authorize, capture and void on the **real sandbox** (hosted site, US sandbox accounts) | Done, evidence in [doc/evidence](doc/evidence/foundation-real-sandbox.md) |
| Catalog engine, quotes, reservations, payment state machine, fulfillment, AI intake | Specified in [SPEC.md](SPEC.md), not built yet |

Specs live in [SPEC.md](SPEC.md) (capability map) and [doc/spec](doc/spec); task lists in [tasks](tasks).

## How it is built

One Next.js 16 app (App Router, TypeScript, Tailwind, shadcn/ui), Supabase (Postgres, Auth) for data and scheduling,
PayPal Orders v2 and Payments v2 for money, Vercel for hosting. Code decides money, stock, permissions and state; a model
may only interpret, propose and explain. Money is integer minor units (USD cents).

## Run it locally

Prerequisites: **Node 22**, **Docker** (running), and the **Supabase CLI 2.119 or newer** (`supabase --version`).
An older CLI cannot read `supabase/config.toml`; the database and E2E tests then say so and tell you where to look. Check for a
second, older install on `PATH` (Windows: `where supabase`; an npm-global install can shadow Scoop's), and for a stray
`node_modules/.bin/supabase` in a **parent folder** of the project, which npm also puts on `PATH`.

```bash
npm ci
cp .env.example .env          # then edit .env, see "Environment variables"
supabase start                # local Postgres + Auth in Docker
supabase db reset             # applies supabase/migrations
npm run seed                  # demo merchant, products, stock (local stack)
npm run dev                   # http://localhost:3000
```

For a local stack, set these in `.env` from the output of `supabase status`:
`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (anon key) and
`SUPABASE_SERVICE_ROLE_KEY` (service role key). Also set `DEMO_MERCHANT_PASSWORD` to a password of **at least 12
characters**; it is the merchant login for `merchant@demo.test`. The PayPal values can stay as placeholders until you call
PayPal for real.

Then open `/merchant/login`, sign in, and open `/merchant/dev/paypal` for the PayPal spike (see below).

### Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js development server, production build, production server |
| `npm run typecheck` | Generates Next route types, then `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test` | Unit tests (Vitest), no network |
| `npm run test:db` | Database tests against the **local** Supabase (needs `supabase start`); clears local app data before and after the run (some fixtures are inconsistent on purpose, and the scheduled reservation sweep would report them), so run `npm run seed` afterwards if you want the demo data |
| `npm run test:e2e` | Browser tests (Playwright) against a production build wired to the **local** Supabase and a local fake PayPal |
| `npm run seed` | Creates the demo merchant, login, products, stock and rules, including the `box_template` rule (the five box slots and which SKUs each allows) that the catalog engine reads. It resets stock to the fixture levels, so it refuses to run once any purchase exists (use `demo:reset`, or `--reset-stock-despite-orders` if you really mean it) |
| `npm run demo:reset` | Wipes application data and re-seeds (see "Demo reset") |
| `npm run paypal:spike` | Authorize then capture / void, with evidence (see "PayPal spike") |
| `npm run paypal:fake` | A local fake PayPal for demos and tests |

## Environment variables

Copy `.env.example` to `.env`. **`.env` is gitignored and must never be committed or uploaded** (see "Deploying").
`PAYPAL_ENV` must be `sandbox` and `SANDBOX_MODE` must be `true`; the app refuses anything else.

| Name | Public | Purpose |
|---|---|---|
| `SANDBOX_MODE` | no | Must be `true`. Scripts refuse to run otherwise |
| `APP_BASE_URL` | no | The app's own address. PayPal's return URL is built from it |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon key (safe for browsers) |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | Server-only writer; bypasses row level security |
| `SUPABASE_DB_URL` | **secret** | Hosted migrations only (`supabase db push`). **Never upload it to Vercel** |
| `PAYPAL_ENV` | no | Must be `sandbox` |
| `PAYPAL_CLIENT_ID`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | no / yes | Sandbox REST app client id (same value in both) |
| `PAYPAL_CLIENT_SECRET` | **secret** | Sandbox REST app secret |
| `PAYPAL_WEBHOOK_ID` | **secret** | The short id of the webhook you registered (not its URL) |
| `OPENROUTER_API_KEY` | **secret** | Model access (used by the AI intake module, not built yet) |
| `ACCESS_LINK_SECRET` | **secret** | Signs customer links; 16+ random characters |
| `CRON_SECRET` | **secret** | Bearer token for `/api/cron/reconcile`; 16+ random characters; must equal the Supabase Vault `cron_secret` |
| `DEMO_MERCHANT_EMAIL`, `DEMO_MERCHANT_PASSWORD` | **secret** | Seed script only; password 12+ characters |
| `PAYPAL_SPIKE_BASE_URL` | no | Optional. Points the spike at a local fake (`http://127.0.0.1:...` only) |

## Accounts and hosted setup

### 1. Supabase

1. Create a project. Note its **project ref** (the subdomain of its URL).
2. Dashboard, **Connect**, choose **Session pooler** (not "Direct connection": that host is IPv6-only and fails on most
   home networks). Copy the string, replace the password placeholder **including its brackets**, and save it as
   `SUPABASE_DB_URL`. Use a database password of letters and digits (reset it under Project Settings, Database).
3. Copy the project URL, anon key and service-role key into `.env`.
4. Apply the migrations to the hosted project:

   ```bash
   supabase db push --db-url "<your session pooler URL>"
   ```
   This creates 19 tables with row level security, the uniqueness and immutability constraints, the cron function and the schedule.
   It enables `pg_cron`, `pg_net` and Vault.
5. Store two **Vault secrets** (Dashboard SQL editor, or `psql`), so the schedule knows where to call and how to prove it:

   ```sql
   select vault.create_secret('https://YOUR-DOMAIN', 'app_base_url');
   select vault.create_secret('THE-SAME-VALUE-AS-CRON_SECRET', 'cron_secret');
   ```
6. Seed the hosted merchant (the script refuses a remote host unless you name it):

   ```bash
   npm run seed -- --confirm-host=YOUR-PROJECT-REF.supabase.co
   ```

### 2. PayPal sandbox (developer.paypal.com)

1. Sandbox accounts: create a **Business** account (the merchant) and a **Personal** account (the buyer), **both with country
   United States**. A Business account in a country that cannot receive payments (for example Sri Lanka) makes PayPal
   answer "The businessman cannot accept PayPal payments at the moment".
2. Apps and Credentials, **Create App**, type Merchant, choose the **US Business** account. Copy the Client ID and Secret.
3. In that app, Webhooks, **Add Webhook**: URL `https://YOUR-DOMAIN/api/webhooks/paypal`, with these events:
   `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`,
   `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`,
   `PAYMENT.CAPTURE.REVERSED`. Save it and copy the **Webhook ID** (a short uppercase code), not the URL.
4. Put `PAYPAL_CLIENT_ID`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID` in `.env`.

**Sandbox buyer guidance.** When PayPal's checkout asks you to log in, use the **US Personal sandbox account**, never a real
PayPal account. Its email and password are shown under the dashboard's Sandbox accounts, View/Edit. Sandbox buyers start
with a test balance.

### 3. Vercel

1. Create a project (the CLI works: `vercel link --yes --project order-forge`).
2. **Keep `.env` out of uploads.** The Vercel CLI uploads a local `.env` as deployment source unless it is ignored; this
   repo ships a [.vercelignore](.vercelignore) that prevents it. Check your build log for the lines
   `Environments: .env` or `Detected .env file`: they must not appear.
3. Enter the environment variables from the table above in Vercel (Project Settings, Environment Variables), **except**
   `SUPABASE_DB_URL` and the `DEMO_MERCHANT_*` pair. Mark secrets as sensitive. Set `APP_BASE_URL` to your public address.
4. Deploy. The first CLI deploy of a new project becomes a **production** deployment.
5. After any change to a variable or the domain, redeploy: new values only apply to new deployments.

### Scheduled reconciliation (cron)

Vercel Hobby cannot run cron at this frequency, so the schedule lives in **Supabase**. Every 5 minutes `pg_cron` runs
`public.invoke_reconcile()`, which uses `pg_net` to POST `https://YOUR-DOMAIN/api/cron/reconcile` with
`Authorization: Bearer <cron_secret>` (both read from Vault; nothing is in the repo). The route answers 401 without the
right token, and records a `reconcile.heartbeat` audit row. If you change the domain, update the Vault `app_base_url`.
Evidence of runs: `cron.job_run_details` (scheduler) and `net._http_response` (HTTP answers). The merchant dev page has a
manual "Run reconcile now" button.

## PayPal spike

Proves authorize then capture, and authorize then void, with every step stored as evidence (`payment_events`,
`audit_events`), labeled **`mocked`**, **`replayed`** or **`real-sandbox`**. The amount is fixed at $10.80.

- **On the hosted site:** sign in, open `/merchant/dev/paypal`, click **Create sandbox order**, approve with the US sandbox
  buyer, then click **Authorize, then capture** (or void on another order). The page says which PayPal it targets.
- **CLI:** `npm run paypal:spike -- --mode=both`. It refuses the real sandbox without `--yes-real-sandbox`, and a hosted
  database without `--confirm-host=<host>`.
- **No credentials:** run `npm run paypal:fake`, set `PAYPAL_SPIKE_BASE_URL=http://127.0.0.1:4010`, and run the spike. All
  evidence is then labeled `mocked`.

## Demo reset

```bash
npm run demo:reset                                   # local database
npm run demo:reset -- --confirm-host=YOUR-PROJECT-REF.supabase.co   # hosted: wipes all application data, then re-seeds
```

It refuses to run unless `SANDBOX_MODE=true`, and against any non-local host unless you name that host. Auth users are kept.

## Testing and evidence

Evidence is labeled by how it was produced and never mixed: **mocked** (a fake replaces PayPal or the database),
**replayed** (the same signed delivery sent twice), **real-sandbox** (the real PayPal sandbox). The real run is written up in
[doc/evidence/foundation-real-sandbox.md](doc/evidence/foundation-real-sandbox.md). The CI workflow runs typecheck, lint,
unit tests and build; database tests against a local Supabase; and the browser tests.

## Known limitations

- **Foundation only.** Customer intake, the AI agent, quoting, stock reservation, the payment state machine and
  preparation jobs are specified, not built.
- **Webhooks are delayed and arrive out of order** (8 to 25 seconds; `PAYMENT.AUTHORIZATION.CREATED` can arrive after
  `PAYMENT.CAPTURE.COMPLETED`). Treat them as hints and confirm state by asking PayPal.
- **Authorization expiry was not observed.** PayPal holds an authorization up to 29 days; the sandbox behaviour needs that
  long to watch, so deadline handling is covered by application-level tests only.
- **The rate limiter is in memory**, so each server instance counts separately. It slows abuse; it is not a quota.
- **Sandbox accounts must be in a country that can receive payments** (use United States).
- **The direct Supabase database host is IPv6-only;** use the Session pooler string.
- **Real-sandbox webhook delivery** was verified on the Vercel address and again on the custom domain (2 Nov 2026). After any
  domain change, update the webhook URL in PayPal and re-check it with one real run.
- **Next.js 16:** uses `proxy.ts` instead of middleware and Cache Components. See `AGENTS.md` and `node_modules/next/dist/docs`.
- The merchant dev page contacts the real PayPal sandbox whenever `PAYPAL_SPIKE_BASE_URL` is not set.

## Security notes

- Never commit `.env`; only `.env.example` (placeholders) is tracked. Run a secret scan before every push.
- The service-role key and every `SECRET` above stay server-side. Browsers only get the `NEXT_PUBLIC_*` values.
- All writes go through server code with the service-role key; signed-in merchants can only read their own rows (row level
  security), and anonymous users can read nothing.
- Customer links are signed, expire, and can be revoked. They never grant access to another inquiry.
- Only verified PayPal evidence marks money as moved; a return URL or a model statement proves nothing.
