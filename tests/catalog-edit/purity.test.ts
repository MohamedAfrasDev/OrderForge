import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importsOf } from "../catalog/purity.test";

const DIR = join(process.cwd(), "domain", "catalog-edit");
const allowed = (s: string) => s === "zod" || /^\.\/[\w-]+$/.test(s);

describe("domain/catalog-edit purity", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  it("has the module's files", () => {
    expect(files).toEqual(expect.arrayContaining(["schemas.ts", "rules.ts", "index.ts"]));
  });

  it.each(files)("%s imports only zod or a file of the module", (file) => {
    expect(importsOf(readFileSync(join(DIR, file), "utf8")).filter((s) => !allowed(s))).toEqual([]);
  });

  it.each(files)("%s does not read the clock, the network or the environment", (file) => {
    const code = readFileSync(join(DIR, file), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/Date\.now\(|new Date\(\s*\)|\bfetch\(|process\.env|Math\.random\(/);
  });
});
