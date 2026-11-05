/**
 * Every customer-facing word for where an order stands, in one place. Pages and emails draw these; nothing else writes them.
 * The voice is plain and warm: sentence case, contractions, no jargon. A headline is a label (no full stop); a detail is one
 * sentence that ends with one. What PayPal does is stated exactly as the flow works: the money is set aside at approval, and
 * charged only if the shop accepts.
 */

export const STEP_IDS = ["describe", "choose", "price", "approve", "confirm", "pickup"] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS = ["Describe", "Choose", "Review price", "Approve", "Shop confirms", "Pick up"] as const;

export const WORDS = {
  reading: { headline: "Reading your request", detail: "We're reading what you wrote, which only takes a moment." },
  stalled: { headline: "The assistant hasn't answered yet", detail: "Your message is kept, so try again or ask the shop to take over." },
  needAnswer: { headline: "We need one answer", detail: "Answer the question below and we'll carry on." },
  choose: { headline: "Choose your box", detail: "Pick the box you like best, or change something in your order." },
  withShop: { headline: "With the shop", detail: "The shop has your request and will reply here." },
  pricePreparing: { headline: "Your price is on its way", detail: "We're putting your price together." },
  reviewPrice: { headline: "Review your price", detail: "Check the items and the total; nothing is charged until you approve on PayPal and the shop accepts." },
  priceExpired: { headline: "Your price has expired", detail: "Prices are only held for a while, so send a message to ask for a fresh one." },
  approve: { headline: "Approve your order on PayPal", detail: "PayPal sets the money aside, and you're charged only if the shop accepts." },
  approving: { headline: "Finish approving on PayPal", detail: "Complete the approval on PayPal and you'll come back to this page." },
  payFailed: { headline: "PayPal didn't go through", detail: "Nothing was charged, so you can try approving on PayPal again." },
  waitingShop: { headline: "Waiting for the shop to confirm", detail: "PayPal is holding your payment while the shop reviews your order." },
  checkingPayment: { headline: "We're checking your payment", detail: "This can take a few minutes, and there's nothing you need to do." },
  declined: { headline: "The shop couldn't take this order", detail: "You weren't charged, and PayPal has released the hold." },
  preparing: { headline: "Your order is being prepared", detail: "Your payment is confirmed, and the shop is putting your order together." },
  delayed: { headline: "Your order is taking a little longer", detail: "The shop needs more time than planned." },
  ready: { headline: "Your order is ready for pickup", detail: "Collect it from the shop whenever it suits you." },
  collected: { headline: "Collected", detail: "Your order has been collected, thank you." },
} as const satisfies Record<string, { headline: string; detail: string }>;

export type WordsKey = keyof typeof WORDS;

/**
 * What a customer never reads, by name. Used by the scan tests over every page stage and every email, and by the glossary's own
 * test. A match means a raw state, a code, an id or the system's vocabulary leaked into words meant for a customer.
 */
export const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "successfully", pattern: /\bsuccessfully\b/i },
  { name: "please", pattern: /\bplease\b/i },
  { name: "quote", pattern: /\bquotes?\b/i },
  { name: "authorize", pattern: /\bauthori[sz](e|es|ed|ing|ation)\b/i },
  { name: "capture", pattern: /\bcaptur(e|es|ed|ing)\b/i },
  { name: "void", pattern: /\bvoid(s|ed|ing)?\b/i },
  { name: "inquiry", pattern: /\binquir(y|ies)\b/i },
  { name: "specification", pattern: /\bspecifications?\b/i },
  { name: "proposal", pattern: /\bproposals?\b/i },
  { name: "reservation", pattern: /\breservations?\b/i },
  { name: "worksheet", pattern: /\bworksheets?\b/i },
  { name: "job", pattern: /\bjobs?\b/i },
  { name: "hash", pattern: /\bhash(es)?\b/i },
  { name: "sku", pattern: /\bskus?\b/i },
  { name: "state code", pattern: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/ },
  { name: "all-capitals word", pattern: /\b[A-Z]{4,}\b/ },
  { name: "id", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}\b/i },
];

/** The names of every forbidden pattern the text matches (empty when the text is fit for a customer). */
export function forbiddenIn(text: string): string[] {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}
