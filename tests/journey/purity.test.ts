import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importsOf } from "../catalog/purity.test";

const DIR = join(process.cwd(), "domain", "journey");

/** domain/journey may import: the intake domain (for the inquiry status type), zod, or a sibling file. */
export function isAllowedImport(specifier: string): boolean {
  return specifier === "zod" || specifier === "@/domain/intake" || /^\.\/[\w-]+$/.test(specifier);
}

describe("import allowlist", () => {
  it("allows only the intake domain, zod and sibling files", () => {
    for (const ok of ["@/domain/intake", "zod", "./journey", "./wording"]) expect(isAllowedImport(ok), ok).toBe(true);
    for (const bad of ["@/domain/payments", "@/domain/quote", "@/domain/fulfillment", "@/lib/money", "@/services/payments/read", "@/domain/intake/types", "node:fs", "next/server", "@supabase/supabase-js", "../intake/types", "server-only"]) {
      expect(isAllowedImport(bad), bad).toBe(false);
    }
  });
});

describe("domain/journey purity", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s imports only what the spec allows", (file) => {
    const bad = importsOf(readFileSync(join(DIR, file), "utf8")).filter((s) => !isAllowedImport(s));
    expect(bad, `${file} imports ${bad.join(", ")}`).toEqual([]);
  });

  it.each(files)("%s does not read the clock or the environment", (file) => {
    const code = readFileSync(join(DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bDate\.now\s*\(/);
    expect(code).not.toMatch(/new Date\s*\(\s*\)/);
    expect(code).not.toMatch(/\bprocess\.env\b/);
    expect(code).not.toMatch(/\bMath\.random\s*\(/);
  });
});
