# OrderForge: Devpost text (draft)

Paste into the Devpost form section by section. Square brackets mark what only the owner can fill in. Everything here is sandbox-only with synthetic data; no figure about speed, demand or accuracy is claimed.

**Project name:** OrderForge
**Tagline:** AI proposes. Code prices. PayPal holds. The shop decides.

## What makes it different

Most AI checkout demos let a model talk and hope it gets the numbers right. OrderForge is built the other way round: the model can read a messy request and suggest a box, but it has no field, tool or permission for a price, a quantity of goods or an order's state. Code checks every product against the shop's own catalog and stock and works out every price in whole cents. PayPal sets the money aside for one exact price the customer accepted; the customer is not charged yet. Then the shop says yes or no. Yes charges the held amount once. No releases the hold and frees the stock.

The same rule holds for software that is not a person. Another AI agent can ask a demo shop for a priced box through a small public interface, five fields and no free text, and read the answer back. It cannot choose a price, accept one or pay: it gets a link, and only a person can open it, accept the exact price and approve on PayPal's own page. That is the difference we are submitting: AI does the reading and the suggesting, and the parts that move money stay in code, in PayPal and with a person.

We have not yet validated the problem with shop owners: it is described from the project brief, and we claim no measurement of how often it happens or what it costs.

## Inspiration

Small shops that sell custom or small-batch orders, such as gift boxes, event kits and merch, usually agree a price in a message thread. Three things go wrong. The price changes after the customer agreed. The customer pays for something the shop cannot make because the stock was checked by hand, or not at all. A retry, a reload or a second click charges the customer twice. We wanted a flow where each of those is checked by code, not by trust.

## What it does

