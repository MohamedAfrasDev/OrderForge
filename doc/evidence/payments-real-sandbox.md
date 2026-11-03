# Payments: real-sandbox evidence

Label for everything in this file: **real-sandbox** (the real PayPal sandbox, driven on the hosted site by a person as the buyer).
Nothing here may be copied from the mocked or local results in the checkpoint.

**Status: not run yet.** Migration 0007 is applied to the hosted project (3 Nov). Waiting for: PR 4 merged and deployed, and you as the sandbox buyer.

## Run 1: pay, then the merchant accepts

| Step | Expected | Observed |
|---|---|---|
| Customer opens the order room, quote accepted | "Pay with PayPal" shown | |
| Pay with PayPal | Redirected to the sandbox approval page for USD 1,080.00 (or the quote's total) | |
| Buyer approves, returns | "Payment is authorized ... waiting for the merchant" | |
| Merchant opens Payment decisions | The order is listed with its conditions | |
| Merchant confirms conditions and accepts | Captured, order room says paid | |
| Database | attempt CAPTURED, one capture id, stock committed, one `payment.captured` event labeled real-sandbox | |

## Run 2: pay, then the merchant declines

| Step | Expected | Observed |
|---|---|---|
| Customer pays and approves | Authorized, waiting for the merchant | |
| Merchant declines with a reason | Authorization voided at PayPal, stock released | |
| Order room | "you were not charged" | |
| Database | attempt VOIDED, reservation RELEASED, one `payment.voided` event | |

## Notes to record

- PayPal order, authorization and capture ids are not stored here; use the last four characters only.
- Webhook arrival times relative to our own steps, and any out-of-order delivery.
- Anything that differed from the fake PayPal.
