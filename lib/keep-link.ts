const MAX_SHOP_NAME = 60;

/** The shop's name made safe for a one-line subject: no line breaks or control characters, trimmed, and not endless. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SHOP_NAME);
}

/**
 * A `mailto:` link that opens the customer's own mail app with their order link in it, addressed to nobody: they choose where it
 * goes. Built in the browser; the server sends and stores nothing. The text says honestly that the link is the only way back and
 * that anyone who has it can open the order.
 */
export function keepLinkMailto(link: string, shopName: string): string {
  const subject = `Your order with ${oneLine(shopName) || "the shop"}`;
  const body = ["Here is the link to your order.", "", link, "", "It is the only way back to your order, and anyone who has it can open it, so keep it to yourself."].join("\n");
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
