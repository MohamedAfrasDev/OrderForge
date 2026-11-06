# Second shop on the hosted site

Task T9 of `judge-readiness` · Date: 6 Nov 2026 · Site: `https://order-forge.afras.dev`

Label: **real model, hosted** (customer side, up to the price review). **Not yet recorded: the PayPal approval and the shop's decision** (see "Not done").

## What was done

1. `npm run seed -- --only=demo-event-kits --confirm-host=<project host>` was run once against the hosted project (the additive option from task T8). Output: `Seeded demo-event-kits ... 6 products, 5 rules.` It created or completed only the second shop and its owner. The first shop was not touched (the run's own guard counts only the chosen shop's orders; the first shop's rows were not read for writing).
2. Public checks straight after:

| Check | Result |
|---|---|
| `GET /api/agent/v1/stores` | Lists `demo-gift-boxes` and `demo-event-kits` |
| `GET /api/agent/v1/stores/demo-event-kits` | 200, kind "event welcome kit", five parts (tote bag, lanyard, drinkware, stickers, packaging) |
| `GET /store/demo-event-kits` | 200 |
| Home page | Offers "Demo Event Kits (simulated)" under the main action |

## One customer journey on Demo Event Kits (real model, in a real browser)

| Step | What happened | Figures |
|---|---|---|
| 1 | Pasted into the store form: "We need 20 welcome kits for a conference. A tote bag and something to drink from, no food please, and our logo on it. Keep it under $40 per kit." | |
| 2 | The assistant read it. The order room showed 20 boxes, no food, logo yes, budget $40.00, each marked "From your message", and a box code chose and priced: canvas tote bag, printed lanyard, insulated bottle, sticker pack, kit mailer box | **$33.50 a box, $670.00 for 20** |
| 3 | Sent in the order room: "Actually, can we make it 50 kits instead?" | |
| 4 | The assistant reported that the first box cannot be made (not enough of one product in stock) and showed the single valid swap: the enamel mug in place of the insulated bottle | **$29.50 a box, $1,475.00 in total** |
| 5 | Chose the swapped box; the order room moved to "Review your price" with the five lines, 50 boxes and the per-box price | $29.50 a box |

Both sets of figures equal what the pricing engine produces for the seed data (`tests/demo/scripts.test.ts`: 20 kits $33.50 / $670.00; 50 kits blocked on 40 insulated bottles, mug at $29.50 / $1,475.00). The page never gave a price that code did not compute.

## Not done

- Accepting the price, approving on PayPal (needs the PayPal sandbox buyer's sign-in), and the shop owner's accept or decline (needs the second shop's owner sign-in). Neither login is entered by the assistant. Until someone does these two steps and records them here, no claim is made that a **complete** journey (to a charge or a release) has run on the second shop on the hosted site. The first shop's complete hosted journeys are recorded elsewhere (`doc/evidence/payments-real-sandbox.md`).
- Each run leaves one throwaway request in this shop's inbox.

## Method limits

One run, one prepared message, observed through the browser pane. It shows that the second shop exists on the live site and answers with the engine's figures. It is not a measure of the model's reliability (see `doc/evidence/model-soak.md` for timing on the first shop).
