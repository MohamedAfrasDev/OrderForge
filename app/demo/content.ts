// The words of /demo, kept apart from the markup so a test can scan them like the other public pages. Figures (prices, stock) are not
// written here: the page takes them from the pricing engine (lib/demo/figures.ts). No state name, no unmeasured claim.
import { PROOF_URL, REPO_URL } from "@/app/how-it-works/content";

export { PROOF_URL, REPO_URL };

export type Stage = { title: string; detail: string; human?: boolean };

export const DEMO = {
  title: "See the complete flow",
  line: ["AI proposes.", "Code prices.", "PayPal holds.", "The shop decides."],
  lead:
    "OrderForge turns one vague custom-order request into an order the customer approved on PayPal and the shop confirmed. " +
    "The assistant reads the request, code chooses and prices the box, PayPal sets the money aside, and the shop makes the final call.",

  tryTitle: "Try the real flow",
  tryIntro:
    "Each button starts a real request in a real order room, exactly as if you had typed the message yourself. Nothing is faked or skipped: " +
    "the assistant reads the message, and code checks the stock and the price.",
  sends: "It sends this message:",
  working: "Starting your request. The assistant is reading it, which can take a little while.",
  changeTitle: "Then change the quantity",
  changeIntro: "In the order room, send this as your next message:",
  noStore: "No demo shop is open on this site yet.",

  stagesTitle: "Where a person takes over",
  stages: [
    { title: "The assistant reads it", detail: "It turns your words into a short list of facts and asks only about what is missing." },
    { title: "Code prices it", detail: "The shop's own products, stock and prices decide the box and the exact price. The assistant never sets a price." },
    { title: "You accept the exact price", detail: "Human approval begins here. Nothing moves until a person says yes.", human: true },
    { title: "PayPal holds the money", detail: "You approve on PayPal's own page. The money is set aside; nothing is charged yet.", human: true },
    { title: "The shop decides", detail: "The shop owner reviews the order and accepts or declines.", human: true },
    { title: "Charge or release", detail: "If the shop accepts, the money is charged once. If it declines, the money is released." },
  ] satisfies Stage[],
  humanMark: "A person decides from here",

  needTitle: "What you need",
  needCustomer: "To follow a request as a customer you need nothing: no sign-in. To approve the payment on PayPal you need the PayPal sandbox buyer account. Its address and password are in the Devpost notes, not on this page.",
  needShop: "To see the shop's side, sign in with the shop owner's demo account at the shop sign-in page. Its details are also in the Devpost notes.",
  shopLink: "Shop sign in",
  sandbox: "This is a sandbox demo with synthetic data. Nothing real is charged.",

  linksTitle: "Go deeper",
  links: { how: "How it stays safe", developers: "For agent developers", openapi: "Agent interface description", repo: "The code", proof: "The proof file" },
} as const;

/** Every sentence written here, for the claim scan and the vocabulary scan. */
export function demoText(): string {
  const c = DEMO;
  return [
    c.title, ...c.line, c.lead, c.tryTitle, c.tryIntro, c.sends, c.working, c.changeTitle, c.changeIntro, c.noStore, c.stagesTitle,
    ...c.stages.flatMap((s) => [s.title, s.detail]), c.humanMark, c.needTitle, c.needCustomer, c.needShop, c.shopLink, c.sandbox,
    c.linksTitle, ...Object.values(c.links),
  ].join("\n");
}
