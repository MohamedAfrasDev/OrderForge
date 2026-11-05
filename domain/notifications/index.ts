export { parseOptionalEmail } from "./address";
export type { OptionalEmail } from "./address";
export { ALL_KINDS, CUSTOMER_KINDS, SHOP_KINDS, eventsToQueue, recipientOf } from "./events";
export type { CustomerKind, NotificationKind, QueuedEvent, Recipient, RequestState, ShopKind } from "./events";
export { escapeHtml, render } from "./render";
export type { RenderData, RenderedEmail } from "./render";
