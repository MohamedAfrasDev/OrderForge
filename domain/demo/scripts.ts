// Prepared requests for the /demo page. Pure data and lookups, no I/O.
//
// A prepared request is ordinary customer text, chosen on the server by store and key. Nothing here comes from a URL or a form field, so
// there is nothing to inject and no personal data in an address. The figures a request leads to (prices, stock limits) are not written
// here: the engine produces them, and a test checks them against it.

export type DemoScript = {
  key: string;
  /** The button text for starting the request. */
  label: string;
  /** What the visitor "types": the first message of the real flow. Deliberately casual, like a real customer. */
  message: string;
  /** The follow-up that crosses the shop's stock limit. The visitor sends it from the order room; it is shown, not sent for them. */
  change: { boxCount: number; message: string };
};

const GIFT_BOXES: DemoScript = {
  key: "welcome-20",
  label: "20 welcome boxes",
  message: "We need 20 welcome boxes for a conference. Something with notebooks, no food please, and our logo on it. Keep it under $40 per box.",
  change: { boxCount: 30, message: "Actually, can we make it 30 boxes instead?" },
};

const EVENT_KITS: DemoScript = {
  key: "welcome-20",
  label: "20 welcome kits",
  message: "We need 20 welcome kits for a conference. A tote bag and something to drink from, no food please, and our logo on it. Keep it under $40 per kit.",
  change: { boxCount: 50, message: "Actually, can we make it 50 kits instead?" },
};

/** Store slug, then key. Only stores named here get a button; a store that does not exist on the site gets none (checked by the page). */
const SCRIPTS: Readonly<Record<string, Readonly<Record<string, DemoScript>>>> = {
  "demo-gift-boxes": { [GIFT_BOXES.key]: GIFT_BOXES },
  "demo-event-kits": { [EVENT_KITS.key]: EVENT_KITS },
};

/** The prepared request for a store and key, or null for anything else (including names that exist on every object, like "constructor"). */
export function demoScript(slug: unknown, key: unknown): DemoScript | null {
  if (typeof slug !== "string" || typeof key !== "string") return null;
  if (!Object.hasOwn(SCRIPTS, slug)) return null;
  const forStore = SCRIPTS[slug]!;
  return Object.hasOwn(forStore, key) ? forStore[key]! : null;
}

/** Every store with a prepared request, in a fixed order. */
export function demoSlugs(): string[] {
  return Object.keys(SCRIPTS);
}

/** The prepared requests of one store, in a fixed order (empty for a store with none). */
export function demoScriptsFor(slug: string): DemoScript[] {
  return Object.hasOwn(SCRIPTS, slug) ? Object.values(SCRIPTS[slug]!) : [];
}
