// Words that claim a benefit nobody measured are banned from the pages and documents written for visitors and judges.
// This file tests the scanner itself, then scans the how-it-works page's text. Later tasks add the README and the submission pack.
import { describe, expect, it } from "vitest";
import { forbiddenIn } from "@/domain/journey";
import { claimsIn } from "@/lib/claims";
import { allText, HOW_IT_WORKS } from "@/app/how-it-works/content";

describe("claimsIn", () => {
  it.each([
    "It saves hours every week.",
    "Orders are processed faster than email.",
    "Conversion increased after launch.",
    "This will boost sales.",
    "Trusted by 200 shops.",
    "We guarantee a correct price.",
    "Cuts errors by 40%.",
    "Ten times quicker.",
    "A 10x improvement.",
    "Reduces costs for small shops.",
    "Eliminates mistakes.",
  ])("flags %s", (text) => {
    expect(claimsIn(text).length, text).toBeGreaterThan(0);
  });

  it.each([
    "PayPal sets the money aside for one exact price.",
    "The shop reviews the order and decides.",
    "1,329 database tests passed on commit abc1234.",
    "This is a sandbox demo with synthetic data.",
    "We make no claim about speed, demand or accuracy.",
  ])("lets %s through", (text) => {
    expect(claimsIn(text), text).toEqual([]);
  });

  it("names which rule matched", () => {
    expect(claimsIn("Cuts errors by 40%.")).toContain("percentage");
  });
});

describe("the how-it-works page text", () => {
  const text = allText(HOW_IT_WORKS);

  it("is not empty and names the problem, the three failure modes and the two rules", () => {
    expect(text.length).toBeGreaterThan(500);
    expect(HOW_IT_WORKS.failures).toHaveLength(3);
    expect(HOW_IT_WORKS.rules).toHaveLength(2);
  });

  it("makes no unmeasured claim", () => {
    expect(claimsIn(text)).toEqual([]);
  });

  it("uses the shop-and-customer vocabulary: no raw state, id or system word", () => {
    expect(forbiddenIn(text)).toEqual([]);
  });

  it("contains no figure that can go stale (no digits except in the words 'two' and 'three' written as digits)", () => {
    expect(text).not.toMatch(/\d/);
  });

  it("says it is a sandbox demo with synthetic data, and that nothing real is charged", () => {
    expect(text).toMatch(/sandbox/i);
    expect(text).toMatch(/synthetic/i);
    expect(text).toMatch(/nothing real is charged/i);
  });

  it("explains the PayPal step the way the order room does", () => {
    expect(text).toMatch(/sets? (the )?money aside/i);
    expect(text).toMatch(/only if the shop accepts/i);
  });
});
