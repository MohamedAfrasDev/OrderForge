// Words that claim a benefit nobody measured are banned from the pages and documents written for visitors and judges.
// This file tests the scanner itself, then scans the how-it-works page's text. Later tasks add the README and the submission pack.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forbiddenIn } from "@/domain/journey";
import { claimsIn } from "@/lib/claims";
import { allText, HOW_IT_WORKS } from "@/app/how-it-works/content";
import { demoText } from "@/app/demo/content";
import { homeText } from "@/app/home-content";
import { developersText } from "@/lib/developers/content";

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

describe("the home, /demo and /developers page text", () => {
  it("the home page makes no unmeasured claim, uses the customer vocabulary and says sandbox", () => {
    const text = homeText();
    expect(claimsIn(text)).toEqual([]);
    expect(forbiddenIn(text)).toEqual([]);
    expect(text).toMatch(/sandbox/i);
    expect(text).toMatch(/AI proposes\.\s+Code prices\.\s+PayPal holds\.\s+The shop decides\./);
  });

  it.each([["/demo", demoText()], ["/developers", developersText()]])("%s makes no unmeasured claim and says sandbox and synthetic", (_page, text) => {
    expect(text.length).toBeGreaterThan(500);
    expect(claimsIn(text)).toEqual([]);
    expect(text).toMatch(/sandbox/i);
    expect(text).toMatch(/synthetic/i);
  });

  it("/demo uses the customer vocabulary, holds no password, and says where approval begins", () => {
    const text = demoText();
    expect(forbiddenIn(text)).toEqual([]);
    expect(text).not.toMatch(/password:|passwd|secret|token/i);
    expect(text).toMatch(/human approval begins here/i);
    expect(text).toMatch(/nothing is charged yet/i);
  });
});

// ---- the submission pack (doc/submission) -----------------------------------------------------------------------------------------
const PACK = ["devpost-text.md", "video-script.md", "screenshots.md", "final-checklist.md"] as const;
const read = (name: string) => readFileSync(`doc/submission/${name}`, "utf8").replace(/\r\n/g, "\n");

