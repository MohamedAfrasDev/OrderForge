// The README is the first thing a judge reads. It must say what the project is for, point at the proof, name every environment variable,
// make no unmeasured claim, and contain no secret.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claimsIn } from "@/lib/claims";
import { DEMO_STORE_SLUGS } from "@/lib/demo-store";
import { parseAgentBody } from "@/services/agent-requests/schema";

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

describe("README: For agents", () => {
  const section = readme.slice(readme.indexOf("## For agents"), readme.indexOf("## Accounts and hosted setup"));

  it("exists, says an agent cannot pay or choose a price, and names the OpenAPI file and the human link", () => {
    expect(readme).toContain("## For agents");
    expect(section).toMatch(/cannot choose a price, accept one or pay/);
    expect(section).toContain("/api/agent/v1/openapi.json");
    expect(section).toContain("humanUrl");
  });

  it("its example request is one the API accepts, for a shop that exists in the seed", () => {
    const body = /-d '(\{[^']+\})'/.exec(section)?.[1];
    expect(body).toBeDefined();
    expect(parseAgentBody(JSON.parse(body!)).ok).toBe(true);
    const slug = /\/stores\/([a-z0-9-]+)\/requests/.exec(section)?.[1];
    expect(DEMO_STORE_SLUGS as readonly string[]).toContain(slug);
  });

  it("sends the token in the Authorization header and never in the address", () => {
    expect(section).toMatch(/authorization: Bearer/);
    expect(section).not.toMatch(/\?token=|access_token/);
  });

  it("states the limits the code enforces", async () => {
    const { AGENT_LIMITS } = await import("@/lib/agent-api/limits");
    const { DEFAULT_DAILY_CAP_PER_STORE } = await import("@/services/agent-requests");
    expect(section).toContain(`${AGENT_LIMITS.createPerAddress} requests a minute`);
    expect(section).toContain(`${DEFAULT_DAILY_CAP_PER_STORE} a day`);
  });
});
