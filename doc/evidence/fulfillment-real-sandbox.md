# Fulfillment: hosted evidence

Label for everything in this file: **hosted** (the real Supabase project and the deployed site). These jobs come from the two orders
that were really paid through the PayPal sandbox on 3 Nov (see [payments-real-sandbox.md](payments-real-sandbox.md)); fulfillment itself
sends nothing to PayPal. Nothing here is copied from the local or mocked results in the checkpoint.

**Status: both checks done (3 Nov).** Check 1 was read at about 06:57 UTC and check 2 at about 14:27 UTC, both from the hosted
database, read-only. The hosted site ran PR 6 (merge commit `3e01097`) with migration 0008 applied.

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

## Check 2: the merchant moves the jobs on the live site: PASSED (database side)

The merchant did the clicks on the live site on 3 Nov, between 14:25 and 14:26 UTC. What is recorded below comes from the database.
What the customer page looked like on screen was not seen by me, so the customer-side wording is covered by the E2E tests, not by this file.

| Step | Expected | Observed in the hosted database |
|---|---|---|
| Merchant starts preparing (order ending `9f37`) | QUEUED to PREPARING, one event, one audit row | 14:25:19 UTC: event QUEUED to PREPARING by a merchant actor (`merchant:` plus the user id), audit `fulfillment.job_moved` |
| Marks ready for pickup | PREPARING to READY_FOR_PICKUP | 14:25:51 event, 14:25:52 audit |
| Records pickup | READY_FOR_PICKUP to COLLECTED | 14:26:12 event and audit; job status COLLECTED |
| The same order's log | four events in order, no duplicate | QUEUED (system, 06:55:01), PREPARING, READY_FOR_PICKUP, COLLECTED: exactly four, each with the status it came from |
| The other order (ending `aca9`) | one move, left where it was | QUEUED to PREPARING at 14:25:53, audit at 14:25:54; status PREPARING, two events |
| One job per purchase | 2 jobs, 2 purchases | 2 jobs, 2 distinct purchases |
| `check_stock_invariants()` | empty array | empty array |

Every move names the same merchant user, was made through the merchant Jobs page (the audit rows carry the merchant actor, not the
system), and followed the transition table: no step was skipped and nothing went backwards. An earlier read of the records, a few
hours before these clicks, had found both jobs untouched at QUEUED with one event each.

## What this does not show

- What the customer page looked like on screen during the moves (not seen by me).
- A hold with a note, and a resume, on the live site (not tried).
- A second reconcile run racing a move (the scheduled runs since the first one created no further jobs).
