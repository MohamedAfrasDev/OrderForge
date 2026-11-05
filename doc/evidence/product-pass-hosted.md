# product-pass: hosted evidence

Labels: **hosted** = the deployed app at `order-forge.afras.dev` and the hosted Supabase project; **real-email** = a real message through Resend. Recorded 5 Nov 2026, each step after an explicit yes.

## 1. Migration 0010 on the hosted database

Applied with `supabase db push --db-url` after a dry run listed only `0010_notifications.sql`; read-only checks before and after are in `doc/checkpoints/product-pass-checkpoint.md`. hosted.

## 2. The first real email (saved link), to the owner's own address

The test was run through the live site as a customer of the demo store (`/store/demo-gift-boxes`), with `mohamedafrasai@gmail.com` in the optional email field, and the hosted `notifications` table read-only afterwards. The sender is Resend's test sender, which delivers only to the Resend account owner's address.

| Attempt | Hosted request | Row for the saved-link email | Reading |
|---|---|---|---|
| 1 | `9713d02a` | `request_started`, **SKIPPED**, 1 attempt | The running deployment had no email provider (the Resend variables were not live on it yet). Nothing was sent. |
| 2 | `c6bc598c` | `request_started`, **SKIPPED**, 1 attempt | After a redeploy, still no provider. Nothing was sent. |
| 3 | `63ff3816` | `request_started`, **SENT**, 1 attempt, a sent time set | Resend accepted the message. The order page then showed "We also emailed this link to the address you gave." |

What this shows: on the deployed app, with the real key and sender configured, the outbox queued the event, the Resend provider got a successful answer, the row moved to SENT once, and the page's wording followed the row. **The owner confirmed in chat on 5 Nov 2026 that the message arrived in their inbox.** (Their confirmation, not something this repository can check.)

Left on the hosted database: three test requests (`9713d02a`, `c6bc598c`, `63ff3816`), each with the owner's address on it and a first message that says it is a test. They can be removed by the shop; nothing else was created (no price, no payment).

## 3. Still to do

- One hosted run of the whole journey (real model, real PayPal sandbox, emails for the price, the order waiting for the shop's OK, accepted, and ready for pickup): not done; needs a fresh yes. Note that the email for "order waiting for the shop's OK" goes to the shop's login address, which must be the Resend account owner's address while the test sender is used.
