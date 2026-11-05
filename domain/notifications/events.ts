/** Which emails exist, who they go to, and which of them the current state of one request calls for. Pure: no clock, no database. */

export const CUSTOMER_KINDS = ["request_started", "price_ready", "shop_replied", "order_accepted", "order_declined", "ready_for_pickup"] as const;
export const SHOP_KINDS = ["request_handed_over", "order_awaiting_ok"] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];
export type ShopKind = (typeof SHOP_KINDS)[number];
export type NotificationKind = CustomerKind | ShopKind;
export type Recipient = "customer" | "shop";

export const ALL_KINDS: readonly NotificationKind[] = [...CUSTOMER_KINDS, ...SHOP_KINDS];

export const recipientOf = (kind: NotificationKind): Recipient => ((SHOP_KINDS as readonly string[]).includes(kind) ? "shop" : "customer");

/** What is true of one request right now, in ids and flags only. */
export type RequestState = {
  inquiryId: string;
  /** The customer gave an address when they started. Without one, no customer email is called for. */
  hasCustomerEmail: boolean;
  /** The request is with the shop (the assistant handed it over, or the customer asked the shop to take over). */
  withShop: boolean;
  /** Every price the shop or the assistant published for this request, newest or not: one email each. */
  publishedQuoteIds: readonly string[];
  /** Every reply the shop wrote in the conversation: one email each. */
  shopMessageIds: readonly string[];
  purchases: ReadonlyArray<{
    purchaseId: string;
    /** The customer approved on PayPal and the shop has not decided yet. */
    awaitingShop: boolean;
    decision: "accepted" | "declined" | null;
    /** The order is ready for the customer to collect (or already collected). */
    jobId: string | null;
    jobReady: boolean;
  }>;
};

export type QueuedEvent = { kind: NotificationKind; recipient: Recipient; dedupeKey: string };

const event = (kind: NotificationKind, id: string): QueuedEvent => ({ kind, recipient: recipientOf(kind), dedupeKey: `${kind}:${id}` });

/**
 * The emails the state calls for, each with the key that makes it once-only: the same state always gives the same keys, so queuing it
 * again changes nothing. Customer emails are only called for when the customer gave an address.
 */
export function eventsToQueue(state: RequestState): QueuedEvent[] {
  const out: QueuedEvent[] = [];
  if (state.withShop) out.push(event("request_handed_over", state.inquiryId));
  for (const p of state.purchases) if (p.awaitingShop) out.push(event("order_awaiting_ok", p.purchaseId));

  if (state.hasCustomerEmail) {
    out.push(event("request_started", state.inquiryId));
    for (const id of state.publishedQuoteIds) out.push(event("price_ready", id));
    for (const id of state.shopMessageIds) out.push(event("shop_replied", id));
    for (const p of state.purchases) {
      if (p.decision === "accepted") out.push(event("order_accepted", p.purchaseId));
      if (p.decision === "declined") out.push(event("order_declined", p.purchaseId));
      if (p.jobId && p.jobReady) out.push(event("ready_for_pickup", p.jobId));
    }
  }
  return out;
}