describe("the submission pack", () => {
  it.each(PACK)("%s exists", (name) => {
    expect(existsSync(`doc/submission/${name}`)).toBe(true);
  });

  it.each(PACK)("%s makes no unmeasured claim", (name) => {
    const text = read(name);
    // The checklist quotes the rules about trademarks and licenses; it is scanned as well, with no exceptions.
    expect(claimsIn(text), name).toEqual([]);
  });

  it("devpost-text.md has the sections Devpost asks for, says sandbox and synthetic, and names the tools and how each is used", () => {
    const t = read("devpost-text.md");
    for (const h of ["## Inspiration", "## What it does", "## How we built it", "## Tools used", "## Challenges", "## What's next", "## Try it"]) expect(t, h).toContain(h);
    expect(t).toMatch(/sandbox/i);
    expect(t).toMatch(/synthetic/i);
    for (const tool of ["OpenRouter", "PayPal", "Supabase", "Vercel", "Resend", "AG Grid", "Claude Code"]) expect(t, tool).toContain(tool);
    expect(t).toContain("doc/evidence/proof-points.md");
  });

  it("devpost-text.md is honest about the model evaluation: it says the free primary was not evaluated", () => {
    expect(read("devpost-text.md")).toMatch(/not (been )?evaluated|was rate limited/i);
  });

  it("video-script.md has contiguous timed beats that end at or before 2:45", () => {
    const beats = [...read("video-script.md").matchAll(/^## (\d):(\d\d)[-–](\d):(\d\d) /gm)].map((m) => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])] as const);
    expect(beats.length).toBeGreaterThanOrEqual(8);
    expect(beats[0]![0]).toBe(0);
    for (let i = 0; i < beats.length; i++) {
      expect(beats[i]![1], `beat ${i + 1} ends after it starts`).toBeGreaterThan(beats[i]![0]);
      if (i > 0) expect(beats[i]![0], `beat ${i + 1} starts where the last ended`).toBe(beats[i - 1]![1]);
    }
    expect(beats.at(-1)![1]).toBeLessThanOrEqual(165);
  });

  it("video-script.md shows the stock limit, the exact price, the hold, the shop's decision, the repeated-click test and the proof file, and says what is real and what is sandbox", () => {
    const t = read("video-script.md");
    for (const must of [/\$35\.00/, /\$700\.00/, /24/, /\$1,080\.00/, /sets? (the )?money aside/i, /accept/i, /decline/i, /five simultaneous/i, /proof-points/, /sandbox/i, /synthetic/i]) expect(t, String(must)).toMatch(must);
  });

  it("devpost-text.md opens with what makes it different, before the background, and is honest about the sellers and the second shop", () => {
    const t = read("devpost-text.md");
    expect(t.indexOf("## What makes it different")).toBeGreaterThan(0);
    expect(t.indexOf("## What makes it different")).toBeLessThan(t.indexOf("## Inspiration"));
    expect(t).toContain("AI proposes. Code prices. PayPal holds. The shop decides.");
    expect(t).toMatch(/cannot choose a price, accept one or pay/);
    expect(t).toMatch(/not yet validated the problem with shop owners/i);
    expect(t).toContain("/demo");
    expect(t).toContain("/developers");
    // The second shop's complete journey is not claimed until it is recorded: the text says what was run and keeps a marker to confirm.
    expect(t).toContain("up to the price review");
    expect(t).toContain("[CONFIRM before submitting");
  });

  it("devpost-text.md names the one configured model and not the retired free primary as configured", () => {
    const t = read("devpost-text.md");
    expect(t).toMatch(/`openai\/gpt-oss-120b` \(paid\) is the only model on the hosted site/);
    expect(t).not.toMatch(/`google\/gemma-4-31b-it:free` first/);
  });

  it("video-script.md is eight beats of 12, 33, 20, 30, 20, 25, 18 and 7 seconds, and lands the agent rule", () => {
    const t = read("video-script.md");
    const beats = [...t.matchAll(/^## (\d):(\d\d)[-–](\d):(\d\d) /gm)].map((m) => Number(m[3]) * 60 + Number(m[4]) - (Number(m[1]) * 60 + Number(m[2])));
    expect(beats).toEqual([12, 33, 20, 30, 20, 25, 18, 7]);
    expect(t).toContain("The agent can request and read; it cannot accept or pay.");
    expect(t).toContain("AI proposes. Code prices. PayPal holds. The shop decides.");
  });

  it("screenshots.md lists the home page, the price and stock frame, the PayPal frame, the shop decision, the result and /developers", () => {
    const t = read("screenshots.md");
    for (const frame of [/\*\*Home\.\*\*/, /\*\*Price and stock warning\.\*\*/, /what PayPal will do/i, /\*\*The shop's decision\.\*\*/, /\*\*The result\.\*\*/, /`\/developers`/]) expect(t).toMatch(frame);
  });

  it("the README's first screen links the guided path and the agent page", () => {
    const first = readFileSync("README.md", "utf8").split(/\r?\n/).slice(0, 16).join("\n");
    expect(first).toContain("/demo");
    expect(first).toContain("/developers");
  });

  it("final-checklist.md: every line is ticked with evidence or marked OPEN with a reason, and it says to recheck the rules", () => {
    const lines = read("final-checklist.md").split("\n").filter((l) => /^- \[[ x]\] /.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(10);
    for (const l of lines) {
      if (l.startsWith("- [ ] ")) expect(l, l).toMatch(/OPEN:/);
      else expect(l, l).toMatch(/Evidence:/);
    }
    expect(read("final-checklist.md")).toMatch(/recheck the official rules/i);
  });

  it("screenshots.md lists at least six captioned shots", () => {
    expect([...read("screenshots.md").matchAll(/^\d+\. \*\*/gm)].length).toBeGreaterThanOrEqual(6);
  });
});
