import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importsOf } from "../catalog/purity.test";

const DIR = join(process.cwd(), "domain", "fulfillment");

/** domain/fulfillment may import: domain/catalog, domain/quote and domain/reservation (index or one file), lib/money, zod, or a sibling file. */
export function isAllowedImport(specifier: string): boolean {
  return (
    specifier === "@/lib/money" ||
    specifier === "zod" ||
    /^@\/domain\/(catalog|quote|reservation)(\/[\w-]+)?$/.test(specifier) ||
    /^\.\/[\w-]+$/.test(specifier)
  );
}

describe("import allowlist", () => {
  it("allows only domain/catalog, domain/quote, domain/reservation, lib/money, zod and sibling files", () => {
    for (const ok of ["@/lib/money", "zod", "@/domain/quote", "@/domain/catalog/types", "@/domain/reservation", "./types", "./state"]) {
      expect(isAllowedImport(ok), ok).toBe(true);
    }
    for (const bad of ["@/domain/payments", "@/lib/paypal/types", "@/lib/hash", "node:crypto", "next/server", "@supabase/supabase-js", "@/services/fulfillment/create", "@/domain/quote/../x", "../quote/types", "server-only"]) {
      expect(isAllowedImport(bad), bad).toBe(false);
    }
  });
});

describe("domain/fulfillment purity", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s imports only what the spec allows", (file) => {
    const source = readFileSync(join(DIR, file), "utf8");
    const bad = importsOf(source).filter((s) => !isAllowedImport(s));
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
