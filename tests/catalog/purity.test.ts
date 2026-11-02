import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "domain", "catalog");

/** Module specifiers named by import/export-from, dynamic import() and require(). */
export function importsOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s[^"'`;]*?\sfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) found.push(m[1]!);
  return found;
}

/** The only things domain/catalog may import: lib/money, zod, or another file of the module. */
export function isAllowedImport(specifier: string): boolean {
  return specifier === "@/lib/money" || specifier === "zod" || /^\.\/[\w-]+$/.test(specifier);
}

describe("import scanner", () => {
  it("finds every import form", () => {
    const src = [
      `import { a } from "zod";`,
      `import type { B } from './types';`,
      `export * from "./price";`,
      `export { c } from "next/server";`,
      `import "server-only";`,
      `const x = await import("node:fs");`,
      `const y = require("@supabase/supabase-js");`,
    ].join("\n");
    expect(importsOf(src)).toEqual(
      expect.arrayContaining(["zod", "./types", "./price", "next/server", "server-only", "node:fs", "@supabase/supabase-js"]),
    );
  });

  it("allows only lib/money, zod and sibling files", () => {
    for (const ok of ["@/lib/money", "zod", "./types", "./model-view"]) expect(isAllowedImport(ok)).toBe(true);
    for (const bad of ["next/server", "@supabase/supabase-js", "node:fs", "fs", "server-only", "@/lib/env", "../lib/money", "./nested/x", "https://example.com/x.js"]) {
      expect(isAllowedImport(bad), bad).toBe(false);
    }
  });
});

describe("domain/catalog purity", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  it("has the module's files", () => {
    expect(files).toEqual(expect.arrayContaining(["types.ts", "validate.ts", "price.ts", "alternatives.ts", "model-view.ts", "index.ts"]));
  });

  it.each(files)("%s imports nothing outside lib/money, zod or the module", (file) => {
    const bad = importsOf(readFileSync(join(DIR, file), "utf8")).filter((s) => !isAllowedImport(s));
    expect(bad).toEqual([]);
  });

  it.each(files)("%s does not read the clock, the network or the environment", (file) => {
    const code = readFileSync(join(DIR, file), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/Date\.now\(|new Date\(\s*\)|\bfetch\(|process\.env|Math\.random\(/);
  });
});
