# Fulfillment: hosted evidence

Label for everything in this file: **hosted** (the real Supabase project and the deployed site). These jobs come from the two orders
that were really paid through the PayPal sandbox on 3 Nov (see [payments-real-sandbox.md](payments-real-sandbox.md)); fulfillment itself
sends nothing to PayPal. Nothing here is copied from the local or mocked results in the checkpoint.

**Status: not run yet.** Waiting for: migration 0008 applied to the hosted project, PR 6 merged and deployed, and a reconcile run.

## Check 1: the reconcile run makes the missing jobs

| Step | Expected | Observed |
|---|---|---|
| Before: preparation jobs on hosted | 0 | |
| 0008 applied (dry run first) | one pending migration, `0008_fulfillment.sql` | |
| PR 6 deployed; the scheduled reconcile runs (or the merchant's "run reconcile now" button) | run ends `ok` | |
| Jobs for the two captured orders (purchases ending `9f37` and `aca9`) | one job each, QUEUED, one first event each | |
| A second run | no new jobs | |
| Orders that were not paid (declined `029e`, expired attempts) | no job | |

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
