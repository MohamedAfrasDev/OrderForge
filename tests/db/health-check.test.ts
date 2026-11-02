// Evidence label: real Postgres (local Supabase) through PostgREST.
import { describe, expect, it } from "vitest";
import { canReadTable } from "@/lib/health-checks";
import { anonClient, serviceClient } from "./helpers";

describe("canReadTable (the health check's database probe)", () => {
  it("is true for a table that exists", async () => {
    expect(await canReadTable(serviceClient(), "merchants")).toBe(true);
  });

  it("is FALSE for a table that does not exist (a HEAD-based probe wrongly said true)", async () => {
    expect(await canReadTable(serviceClient(), "no_such_table_zz")).toBe(false);
  });

  it("is false when the caller is not allowed to read (anon has no table privileges)", async () => {
    expect(await canReadTable(anonClient(), "merchants")).toBe(false);
  });

  it("defaults to checking the merchants table", async () => {
    expect(await canReadTable(serviceClient())).toBe(true);
  });
});
