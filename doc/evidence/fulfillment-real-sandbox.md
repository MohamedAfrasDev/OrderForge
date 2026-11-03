# Fulfillment: hosted evidence

Label for everything in this file: **hosted** (the real Supabase project and the deployed site). These jobs come from the two orders
that were really paid through the PayPal sandbox on 3 Nov (see [payments-real-sandbox.md](payments-real-sandbox.md)); fulfillment itself
sends nothing to PayPal. Nothing here is copied from the local or mocked results in the checkpoint.

**Status: check 1 passed (3 Nov); check 2 (the customer and the merchant on the live site) is waiting for you.** Read from the hosted database, read-only, at about 06:57 UTC on 3 Nov. The hosted site ran PR 6 (merge commit `3e01097`) with migration 0008 applied.

## Check 1: the reconcile run makes the missing jobs: PASSED

The scheduled run (Supabase pg_cron every 5 minutes, calling `/api/cron/reconcile`) did it by itself; nobody clicked anything.

| Step | Expected | Observed |
|---|---|---|
| Before: preparation jobs on hosted | 0 | 0 jobs, 0 events; 2 captured payments and 2 committed reservations waiting |
| 0008 applied (dry run first) | one pending migration | only `0008_fulfillment.sql`; applied and verified, see the checkpoint |
| The first scheduled run after the deploy | run ends ok; jobs created | 06:55:01 UTC heartbeat, then two `fulfillment.job_created` audit rows by `system:cron` (06:55:05 and 06:55:07). The 06:50 run, just before the deploy took effect, made none, and every run answered HTTP 200 `ok` |
| Jobs for the two captured orders (purchases ending `9f37` and `aca9`) | one job each, QUEUED, one first event each | Exactly that: two jobs, QUEUED, one event each (status QUEUED, actor `system`) |
| The worksheets | 30 boxes, 30 of each of five products, 108000 cents USD, ready-by 7 days on | 30 boxes; CARD-BRANDED, NOTEBOOK-A5, ORGANIZER-DESK, PACK-BOX and PEN-BLK 30 each; paid 108000 USD; ready by 2026-11-10; keys are only the worksheet fields; no PayPal, payer, email or authorization text anywhere in them |
| Orders that were not paid (declined `029e`, expired `f837` and `10fb`) | no job | still no job |
| A second run | no new jobs | the later runs created none; still two jobs and two events |
| `check_stock_invariants()` | empty array | empty array |

## Check 2: the customer sees it, the merchant moves it

| Step | Expected | Observed |
|---|---|---|
| Customer opens the order room of a paid order | "We are preparing your order" with a ready-by day | |
| Merchant opens Jobs | the worksheet lists 30 of each box product | |
| Start, ready, record pickup | each step shows; the customer's page follows | |
| Database | job COLLECTED, four events, no duplicate | |

## Notes to record

- Anything that differed from the local results.
- Whether the scheduled reconcile ran by itself, and how soon after the deploy.
