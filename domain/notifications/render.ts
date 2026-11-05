import { WORDS } from "@/domain/journey";
import type { NotificationKind } from "./events";

/** Everything a template may use. System data only: the shop's name, an amount the catalog engine computed, a count, a link. Never anything a customer typed. */
export type RenderData = {
  shopName: string;
  /** The customer's own link to their request, or the shop's page to open. */
  link: string;
  /** An amount already formatted for people, like "$1,080.00". */
  totalText?: string;
  boxCount?: number;
};

export type RenderedEmail = { subject: string; text: string; html: string };

const SANDBOX = "This is a sandbox demo: no real money moves.";
const WHY_CUSTOMER = "You're getting this because you gave this address when you started your request.";
const WHY_SHOP = "You're getting this because you run this shop on OrderForge.";

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

type Body = { subject: string; lines: string[]; action: string };

function body(kind: NotificationKind, d: RenderData): Body {
  const boxes = d.boxCount !== undefined ? `${d.boxCount} ${d.boxCount === 1 ? "box" : "boxes"}` : null;
  switch (kind) {
    case "request_started":
      return {
        subject: `Your request to ${d.shopName} is saved`,
        lines: [`Here's the link to your request at ${d.shopName}.`, "Keep this email: the link is the only way back to your order."],
        action: "Open your request",
      };
    case "price_ready":
      return {
        subject: `${d.shopName} prepared your price`,
        lines: [d.totalText ? `${d.shopName} prepared a price: ${d.totalText}${boxes ? ` for ${boxes}` : ""}.` : `${d.shopName} prepared your price.`, WORDS.reviewPrice.detail],
        action: "Review your price",
      };
    case "shop_replied":
      return { subject: `${d.shopName} replied to your request`, lines: [`${d.shopName} wrote back.`, "Open your request to read the reply."], action: "Read the reply" };
    case "order_accepted":
      return {
        subject: `${d.shopName} accepted your order`,
        lines: [d.totalText ? `${d.shopName} accepted your order, and PayPal took ${d.totalText}.` : `${d.shopName} accepted your order.`, WORDS.preparing.detail, "We'll email you again when it's ready."],
        action: "See your order",
      };
    case "order_declined":
      return { subject: WORDS.declined.headline, lines: [`${d.shopName} couldn't take your order.`, WORDS.declined.detail], action: "See your request" };
    case "ready_for_pickup":
      return { subject: WORDS.ready.headline, lines: [`Your order at ${d.shopName} is ready.`, WORDS.ready.detail], action: "See your order" };
    case "request_handed_over":
      return { subject: "A customer needs a reply", lines: ["A customer's request is waiting for you to read and answer.", "Open it to read the conversation, reply, or build a price."], action: "Open requests" };
    case "order_awaiting_ok":
      return {
        subject: "An order is waiting for your OK",
        lines: [d.totalText ? `A customer approved an order of ${d.totalText} on PayPal. PayPal is holding the money until you decide.` : "A customer approved an order on PayPal. PayPal is holding the money until you decide.", "Accept it to take the payment, or decline it to release the hold."],
        action: "Review the order",
      };
  }
}

const isShop = (kind: NotificationKind) => kind === "request_handed_over" || kind === "order_awaiting_ok";

/** The email for an event: a subject, plain text and a small HTML twin. Fixed wording plus system data; every inserted value is escaped in the HTML. */
export function render(kind: NotificationKind, data: RenderData): RenderedEmail {
  const b = body(kind, data);
  const why = isShop(kind) ? WHY_SHOP : WHY_CUSTOMER;
  const subject = `${b.subject} (sandbox demo)`;
  const text = [...b.lines, "", `${b.action}: ${data.link}`, "", SANDBOX, why].join("\n");
  const html = [
    "<!doctype html><html><body style=\"font-family:system-ui,sans-serif;line-height:1.5;color:#111\">",
    ...b.lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p><a href="${escapeHtml(data.link)}">${escapeHtml(b.action)}</a></p>`,
    `<p style="color:#555;font-size:13px">${escapeHtml(SANDBOX)}<br>${escapeHtml(why)}</p>`,
    "</body></html>",
  ].join("");
  return { subject, text, html };
}
