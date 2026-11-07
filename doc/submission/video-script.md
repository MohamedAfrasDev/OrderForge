# OrderForge: demo video script (target 2:45, limit 3:00)

One story: a messy request becomes one exact price, PayPal holds the money, the shop decides, and the same rules hold for an AI agent. The line to land: **AI proposes. Code prices. PayPal holds. The shop decides.**

Record the **hosted** site, `https://order-forge.afras.dev`, on the device it runs on. Upload to YouTube as public. No music, no logos other than what appears on screen in the product itself. Read the lines in "Say" at your own pace; if a beat runs long, cut words, not beats. Beat lengths: 12, 33, 20, 30, 20, 25, 18 and 7 seconds.

## Before recording

- The hosted site must be running the latest merged code (pull request 15: the price, stock-limit and PayPal screens and the shop decision screen). Check `/demo`, `/developers` and the shop's decision page first.
- Clear the throwaway test requests from the hosted site if you want a clean list (ask first; nothing is removed by this script).
- Open in tabs, in this order: `/demo`; the shop's decisions page already signed in (shop login from the Devpost notes); `/developers`; a terminal in the repository; `doc/evidence/proof-points.md` on GitHub.
- Have the PayPal **US Personal sandbox buyer** login ready. Never show the password on screen.
- Browser zoom so text is readable at 1080p. Hide bookmarks and other tabs.
- The model answers can take around ten seconds, and one took 26 seconds in our hosted runs. Start the request, cut the wait in the edit, and keep the real result.
- Test counts: show them for a few seconds at most. What the test proves matters, not the number.

## 0:00-0:12 The problem

- **On screen:** the home page: "OrderForge", the four-part line, and the sentence about prices that drift, stock that is not there and double charges. The sandbox banner at the top.
- **Say:** "Custom orders agreed by message go wrong in three ways: the price drifts, the stock is not there, or a retry charges the customer twice. OrderForge checks each of those in code. This is a PayPal sandbox demo with synthetic data."

## 0:12-0:45 A messy request becomes a visible order

- **On screen:** press "See the complete flow", then "20 welcome boxes". The order page opens with the message sent; "Your order so far": each line marked "From your message", "You confirmed" or "Tell us". Tap one line to change it so it reads "You confirmed". The suggested box appears with "$35.00 per box · $700.00 for 20 boxes" and "Calculated by us".
- **Say:** "The customer just writes what they need. The assistant shows what it understood and where each fact came from: from the message, confirmed by the customer, or calculated by code. The model suggests a box; code works out the price in whole cents. The model has no way to set a price."

## 0:45-1:05 The guardrail: the stock limit

- **On screen:** send "Make it 30 boxes". The note "A stock limit changes your box"; "One change: Steel water bottle becomes Desk organizer"; "$36.00 per box · $1,080.00 in total".
- **Say:** "Ask for 30 and only 24 steel bottles are in stock. Code blocks that box, offers the desk organizer as one change, and prices it again: $36.00 a box, $1,080.00 in total. Nothing the assistant says can move that number."

## 1:05-1:35 One exact price, and PayPal sets the money aside

- **On screen:** choose the box; "Your price" with the large total; press "Accept this price"; the box "What PayPal will do": "You won't be charged yet. PayPal sets $1,080.00 aside"; press "Approve on PayPal"; PayPal's sandbox page with the buyer (password not shown); back on the order page: "Waiting for the shop to confirm".
- **Say:** "The customer accepts one exact version of the price. PayPal sets the money aside; they are not charged yet, and if the shop says no it is released. If anything about the price changes, it is a new price and needs a new yes."

## 1:35-1:55 The shop decides

- **On screen:** the shop's decision page: the exact price and "PayPal is holding $1,080.00"; the two choices "Accept: take the payment" and "Decline: release the hold"; press Accept; "Recently decided: $1,080.00 was charged, once"; switch to the customer page: "Your order is confirmed".
- **Say:** "The shop sees the exact price and the held amount, and one accept and one decline, each saying what it does. Accept charges the held amount once. Decline releases the hold and the stock goes back. The customer sees the result."

## 1:55-2:20 The same rule for an AI agent

- **On screen:** `/developers`: "The agent can request and read; it cannot accept or pay." Run the copyable request in the terminal against the hosted site; the response shows $35.00 and $700.00 in cents and a link for a person. Open the link: it is the same order page.
- **Say:** "Another AI agent can ask a shop for a priced box with five fields and no free text. Code chooses and prices the box; no model is called. The agent gets a link, but only a person can accept the exact price and approve on PayPal. The agent can request and read; it cannot accept or pay."

## 2:20-2:38 Proof, and a second shop

- **On screen:** the terminal: `npm run test:db -- tests/db/payments-decide.test.ts`; highlight "five simultaneous accepts: one decision, one capture begun" (a few seconds on the test count at most). Then `doc/evidence/proof-points.md` on GitHub, the table with the labels, for two seconds; then the home page with the two demo shops.
- **Say:** "Five simultaneous accepts make one decision and one capture. That test uses a local fake PayPal and says so. Every result is in one proof file, labeled mocked, local or real sandbox. The same engine runs a second shop with its own catalog."

## 2:38-2:45 What is real and what is sandbox

- **On screen:** the home page with the banner; the repository page with the MIT license.
- **Say:** "The PayPal calls and the model answers you saw were real sandbox and real model runs. The data is synthetic and nothing real was charged. The code is open. Thank you."

## After recording

- Check the length is at most 3:00 and, ideally, 2:45.
- Check no password, key, token or customer link is visible. The order link in the address bar is a credential; blur it or use a throwaway request.
- Upload as **public** on YouTube; paste the link into Devpost.
