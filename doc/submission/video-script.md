# OrderForge: demo video script (target 2:45, limit 3:00)

Record the **hosted** site, `https://order-forge.afras.dev`, on the device it runs on. Upload to YouTube as public. No music, no logos other than what appears on screen in the product itself. Read the lines in "Say" in your own pace; if a beat runs long, cut words, not beats.

## Before recording

- Clear the three old test requests from the hosted site if you want a clean list (ask first; nothing is removed by this script).
- Open in tabs, in this order: the home page; `/how-it-works`; the shop's Today page already signed in (shop login from the Devpost notes); a terminal in the repository; `doc/evidence/proof-points.md` on GitHub.
- Have the PayPal **US Personal sandbox buyer** login ready. Never show the password on screen.
- Browser zoom so text is readable at 1080p. Hide bookmarks and other tabs.
- The model answers can take about 30 seconds on the hosted site (see the hosted evidence). Start the request, cut the wait in the edit, and keep the real result.

## 0:00-0:10 The problem

- **On screen:** the home page: "OrderForge" and the sentence about prices that drift, stock that is not there and double charges. Then the sandbox banner at the top.
- **Say:** "Custom orders agreed by message go wrong in three ways: the price drifts, the stock is not there, or a retry charges the customer twice. OrderForge checks each of those in code. This is a PayPal sandbox demo with synthetic data."

## 0:10-0:30 A messy request becomes a visible specification

- **On screen:** press "Try it as a customer". Type: "20 welcome boxes, notebooks, no food, our logo, under $40 per box". The order page opens with "Your order so far": each line marked as read from the message or "Tell us".
- **Say:** "The customer just writes what they need. The assistant shows what it understood and where each fact came from. It asks only what the system says it cannot do without."

## 0:30-0:55 A box, priced by code

- **On screen:** the suggested box with its items and "$35.00 per box · $700.00 for 20 boxes".
- **Say:** "The model suggests a box. Code checks every product against the catalog and the stock and works out the price in whole cents: $35.00 a box, $700.00 for 20. The model has no way to set a price."

## 0:55-1:15 The stock limit

- **On screen:** a second request, or edit the quantity: "Make it 30 boxes". The steel bottle is blocked; "Replace Steel water bottle with Desk organizer"; "$36.00 per box · $1,080.00 in total".
- **Say:** "Ask for 30 and only 24 steel bottles are in stock. Code blocks that box, offers the desk organizer, and prices it again: $36.00 a box, $1,080.00 in total."

## 1:15-1:40 One exact price, and PayPal sets the money aside

- **On screen:** "Your price" itemised; press "Accept this price"; the box: "You won't be charged yet. PayPal sets $700.00 aside"; press "Approve on PayPal"; PayPal's sandbox page with the buyer; return to the order page: "Waiting for the shop to confirm".
- **Say:** "The customer accepts one exact version of the price. PayPal sets the money aside; they are not charged yet. If anything about the price changes, it is a new price and needs a new yes."

## 1:40-2:05 The shop decides

- **On screen:** the shop's Today page: "1 order waiting for your OK"; open it; press Accept; then Prepare orders: the pick list; Start preparing, Mark ready, Record pickup; switch to the customer page: "Collected".
- **Say:** "The shop sees only what needs it. Accept, and the payment is taken and one preparation sheet is created from the accepted price. Decline, and the hold is released and the stock goes back. The customer sees every step."

## 2:05-2:25 A repeated click cannot charge twice

- **On screen:** the terminal: `npm run test:db -- tests/db/payments-decide.test.ts`; highlight the line "five simultaneous accepts: one decision, one capture begun". Then `tests/db/fulfillment-create.test.ts`: one job.
- **Say:** "Here is the repeated-click test, run against a real database with a mocked PayPal. Five simultaneous accepts make one decision and one capture, and a paid order makes one preparation job. This test uses the local fake, and it is labeled that way."

## 2:25-2:35 The proof, and a second shop

- **On screen:** `doc/evidence/proof-points.md` on GitHub, scrolled to the table with the labels; then the home page with the two demo stores, opening Demo Event Kits for two seconds.
- **Say:** "Every result is generated into one file and labeled mocked, local or real sandbox. The same engine runs a second shop with a different catalog and its own owner."

## 2:35-2:45 What is real and what is sandbox

- **On screen:** the home page with the banner; the repository page with the MIT license.
- **Say:** "The PayPal calls and the model answers you saw were real sandbox and real model runs. The data is synthetic and nothing real was charged. The code is open under the MIT license. Thank you."

## After recording

- Check the length is at most 3:00 and, ideally, 2:45.
- Check no password, key, token or customer link is visible. The order link in the address bar is a credential; blur it or use a throwaway request.
- Upload as **public** on YouTube; paste the link into Devpost.
