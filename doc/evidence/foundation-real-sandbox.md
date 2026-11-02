# Evidence: real PayPal sandbox run (foundation, T21)

Date: 2 Nov 2026 (UTC 07:13 to 07:33) · Target: the hosted production site (`order-forge-lake.vercel.app`) talking to the
**real PayPal sandbox** · Amount: 1080 minor units (USD 10.80) per order · Evidence label: `real-sandbox`.

All identifiers below are sandbox identifiers. They come from the hosted database tables `payment_events` (source `spike`
and `webhook`) and `audit_events`, written by the dev page at `/merchant/dev/paypal` and the webhook route.
Mocked and replayed evidence (the local fake PayPal) lives in the test suite and is labeled separately.

## Result

| Flow | Order | Authorization | Capture | Outcome |
|---|---|---|---|---|
| Authorize then capture | `3W3141129R8530006` | `7NU94458K24972901` | `960226353F648044Y` | authorized, captured, 1080 USD, real-sandbox |
| Authorize then void | `9T3837548G451384N` | `5FW80197CB732582F` | none | authorized, then PayPal confirmed the authorization VOIDED |

Tripwire (authorize and capture working in the sandbox by the end of 3 Nov): **passed on 2 Nov. Stay on intent AUTHORIZE.
No fall back to intent CAPTURE.**

## Timeline from the database (UTC)

| Time | Row | Detail |
|---|---|---|
| 07:13:59 | spike.order_created | `8UC17648WR2404933`, abandoned: the buyer step failed (see Findings 1) |
| 07:28:39 | spike.order_created | `76C336177U274534G`, approved (webhook 07:29:59), never authorized |
| 07:30:28 | spike.order_created | `3W3141129R8530006` |
| 07:30:53 | webhook CHECKOUT.ORDER.APPROVED | `3W3141129R8530006` |
| 07:31:12 | spike.authorized | authorization `7NU94458K24972901`, 1080 USD |
| 07:31:14 | spike.captured | capture `960226353F648044Y`, 1080 USD |
| 07:31:26 | webhook PAYMENT.CAPTURE.COMPLETED | resource status COMPLETED |
| 07:31:33 | webhook PAYMENT.AUTHORIZATION.CREATED | resource status already CAPTURED |
| 07:32:46 | spike.authorize_skipped | re-run resumed from the existing authorization (no second authorize) |
| 07:32:47 | spike.void_failed | void on the already-captured authorization was refused: **HTTP 422 UNPROCESSABLE_ENTITY, issue PREVIOUSLY_CAPTURED** |
| 07:32:52 | spike.order_created | `9T3837548G451384N` |
| 07:33:03 | webhook CHECKOUT.ORDER.APPROVED | `9T3837548G451384N` |
| 07:33:07 | spike.authorized | authorization `5FW80197CB732582F` |
| 07:33:09 | spike.voided | PayPal's own GET confirmed status VOIDED |
| 07:33:20 | webhook PAYMENT.AUTHORIZATION.VOIDED | resource status VOIDED |
| 07:33:27 | webhook PAYMENT.AUTHORIZATION.CREATED | resource status already VOIDED |

## Findings that change or confirm the design

1. **The merchant account must be in a country that can receive payments.** The first sandbox accounts were created with
   country LK (Sri Lanka); the buyer saw "The businessman cannot accept PayPal payments at the moment". A new US Business
   account, a new REST app on it, and a US Personal buyer fixed it. Use US accounts for the sandbox.
2. **Link-based approval needs a `return_url`.** Orders are created with
   `payment_source.paypal.experience_context` (`return_url`, `cancel_url`, `user_action: CONTINUE`,
   `shipping_preference: NO_SHIPPING`). PayPal accepted it; the order is created with status `PAYER_ACTION_REQUIRED` and a
   `payer-action` link. PayPal redirects the buyer back with `?token=<order id>`.
3. **The authorize response matches the assumed shape.** `purchase_units[0].payments.authorizations[0]` carried the id, a
   status of `CREATED` and a USD amount equal to the order, and the spike's amount check passed.
4. **Webhook verification works against real deliveries.** Every real delivery was accepted, so PayPal's
   `verification_status` was `SUCCESS`, the `PAYPAL-AUTH-ALGO` header is present and is `SHA256withRSA`, and the raw body
   embedded verbatim verifies. Seven real events were stored, one row each.
5. **Webhooks are delayed and arrive out of order.** They arrived 8 to 25 seconds after the action, and
   `PAYMENT.AUTHORIZATION.CREATED` arrived after `PAYMENT.CAPTURE.COMPLETED` (and after `PAYMENT.AUTHORIZATION.VOIDED`),
   carrying the authorization's current status (`CAPTURED` or `VOIDED`), not `CREATED`. **The payments module must treat
   webhooks as hints and confirm state by asking PayPal; it must never depend on event order.**
6. **A void is confirmed by asking.** After a `voided` result the spike asked PayPal for the authorization and read VOIDED.
7. **Re-running after a failure repeats nothing.** The resume step skipped the authorize that had already happened.

8. **Voiding an already-captured authorization is refused with HTTP 422 `UNPROCESSABLE_ENTITY`, issue `PREVIOUSLY_CAPTURED`**
   (read from the dev page on a repeat click, order `3W3141129R8530006`). It is a 422, not a 409. A capture is never undone
   by a void. The evidence rows of that run stored only the outcome; from this commit on every step stores PayPal's detail
   (HTTP status, error name, issues) in `payment_events.payload.detail`.

## Not observed

- **Sandbox authorization expiry.** The brief says to confirm in your own sandbox whether authorizations expire. That needs up
  to 29 days, so it was not observed. Deadline handling stays covered by application-level tests labeled as such.