**The customer** describes the order in plain words: "20 welcome boxes, notebooks, no food, our logo, under $40 per box". The assistant shows what it understood, and every line says where it came from: **From your message** (the assistant read it), **You confirmed** (the customer set or answered it) or **Calculated by us** (code worked it out from the shop's prices and stock, not the assistant). It asks only the questions the system says it cannot do without, one at a time, with tap-to-answer choices. It suggests a box. Code checks every product against the catalog and the live stock and works out the price in whole cents: $35.00 a box, $700.00 for 20 boxes. Ask for 30 boxes and the steel bottle (24 in stock) is blocked in a note of its own; code offers the desk organizer instead, shown as one change, at $36.00 a box, $1,080.00 in total.

The customer accepts that exact price. A box says what PayPal will do: it sets the money aside, the customer is not charged yet, the shop decides, and a no releases the hold. The page shows where the order is at every step and lets them come back with a link that is also emailed.

**The shop** opens one page that shows only what needs it: requests to answer, orders waiting for its OK, orders to prepare. The decision screen states the exact price and the held amount and offers one Accept and one Decline, each saying what it does. Accept takes the held payment once and creates one preparation sheet from the accepted price; decline releases the hold and the stock. A "Recently decided" list shows a decision as finished only when PayPal's result confirms it, and the customer's page ends on a clear result: "Your order is confirmed" or "The shop couldn't take this order". A request the assistant cannot finish is handed to the shop, which builds the price from the same catalog (it cannot type a price). The shop edits its own catalog and stock in a data grid.

**An agent-facing request API** lets another AI agent ask a demo shop for a priced box with five fields (quantity, no food, logo, budget in cents, an optional pickup date) and read the answer back. Code chooses and prices the box with the same catalog engine, and no model is called. The agent gets a link for a person; only the person can choose the box, accept the exact price and approve the payment on PayPal. The API takes no price and no free text, its token can only read, and it is rate limited and capped per shop each day. The page `/developers` shows the five fields, a copyable request and real responses produced by the same handler and pricing engine, including the coded stock-limit answer.

**A guided path for judges:** `/demo` starts the real flow from a prepared messy request, shows the follow-up that crosses the stock limit, marks where human approval begins, and says which sandbox accounts are needed.

**A second demo shop** (Demo Event Kits) has a different catalog, box template and stock limit, and its own owner. The same engine runs it, which shows the rules are data and not code written for one shop. It is on the hosted site. On 7 Nov 2026 one customer journey was run there with the real model up to the price review ($33.50 a kit, $670.00 for 20; then 50 kits blocked on the insulated bottle and the enamel mug offered at $29.50 a kit, $1,475.00). [CONFIRM before submitting: only add "and paid through PayPal and decided by the shop" if that journey is run and recorded in `doc/evidence/second-shop-hosted.md`.]

## How we built it

- **Next.js 16.4.3** (App Router), React 19.3, TypeScript, Tailwind CSS 4 and shadcn/ui, deployed on **Vercel**.
- **Supabase** (Postgres, Auth): row level security on every table, unique constraints, a single database call that reserves stock under row locks, and a scheduled job (pg_cron with pg_net) that reconciles payments.
- **PayPal**: Orders v2 with intent AUTHORIZE, then Payments v2 capture or void after the shop decides. Every request carries a stable `PayPal-Request-Id`. After any timeout the system asks PayPal what happened before it retries. Webhooks are verified and de-duplicated, and they are treated as hints, never as proof; an order is marked paid only on PayPal's own records.
- **AG Grid Community** for the shop's data grids; **Resend** for notification emails.
- A spec-first workflow: one approved spec and task list per module, with the checkpoints and evidence in `doc/`.

## Tools used

| Tool                                    | How it is used                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PayPal developer platform (sandbox)** | Orders v2 authorize; Payments v2 capture and void; webhook verification; the sandbox buyer approves on PayPal's own page                                                                      |
| **OpenRouter** (AI models)              | Reads the request into a strict schema; rewords one question; chooses one product per part of the box from a fixed list; ranks and explains the alternatives that code produced               |
| Models configured                       | `openai/gpt-oss-120b` (paid) is the only model on the hosted site; no free model and no second model. If it fails, the customer is handed to the shop. (Set on Vercel production 6 Nov 2026.) |
| **Claude Code**                         | The AI coding assistant used to write the specs, tests and code under the spec-first workflow in this repository                                                                              |
| Agent API                               | No model: a strict five-field request, a box chosen and priced by code, a read-only token; a person approves the payment                                                                      |
| Supabase, Vercel, Resend, AG Grid       | Data and auth, hosting, email, data grids                                                                                                                                                     |

**What the models cannot do.** They have no field or tool for a price, a quantity of goods, a discount or an order state. Their output is parsed with strict schemas and then validated by code; an answer that names a product outside the allowed list is rejected. Customer text is treated as data inside a fenced block, never as instructions. A local rule-based stand-in (not a model) runs the browser tests so no test calls a real model.

**What we measured, and what we did not.** On 4 Nov 2026 we ran 19 scenarios (22 customer messages) against real models through the real pipeline. With `openai/gpt-oss-120b` every message was usable, there was one miss (it did not ask which of two stated budgets was meant) and no case where the code's checks were bypassed. The free models were rate limited or timed out on many messages, and the free model Gemma, the earlier primary, was rate limited all day and has not been evaluated; it is no longer configured. On 6 Nov 2026 we sent two runs of ten requests each through the hosted customer flow with `gpt-oss-120b`: all 20 were answered by the model, none ended in the hand-off, and 19 took between 8.8 and 16.6 seconds; one, the first request of the first run, took 26.4 seconds, which is over our own 20 second limit, so that run is recorded as not a pass and the second as a pass (`doc/evidence/model-soak.md`, `model-soak-run2.md`). That is how the model behaved on those two runs, not a promise about later. We claim nothing about accuracy.

## Challenges

- Webhooks arrive late and out of order (8 to 25 seconds in the sandbox), so the system confirms state by asking PayPal and never moves a payment backwards.
- A shop decision racing a second click: the confirm and decline paths are exclusive, tested over repeated rounds, so exactly one wins and PayPal is never asked for a capture and a void together.
- A timeout after PayPal has processed a capture: the attempt becomes OUTCOME_UNKNOWN and is reconciled by reading PayPal's records before anything is retried.
- A model that is slow or unavailable: the hosted site uses one model with a 20 second limit and, on a failure, shows a hand-off to the shop and a retry instead of guessing.
- Keeping the customer's words plain: no "authorize" or "capture" ever reaches a customer page or email; a test scans every message.
- Making the demo easy to judge without faking it: `/demo` starts the same code path a typed request takes (one shared function, tested against a real database), so a prepared request cannot take a shortcut.

## What's next

- Verify an email domain so notifications reach any customer, not only the account owner.
- Evaluate other models and publish the reports.
- More shops on the same engine, and delivery as well as pickup.
- Talk to shop owners who handle custom orders and record what they say; until then the problem statement above is unvalidated.
- Publish the agent API's OpenAPI description to other agent builders.

## Proof

- `doc/evidence/proof-points.md`: generated by `npm run proof` from real runs, with every result labeled mocked, scripted, local or real-sandbox.
- `doc/evidence/`: the real PayPal sandbox runs (pay then accept; pay then decline), the real-model evaluation, the hosted model runs, the second shop on the hosted site and the whole journey on the hosted site.
- The public pages `/how-it-works` (three failure modes and two rules), `/demo` (the guided path) and `/developers` (the agent interface).

## Try it

- **Hosted demo:** https://order-forge.afras.dev (a sandbox demo; synthetic data; nothing real is charged). Start at `/demo`.
- **Customer:** no login. Press "Try it as a customer". When PayPal asks you to log in, use the **US Personal sandbox buyer** account: [Email: sb-azthw53634731@personal.example.com | Password: Mx)6T/%I].
- **Shop:** `/merchant/login`. Each shop only sees its own orders, so sign in as the owner of the shop the customer ordered from. "Try it as a customer" starts at **Demo Gift Boxes**: [Email: merchant@demo.test | Password: (the DEMO_MERCHANT_PASSWORD you set; paste it here)]. **Demo Event Kits** (the second shop) is [Email: merchant2@demo.test | Password: demomerch2@W.jnnH_2].
- **Agents:** `/developers` and `/api/agent/v1/openapi.json`.
- **Run it yourself:** the README lists the environment variable names, migrations, seed, worker setup and demo reset.
- **Code:** https://github.com/MohamedAfrasDev/OrderForge (MIT license).
