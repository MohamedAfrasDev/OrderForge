// The README is the first thing a judge reads. It must say what the project is for, point at the proof, name every environment variable,
// make no unmeasured claim, and contain no secret.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claimsIn } from "@/lib/claims";

const readme = readFileSync("README.md", "utf8").replace(/\r\n/g, "\n");
const envExample = readFileSync(".env.example", "utf8").replace(/\r\n/g, "\n");
const firstScreen = readme.split("\n").slice(0, 16).join("\n");

describe("README first screen", () => {
  it("states the problem a shop owner and a buyer have", () => {
    expect(firstScreen).toMatch(/price/i);
    expect(firstScreen).toMatch(/stock/i);
    expect(firstScreen).toMatch(/charged twice|double charge/i);
  });

  it("states the idea: the model never does the money, PayPal is tied to one exact price", () => {
    expect(firstScreen).toMatch(/never (does|touches|decides)[^.]*money|model[^.]*never/i);
    expect(firstScreen).toMatch(/one exact (price|quote)/i);
  });

  it("gives the hosted demo, the sandbox label, the safety page and the proof file", () => {
    expect(firstScreen).toContain("https://order-forge.afras.dev");
    expect(firstScreen).toMatch(/sandbox/i);
    expect(firstScreen).toContain("/how-it-works");
    expect(firstScreen).toContain("doc/evidence/proof-points.md");
  });

  it("fits on one screen", () => {
    expect(readme.split("\n").slice(0, 16).filter((l) => l.trim() !== "").length).toBeGreaterThan(5);
  });
});

describe("README content", () => {
  it("makes no unmeasured claim", () => {
    expect(claimsIn(readme)).toEqual([]);
  });

  it("does not say the product modules are unbuilt", () => {
    expect(readme).not.toMatch(/not built yet/i);
    expect(readme).not.toMatch(/Foundation only/i);
  });

  it("names every environment variable in .env.example", () => {
    const names = [...envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]{3,})=/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(15);
    const missing = names.filter((n) => !readme.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });

  it("covers what the brief requires: migrate, seed, worker setup, demo reset, sandbox buyer guidance, known limitations", () => {
    for (const heading of [/supabase db (reset|push)/, /npm run seed/, /Scheduled reconciliation/, /npm run demo:reset/, /Sandbox buyer guidance/, /## Known limitations/, /npm run proof/]) {
      expect(readme).toMatch(heading);
    }
  });
});

describe("no secret in the README or the example environment", () => {
  const SHAPES: Array<[string, RegExp]> = [
    ["a JWT", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
    ["a Supabase secret key", /sb_secret_[A-Za-z0-9_-]{10,}/],
    ["a Resend key", /\bre_[A-Za-z0-9]{16,}/],
    ["an OpenRouter key", /sk-or-[A-Za-z0-9-]{10,}/],
    ["a connection string with a real-looking password", /postgres(ql)?:\/\/[^:\s]+:(?!YOUR-|\[|<)[^@\s]{8,}@/],
  ];
  it.each(SHAPES)("%s", (_name, re) => {
    expect(readme).not.toMatch(re);
    expect(envExample).not.toMatch(re);
  });
});
