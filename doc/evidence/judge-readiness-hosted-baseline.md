# Judge-readiness: hosted baseline

Task T1 of `judge-readiness` · Date: 6 Nov 2026 · Label: **hosted, read-only** (public GET requests, the Vercel CLI's list commands showing variable NAMES only, and a read of the code). Nothing was changed, seeded, deployed or paid for. Site: `https://order-forge.afras.dev`.

## What the live site serves

| Check | Result |
|---|---|
| `GET /` | 200 (2.2 s). Offers one store link: `/store/demo-gift-boxes` |
| `GET /api/agent/v1/stores` | 200. Lists one store only: `demo-gift-boxes` ("Demo Gift Boxes (simulated)") |
| `GET /api/agent/v1/stores/demo-event-kits` | 404 |
| `GET /store/demo-event-kits` | Renders the "couldn't find that" page (the HTTP status was 200; the body is the not-found message) |
| `GET /api/health` | 200: `{"status":"ok","sandbox":true,"checks":{"env":"ok","database":"ok"}}` |
| `GET /api/agent/v1/openapi.json` | 200 |
| `GET /how-it-works` | 200 |
| `GET /demo`, `GET /developers` | 404 (not built yet: tasks T5 to T7) |

**Finding 1 (confirms the review): the live site has one shop.** Every claim of a second shop (Demo Event Kits) in `doc/submission/devpost-text.md` (line 22), `video-script.md` (lines 50 to 51) and any README text is not true of the hosted site today. Task T9 decides: seed it, or remove the claims, by the end of 8 Nov.

## Which code is live

- The newest production deployment (`dpl_2xipvacTPFCG4yxnu2DzNFfZ4bPt`, READY) was created 6 Nov 2026 12:08 IST. The merge commit `ce206ad` ("Merge pull request #12 from MohamedAfrasDev/impact-innovation") is dated 6 Nov 2026 12:08:03 IST. The agent API answers on the live site. So **the live site runs the merged code including the agent API.**
- **Finding 2: `doc/submission/final-checklist.md` is stale.** It still says pull request 12 is open and the code not deployed. It is merged and deployed. The checklist is brought up to date in T15.
- `doc/evidence/proof-points.md` names commit `47841d2`, not the merge commit; it is regenerated in T15.

## Model configuration on the live site

> **Update 6 Nov 2026 (T4):** this section describes the state at the baseline. `OPENROUTER_MODEL=openai/gpt-oss-120b` has since been set on production (fallback unset), so that model is now the only one. Soak results: `doc/evidence/model-soak.md` (not a pass: one request over 20 s) and `doc/evidence/model-soak-run2.md` (pass).

Production environment variable NAMES (`vercel env ls`; values are encrypted and were not read): `RESEND_API_KEY`, `EMAIL_FROM`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_CLIENT_SECRET`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_ID`, `APP_BASE_URL`, `CRON_SECRET`, `ACCESS_LINK_SECRET`, `OPENROUTER_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `PAYPAL_ENV`, `SANDBOX_MODE`.

- **Finding 3: `OPENROUTER_MODEL` and `OPENROUTER_FALLBACK_MODEL` are not set**, so the code defaults apply (`lib/ai/openrouter.ts` lines 4 and 6): primary `google/gemma-4-31b-it:free`, fallback `openai/gpt-oss-120b`, each attempt with a 20 s timeout. The recorded evaluation (`doc/evidence/ai-intake-real-model.md`) shows Gemma returned HTTP 429 on all 22 messages. So a judge's request can wait up to one full timeout on a rate-limited free model before the paid fallback answers. T4 sets the paid model as primary.
- `DEMO_MERCHANT2_EMAIL` and `DEMO_MERCHANT2_PASSWORD` are not set on Vercel (needed for T9's default path; they are used by the seed script, which runs from a machine, not by the site).
- The Devpost "Tools used" table must name what is actually configured at submission time; recheck after T4.

## Public intake: is there a per-address limit?

Yes (corrected during T2; the first reading of this section looked only for the limiter's import and missed it). `proxy.ts` applies `lib/rate-limit.ts` to the public pages by client address: **30 requests a minute under `/store/`** (the store page and the form that starts a request post to it) and **60 a minute under `/o/`** (the order room, where retries and replies happen). The address comes from `x-forwarded-for`, which Vercel sets. Each conversation also has a cap on model runs (`LIMITS.modelRuns`; a conversation that reaches it is handed to the shop). **Caveat:** the limiter is in memory per server instance, so it is a brake on spam, not a spending cap across instances. With a paid primary model (T4) the OpenRouter credit limit you set on the key is the real backstop. No new limit is needed for the plan.

## Not checked here

- The contents of the live home page beyond the store link, and any page behind a login.
- Whether the live merchant sign-in works with the credentials in your notes.
- Any value of any variable.
