import { describe, expect, it } from "vitest";
import { BLOCKING_FIELDS, acceptExplanation, acceptQuestion, askSchema, fallbackQuestion, type BlockingField } from "@/domain/intake";

describe("fallbackQuestion", () => {
  for (const field of BLOCKING_FIELDS) {
    it(`${field}: one plain question, no figures, and it passes the same check the model's wording has to pass`, () => {
      const q = fallbackQuestion(field);
      expect(q.endsWith("?")).toBe(true);
      expect(q.match(/\?/g)).toHaveLength(1);
      expect(q).not.toMatch(/\d|[$€£]/);
      expect(q.length).toBeLessThanOrEqual(300);
      expect(acceptQuestion(q, field)).toBe(q);
    });
  }
});

describe("acceptQuestion: only one sentence, on the right topic, with no figures of its own", () => {
  const GOOD: Record<BlockingField, string> = {
    boxCount: "Roughly how many welcome boxes do you need?",
    noFood: "Just to be sure, should the boxes avoid any food items?",
    logoRequired: "Would you like your company logo printed on the box?",
    maxPricePerBoxMinor: "What is the most you would like to spend per box, in dollars?",
    requestedPickupDate: "By which date will you need to collect the order?",
  };

  for (const field of BLOCKING_FIELDS) {
    it(`accepts a reworded ${field} question`, () => {
      expect(acceptQuestion(GOOD[field], field)).toBe(GOOD[field]);
    });
  }

  it("trims surrounding whitespace", () => {
    expect(acceptQuestion(`  ${GOOD.boxCount}\n`, "boxCount")).toBe(GOOD.boxCount);
  });

  it("rejects text that is not a single question", () => {
    expect(acceptQuestion("How many boxes do you need? And what budget?", "boxCount")).toBeNull();
    expect(acceptQuestion("How many boxes do you need", "boxCount")).toBeNull();
    expect(acceptQuestion("How many boxes do you need? Thanks", "boxCount")).toBeNull();
    expect(acceptQuestion("Thanks! How many boxes do you need?", "boxCount")).toBeNull();
    expect(acceptQuestion("Sure. How many boxes do you need?", "boxCount")).toBeNull();
    expect(acceptQuestion("How many boxes?\nHow many boxes?", "boxCount")).toBeNull();
  });

  it("rejects figures of its own: amounts, quantities, SKUs and stock numbers", () => {
    expect(acceptQuestion("We have 24 bottles; how many boxes do you need?", "boxCount")).toBeNull();
    expect(acceptQuestion("Is $40 per box your budget?", "maxPricePerBoxMinor")).toBeNull();
    expect(acceptQuestion("Do you want a budget of forty dollars per box, or less than that?", "maxPricePerBoxMinor")).not.toBeNull();
    expect(acceptQuestion("Do you want ORGANIZER-DESK in each box, and how many boxes?", "boxCount")).toBeNull();
    expect(acceptQuestion("How many boxes do you need (we can do 20)?", "boxCount")).toBeNull();
  });

  it("rejects markup, links and code", () => {
    for (const q of ["How many <b>boxes</b> do you need?", "How many boxes do you need? <script>", "How many `boxes` do you need?", "How many [boxes](http://evil.example) do you need?", "How many boxes do you need at www.evil.example?"]) {
      expect(acceptQuestion(q, "boxCount"), q).toBeNull();
    }
  });

  it("rejects a question about something sensitive or off topic", () => {
    expect(acceptQuestion("What is your credit card for the boxes?", "boxCount")).toBeNull();
    expect(acceptQuestion("Could you send your password so I can set up the boxes?", "boxCount")).toBeNull();
    expect(acceptQuestion("What is your home address for the boxes?", "boxCount")).toBeNull();
    expect(acceptQuestion("What colour do you like?", "boxCount")).toBeNull();
    expect(acceptQuestion(GOOD.logoRequired, "boxCount")).toBeNull(); // a good question, but for another field
  });

  it("rejects the wrong kind of input and the wrong size", () => {
    for (const q of [null, undefined, 5, {}, [], "", "   ", `${"How many boxes do you need ".repeat(20)}?`]) expect(acceptQuestion(q, "boxCount")).toBeNull();
  });
});

describe("askSchema", () => {
  it("is strict: only a question", () => {
    expect(askSchema.safeParse({ question: "How many boxes?" }).success).toBe(true);
    expect(askSchema.safeParse({ question: "How many boxes?", price: 1 }).success).toBe(false);
    expect(askSchema.safeParse({}).success).toBe(false);
  });
});

describe("acceptExplanation: no amount that code did not produce", () => {
  const known = [3600, 108000, 4100, -500, 3100];

  it("accepts text with no amounts at all", () => {
    const text = "The desk organizer keeps everything else the same and is available for all 30 boxes.";
    expect(acceptExplanation(text, known)).toBe(text);
  });

  it("accepts amounts that are exactly ones code computed, in the usual spellings", () => {
    expect(acceptExplanation("That comes to $36 per box.", known)).not.toBeNull();
    expect(acceptExplanation("That comes to $36.00 per box.", known)).not.toBeNull();
    expect(acceptExplanation("The total is $1,080.00.", known)).not.toBeNull();
    expect(acceptExplanation("The total is 1080 dollars.", known)).not.toBeNull();
    expect(acceptExplanation("It is $5 cheaper per box.", known)).not.toBeNull(); // the absolute value of a known delta
    expect(acceptExplanation("It is 500 cents cheaper.", known)).not.toBeNull();
  });

  it("rejects an amount code did not produce", () => {
    expect(acceptExplanation("I can do this for $1.", known)).toBeNull();
    expect(acceptExplanation("That is only $35.99 per box.", known)).toBeNull();
    expect(acceptExplanation("Total: 1 dollar.", known)).toBeNull();
    expect(acceptExplanation("It costs 99 cents.", known)).toBeNull();
    expect(acceptExplanation("It costs $36 and $2.", known)).toBeNull();
    expect(acceptExplanation("It costs US$ 12.", known)).toBeNull();
  });

  it("rejects other currencies, percentages and talk of discounts or free offers", () => {
    for (const t of ["That is €36 per box.", "That is £36 per box.", "That is 1 USD per box.", "A 90% reduction applies.", "I applied a discount for you.", "Use this coupon.", "You get it for free.", "It is free of charge.", "A promo price applies."]) {
      expect(acceptExplanation(t, known), t).toBeNull();
    }
  });

  it("rejects markup, empty text, non-text and over-long text", () => {
    for (const t of ["See <b>this</b> option.", "Use `this` one.", "", "   ", null, undefined, 7, {}, "x".repeat(601)]) expect(acceptExplanation(t as never, known), String(t)).toBeNull();
  });

  it("with no known amounts, any amount is refused", () => {
    expect(acceptExplanation("That is $36.", [])).toBeNull();
    expect(acceptExplanation("That has no price in it.", [])).not.toBeNull();
  });
});
