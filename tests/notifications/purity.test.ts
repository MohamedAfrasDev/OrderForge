import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importsOf } from "../catalog/purity.test";

const DIR = join(process.cwd(), "domain", "notifications");
// The words come from the journey glossary (itself pure); everything else is a file of this module.
const allowed = (s: string) => s === "@/domain/journey" || /^\.\/[\w-]+$/.test(s);

describe("domain/notifications purity", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  it("has the module's files", () => {
    expect(files).toEqual(expect.arrayContaining(["events.ts", "render.ts", "address.ts", "index.ts"]));
  });

  it.each(files)("%s imports only the journey glossary or a file of the module", (file) => {
    expect(importsOf(readFileSync(join(DIR, file), "utf8")).filter((s) => !allowed(s))).toEqual([]);
  });

  it.each(files)("%s does not read the clock, the network or the environment", (file) => {
    const code = readFileSync(join(DIR, file), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/Date\.now\(|new Date\(\s*\)|\bfetch\(|process\.env|Math\.random\(/);
  });
});
