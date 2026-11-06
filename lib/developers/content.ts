// The words on /developers. Kept apart from the page so a test can scan them like the other public pages. Figures that can change (prices,
// limits, field ranges) are not written here: the page takes them from the code that enforces them.

export const DEVELOPERS = {
  title: "For agent developers",
  lead: "OrderForge has a small public interface so another program, such as a buyer's assistant, can ask a demo shop for a priced box and read the answer.",
  rule: "The agent can request and read; it cannot accept or pay.",
  ruleDetail:
    "It sends five facts. Code, not a model, picks the box and prices it. A person opens the link it gets back, chooses the box, accepts the exact price and approves the payment on PayPal's own page. The shop then decides.",

  contractTitle: "What an agent may send",
  contractIntro: "Exactly these five fields. Anything else is refused: a price, a total, a discount, a product choice or free text has nowhere to go. The table is generated from the schema the route uses.",

  requestTitle: "Make a request",
  requestIntro: "One call. No key is needed on the sandbox demo.",
  readTitle: "Read it back",
  readIntro: "The response includes a read-only token. Send it as a bearer token to read the same request later. It cannot read any other request.",

  responseTitle: "What comes back",
  responseIntro: "Produced by the real handler and the real pricing engine, on the demo shop's seed data. Every amount is whole cents. The id and the two tokens are placeholders.",
  blockedTitle: "When the box cannot be made",
  blockedIntro: "A request that does not fit the shop's stock gets a coded reason and the options code found, not a guess. Here the steel bottle runs out, so the engine offers one valid swap.",

  handoffTitle: "Who does what",
  handoffSteps: [
    { who: "The agent", what: "Posts the five fields." },
    { who: "Code", what: "Chooses a box from the shop's own list and prices it to the cent." },
    { who: "A person", what: "Opens the link, chooses the box and accepts the exact price." },
    { who: "PayPal", what: "The person approves; PayPal sets the money aside. Nothing is charged yet." },
    { who: "The shop", what: "Accepts, and the money is charged, or declines, and it is released." },
  ],
  cannotTitle: "What the agent cannot do",
  cannot: [
    "Set or change a price.",
    "Choose the products in the box.",
    "Accept a quote.",
    "Approve or make a payment.",
    "Read any request but its own.",
  ],

  referenceTitle: "Reference and limits",
  openApiLink: "OpenAPI description (JSON)",
  limitsIntro: "These brakes slow abuse. They are not a quota, and they are counted per server instance.",

  sandbox: "This is a sandbox demo with synthetic data. Nothing real is charged.",
  homeLink: "Back to the demo",
} as const;

/** Every sentence on the page that is written here, for the claim scan. */
export function developersText(): string {
  const c = DEVELOPERS;
  return [
    c.title, c.lead, c.rule, c.ruleDetail, c.contractTitle, c.contractIntro, c.requestTitle, c.requestIntro, c.readTitle, c.readIntro,
    c.responseTitle, c.responseIntro, c.blockedTitle, c.blockedIntro, c.handoffTitle, ...c.handoffSteps.flatMap((s) => [s.who, s.what]),
    c.cannotTitle, ...c.cannot, c.referenceTitle, c.openApiLink, c.limitsIntro, c.sandbox, c.homeLink,
  ].join("\n");
}
