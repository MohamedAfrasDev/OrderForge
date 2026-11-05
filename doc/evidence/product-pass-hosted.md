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

## 3. The whole journey on the hosted site (5 Nov 2026, after your explicit yes)

Run on `order-forge.afras.dev` with the **real model** (OpenRouter), the **real PayPal sandbox** (you approved on PayPal's own sandbox page; no credentials were typed by me) and **real email** (Resend test sender). The hosted request is `97ca7c1a`; the customer address was `mohamedafrasai@gmail.com`. Nothing real was charged (sandbox). hosted, real-email.

| Step | What was seen |
|---|---|
| Describe | "20 welcome boxes, notebooks, no food, our logo, under $40 per box" with the email. Headline "We need one answer": the real model asked whether $40 was the limit. |
| Quick reply | One tap on "Yes, up to $40.00 a box". After about 30 seconds the real model proposed a box: A5 notebook, gel pen, steel bottle, welcome card, packaging, **$35.00 per box, $700.00 for 20 boxes**. Headline "Choose your box". |
| Price | "Choose this box" gave "Review your price" with the itemised table, the terms line ("Quote version 1: 20 boxes at $35.00 per box, $700.00 total (USD)") and "No conditions are pending." Accepted. |
| Approve | "Approve on PayPal": "You won't be charged yet. PayPal sets aside $700.00. The shop reviews your order and, only if they accept, you're charged. If they say no, the hold disappears." Approved by you on PayPal's sandbox page. |
| Shop | Signed in by you. Today showed 1 order waiting for the shop's OK. Accepted: the payment went to **CAPTURED**, the job was created (QUEUED). Then Start preparing, Mark ready for pickup (the customer page read "Your order is ready for pickup", five steps done and Pick up current), Record pickup. |
| End | Customer page: **"Collected"**, all six steps done. Job COLLECTED, payment CAPTURED. |

Emails for this one order (hosted `notifications`, read-only):

| Email | Result |
|---|---|
| Saved link (to the customer) | SENT, 1 attempt |
| Price ready (to the customer) | SENT, 1 attempt |
| Order waiting for the shop's OK (to the **shop's login address**) | **FAILED after 3 attempts** |
| Order accepted (to the customer) | SENT, 1 attempt |
| Ready for pickup (to the customer) | SENT, 1 attempt |

Also confirmed: after the saved-link email was sent, "Keep this page" on the live order page read "We also emailed this link to the address you gave."; no audit row for this request contains an address.

**Finding, not a bug in the code:** the one failed email is the shop's. It goes to the address of the shop's login, and the Resend test sender (`onboarding@resend.dev`) delivers only to the Resend account owner's address. The shop login here is a different address from the one the customer emails went to, so Resend refused it (the provider answered with a non-success, the outbox retried twice more and then marked it FAILED, exactly as designed, and the order was unaffected: accepted, prepared and collected). I cannot see Resend's log from here, so the reason is the expected one, not a confirmed one. It goes away by using the Resend account's address as the shop login, or by verifying a domain in Resend and sending from it. The customer emails (four of the five) were sent and the first was confirmed received by you; I did not ask you to open the others.

Left on the hosted database: four test requests (`9713d02a`, `c6bc598c`, `63ff3816`, `97ca7c1a`), the last with a sandbox order that was accepted, prepared and collected. Nothing else was created.

## 4. Still to do

- Domain verification in Resend and a real sender address, if emails to anyone other than the account owner (and the shop's own order-waiting email) are wanted.
- The PR for these documents.
