# OrderForge: Devpost text (draft)

Paste into the Devpost form section by section. Square brackets mark what only the owner can fill in. Everything here is sandbox-only with synthetic data; no figure about speed, demand or accuracy is claimed.

**Project name:** OrderForge
**Tagline:** A vague custom-order request becomes one exact price the customer approves on PayPal and the shop confirms. The model never touches the money.

## Inspiration

Small shops that sell custom or small-batch orders, such as gift boxes, event kits and merch, usually agree a price in a message thread. Three things go wrong. The price changes after the customer agreed. The customer pays for something the shop cannot make because the stock was checked by hand, or not at all. A retry, a reload or a second click charges the customer twice. We wanted a flow where each of those is checked by code, not by trust.

## What it does

**The customer** describes the order in plain words: "20 welcome boxes, notebooks, no food, our logo, under $40 per box". The assistant shows what it understood, marking each fact as read from the message or still unknown, and asks only the questions the system says it cannot do without, one at a time, with tap-to-answer choices. It suggests a box. Code checks every product against the catalog and the live stock and works out the price in whole cents: $35.00 a box, $700.00 for 20 boxes. Ask for 30 boxes and the steel bottle (24 in stock) is blocked; code offers the desk organizer instead, at $36.00 a box, $1,080.00 in total.

The customer accepts that exact price. PayPal sets the money aside; the customer is not charged yet. The page says so in plain words, shows where the order is at every step, and lets them come back with a link that is also emailed.

**The shop** opens one page that shows only what needs it: requests to answer, orders waiting for its OK, orders to prepare. It accepts or declines each order. Accept captures the payment and creates one preparation sheet from the accepted price; decline releases the hold and the stock. A request the assistant cannot finish is handed to the shop, which builds the price from the same catalog (it cannot type a price). The shop edits its own catalog and stock in a data grid.

**An agent-facing request API** lets another AI agent ask a demo shop for a priced box with five fields (quantity, no food, logo, budget in cents, an optional pickup date) and read the answer back. Code chooses and prices the box with the same catalog engine, and no model is called. The agent gets a link for a person; only the person can choose the box, accept the exact price and approve the payment on PayPal. The API takes no price and no free text, its token can only read, and it is rate limited and capped per shop each day.

**A second demo shop** (Demo Event Kits) has a different catalog, box template and stock limit, and its own owner. The same engine runs it, which shows the rules are data and not code written for one shop.

## How we built it

- **Next.js 16.4.3** (App Router), React 19.3, TypeScript, Tailwind CSS 4 and shadcn/ui, deployed on **Vercel**.
- **Supabase** (Postgres, Auth): row level security on every table, unique constraints, a single database call that reserves stock under row locks, and a scheduled job (pg_cron with pg_net) that reconciles payments.
- **PayPal**: Orders v2 with intent AUTHORIZE, then Payments v2 capture or void after the shop decides. Every request carries a stable `PayPal-Request-Id`. After any timeout the system asks PayPal what happened before it retries. Webhooks are verified and de-duplicated, and they are treated as hints, never as proof; an order is marked paid only on PayPal's own records.
- **AG Grid Community** for the shop's data grids; **Resend** for notification emails.
- A spec-first workflow: one approved spec and task list per module, with the checkpoints and evidence in `doc/`.

## Tools used

| Tool | How it is used |
|---|---|
| **PayPal developer platform (sandbox)** | Orders v2 authorize; Payments v2 capture and void; webhook verification; the sandbox buyer approves on PayPal's own page |
| **OpenRouter** (AI models) | Reads the request into a strict schema; rewords one question; chooses one product per part of the box from a fixed list; ranks and explains the alternatives that code produced |
| Models configured | `openai/gpt-oss-120b` (paid) is the only model on the hosted site; no free model and no second model. If it fails, the customer is handed to the shop. (Set on Vercel production 6 Nov 2026.) |
| **Claude Code** | The AI coding assistant used to write the specs, tests and code under the spec-first workflow in this repository |
| Agent API | No model: a strict five-field request, a box chosen and priced by code, a read-only token; a person approves the payment |
| Supabase, Vercel, Resend, AG Grid | Data and auth, hosting, email, data grids |

**What the models cannot do.** They have no field or tool for a price, a quantity of goods, a discount or an order state. Their output is parsed with strict schemas and then validated by code; an answer that names a product outside the allowed list is rejected. Customer text is treated as data inside a fenced block, never as instructions. A local rule-based stand-in (not a model) runs the browser tests so no test calls a real model.

**What we measured, and what we did not.** On 4 Nov 2026 we ran 19 scenarios (22 customer messages) against real models through the real pipeline. With `openai/gpt-oss-120b` every message was usable, there was one miss (it did not ask which of two stated budgets was meant) and no case where the code's checks were bypassed. The free models were rate limited or timed out on many messages, and the configured free primary, Gemma, was rate limited all day and has not been evaluated. Every report is in `eval/intake/reports/`, with the method. We claim nothing about accuracy or speed.

## Challenges

- Webhooks arrive late and out of order (8 to 25 seconds in the sandbox), so the system confirms state by asking PayPal and never moves a payment backwards.
- A shop decision racing a second click: the confirm and decline paths are exclusive, tested over repeated rounds, so exactly one wins and PayPal is never asked for a capture and a void together.
- A timeout after PayPal has processed a capture: the attempt becomes OUTCOME_UNKNOWN and is reconciled by reading PayPal's records before anything is retried.
- Free models are unreliable under a short time limit; the app asks one, falls back once on a provider failure, and shows a hand-off to the shop instead of guessing.
- Keeping the customer's words plain: no "quote", "authorize" or "capture" ever reaches a customer page or email; a test scans every message.

## What's next

- Verify an email domain so notifications reach any customer, not only the account owner.
- Evaluate the free primary model once its provider allows it, and publish the report.
- More shops on the same engine, and delivery as well as pickup.
- Run the agent API on the hosted site and publish its OpenAPI description to other agent builders.

## Proof

- `doc/evidence/proof-points.md`: generated by `npm run proof` from real runs, with every result labeled mocked, scripted, local or real-sandbox.
- `doc/evidence/`: the real PayPal sandbox runs (pay then accept; pay then decline), the real-model evaluation and the whole journey on the hosted site.
- The public page `/how-it-works` explains the three failure modes and the two rules.

## Try it

- **Hosted demo:** https://order-forge.afras.dev (a sandbox demo; synthetic data; nothing real is charged).
- **Customer:** no login. Press "Try it as a customer". When PayPal asks you to log in, use the **US Personal sandbox buyer** account: [ADD: sandbox buyer email and password for the judges].
- **Shop:** `/merchant/login` with [ADD: demo shop login for the judges].
- **Run it yourself:** the README lists the environment variable names, migrations, seed, worker setup and demo reset.
- **Code:** https://github.com/MohamedAfrasDev/OrderForge (MIT license).
