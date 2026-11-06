// The words of /how-it-works, kept apart from the markup so a test can scan them. No figure, no state name, no unmeasured claim:
// see lib/claims.ts and domain/journey/wording.ts. The numbers live in doc/evidence/proof-points.md, which a command generates.

export type Failure = { problem: string; detail: string; answer: string };
export type Rule = { title: string; body: string };

export const REPO_URL = "https://github.com/MohamedAfrasDev/OrderForge";
export const PROOF_URL = `${REPO_URL}/blob/main/doc/evidence/proof-points.md`;

export const HOW_IT_WORKS = {
  title: "How it stays safe",
  lead:
    "OrderForge turns one vague custom-order request into an order the customer approved on PayPal and the shop confirmed. " +
    "This page explains what goes wrong when a small shop does that by email or chat, and the two rules the product is built around.",
  problemTitle: "The problem",
  problem:
    "Shops that sell custom or small-batch orders, such as gift boxes, event kits and merch, usually agree a price in a message thread. " +
    "Then a customer has to trust that the price they agreed is the price they pay, that the shop can really make what was promised, and that they will be charged once.",
  failuresTitle: "Three things that go wrong",
  failures: [
    {
      problem: "The price changes after the customer agreed",
      detail: "A number is retyped, an item is swapped, and the customer pays something they never saw.",
      answer:
        "The customer accepts one exact version of the price. PayPal sets money aside for that version only. If anything changes, it is a new price and needs a new yes.",
    },
    {
      problem: "The customer pays for something the shop cannot make",
      detail: "Stock is checked by hand, or not at all, and the last bottle is sold twice.",
      answer:
        "Stock is checked by the system, not by the assistant, and the items are held while the customer pays. When an item runs out at the quantity asked for, the system says so and suggests another item.",
    },
    {
      problem: "The customer is charged twice",
      detail: "A page reloads, a request runs out of waiting time, a button is pressed again.",
      answer:
        "Every request to PayPal carries a fixed reference, so a retry repeats nothing. After a timeout the system asks PayPal what happened before it tries again, and one order makes one preparation sheet.",
    },
  ] satisfies Failure[],
  rulesTitle: "The two rules",
  rules: [
    {
      title: "The assistant never touches the money",
      body:
        "The assistant reads the request, asks only the questions the system says it needs, and suggests a box. The system checks every box against the catalog and the stock and works out every price in whole cents. " +
        "A price, quantity or status written by the assistant is not accepted anywhere.",
    },
    {
      title: "PayPal is tied to one exact price",
      body:
        "When the customer approves, they are not charged yet. PayPal sets the money aside and the shop reviews the order. Only if the shop accepts is the customer charged. If the shop says no, the hold disappears.",
    },
  ] satisfies Rule[],
  checkTitle: "Check it yourself",
  check:
    "Each rule above is covered by named tests, and the runs that used the real PayPal sandbox and a real model are written up separately. " +
    "The proof file lists exactly what was run, on which version, and how each result is labeled. We make no claim about speed, demand or accuracy.",
  proofLink: "See the proof file",
  repoLink: "See the code",
  demoLink: "Try the demo",
  sandbox: "This is a sandbox demo with synthetic data. Nothing real is charged.",
} as const;

export type HowItWorks = typeof HOW_IT_WORKS;

/** Every word the page shows, joined, for the scan tests. */
export function allText(c: HowItWorks): string {
  return [
    c.title,
    c.lead,
    c.problemTitle,
    c.problem,
    c.failuresTitle,
    ...c.failures.flatMap((f) => [f.problem, f.detail, f.answer]),
    c.rulesTitle,
    ...c.rules.flatMap((r) => [r.title, r.body]),
    c.checkTitle,
    c.check,
    c.proofLink,
    c.repoLink,
    c.demoLink,
    c.sandbox,
  ].join("\n");
}
