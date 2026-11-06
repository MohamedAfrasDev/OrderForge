// The words of the home page, kept apart from the markup so a test can scan them like the other public pages. No figure, no unmeasured
// claim (lib/claims.ts), and no state name (domain/journey/wording.ts).

export type FlowStep = { who: string; what: string };

export const HOME = {
  title: "OrderForge",
  line: ["AI proposes.", "Code prices.", "PayPal holds.", "The shop decides."],
  problem: "Custom orders agreed by message often end with a price that drifted, stock that isn't there, or a double charge. OrderForge checks each of those in code, not in the chat.",
  promise: "Order custom gift boxes by describing what you need, see an exact price, and approve it on PayPal; you're charged only if the shop accepts.",
  howLink: "How it stays safe",

  flowTitle: "How an order moves",
  flow: [
    { who: "AI proposes", what: "The assistant reads your message into a short list of facts and asks only about what is missing." },
    { who: "Code prices", what: "The shop's own products, stock and prices decide the box and the exact price." },
    { who: "PayPal holds", what: "You approve on PayPal. The money is set aside and nothing is charged yet." },
    { who: "The shop decides", what: "The shop accepts and the money is charged, or declines and it is released." },
  ] satisfies FlowStep[],

  completeFlow: "See the complete flow",
  developers: "For agent developers",
  sandbox: "Sandbox demo with synthetic data. Nothing real is charged.",
} as const;

/** Every sentence written here, for the claim scan and the vocabulary scan. */
export function homeText(): string {
  const c = HOME;
  return [c.title, ...c.line, c.problem, c.promise, c.howLink, c.flowTitle, ...c.flow.flatMap((s) => [s.who, s.what]), c.completeFlow, c.developers, c.sandbox].join("\n");
}
