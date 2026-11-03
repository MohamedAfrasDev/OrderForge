# Payments: real-sandbox evidence

Label for everything in this file: **real-sandbox** (the real PayPal sandbox, driven on the hosted site by a person as the buyer).
Nothing here is copied from the mocked or local results in the checkpoint. Read from the hosted database, read-only, on 3 Nov 2026,
about 04:00 UTC. PayPal ids are shown as their last four characters only.

**Status: both runs done, one real bug found.** The hosted site ran the code merged in PR 4 (`480e9e7`), with migration 0007 applied.

## Run 1: pay, then the merchant accepts: PASSED

Two orders were taken this way (purchases ending `9f37` and `aca9`), both end to end.

| Step | Expected | Observed |
|---|---|---|
| Pay with PayPal | Order for the quote's total | Order created for USD 1,080.00 (108000 cents), `payment.order_created` event |
| Buyer approves, returns | Approval verified with PayPal, then authorize | `payment.order_approved`, then `payment.authorized`; authorization id ending `270P` (first order), `604H` (second) |
| Merchant accepts | Capture, verified, stock committed | `payment.captured`; capture id ending `832V` and `160M`; attempt CAPTURED; decision `accepted`; reservation COMMITTED |

## Run 2: pay, then the merchant declines: PASSED

| Step | Expected | Observed |
|---|---|---|
| Pay and approve | Authorized, waiting for the merchant | Purchase ending `029e`: authorization id ending `592R`, `payment.authorized` |
| Merchant declines with a reason | Authorization voided, stock released | Reason "Not finished"; `payment.voided`; attempt VOIDED; decision `declined`; reservation RELEASED with reason DECLINED |

## Webhooks (real delivery)

All 12 real webhooks were verified by PayPal and processed (`processed_at` set). Timing relative to our own steps ranged from 20 milliseconds to about a minute, against the 8 to 25 seconds seen in foundation:

| Event | Arrival relative to our own step |
|---|---|
| `CHECKOUT.ORDER.APPROVED` | between 20 milliseconds and 10 seconds after our approval step (20 ms, 2 s, 8 s, 10 s) |
| `PAYMENT.AUTHORIZATION.CREATED` | 9 to 19 seconds after we authorized, and about a minute after the authorize began on the order in the race below |
| `PAYMENT.CAPTURE.COMPLETED` | 10 and 22 seconds after our capture |
| `PAYMENT.AUTHORIZATION.VOIDED` | 4 seconds after our void |

Events arrive in an order that differs between orders (for example the authorization event before our own `payment.authorized` record
on one order and after it on another), which is what the "webhooks are hints" design assumes.

## Finding: a real race between a webhook and the authorize in progress

On the first checkout (purchase ending `f837`), the `CHECKOUT.ORDER.APPROVED` webhook arrived while we were beginning the authorize.
The sequence from the audit trail (UTC, 3 Nov):

| Time | Step |
|---|---|
| 03:41:24.3 | order approved (our return step) |
| 03:41:25.3 | authorize begun (attempt AUTHORIZE_IN_FLIGHT) |
| 03:41:26.7 | the webhook handler reconciled the attempt: in flight, put in doubt, and PayPal still showed the order APPROVED (its authorize had not finished), so it was settled as "authorize not done" and the attempt went back to APPROVED |
| 03:42:27 | PayPal's `PAYMENT.AUTHORIZATION.CREATED` for the same order arrived |

PayPal did authorize that order, but our record stayed APPROVED with no authorization on file. The mocked tests could not show this,
because the webhook's check for "an operation started moments ago" ran before the attempt was moved in flight, and the reconcile step did not repeat it.
Nothing was captured or lost: it left an unrecorded authorization on one sandbox order and an error for the customer on that step.
**Fix (not yet made):** make the age check part of the reconcile step itself, for the webhook and for the scheduled run, with a regression test.

## Finding: the demo seed zeroed reserved stock

Seeding the hosted demo merchant (to make demo quotes possible) reset stock to the fixture levels while orders already existed:
`reserved` fell to 0 under two live holds and the first capture's committed units were put back. The second order then reserved stock that was
already held, so the organizer desk was oversold on paper (60 committed plus 60 held against 100). Repaired with the owner's approval in one
transaction: the two abandoned holds were released with the product's own function (reason ABANDONED), their attempts expired, and `on_hand` was
set to fixture minus committed (440 cards and pens, 140 notebooks and boxes, 40 desk organizers). `check_stock_invariants()` returns an empty array.
The first repair attempt was refused by the database's own stock check; the second left `on_hand` 60 too high until a follow-up update fixed it.

## What was not seen

- A financial exception, an unknown outcome and an authorization expiry did not happen on the real sandbox; those are only in the mocked and application-level evidence.
- The seed script refuses a remote database without `--confirm-host`; running it against a database that already holds orders is unsafe and should be documented in the README.
