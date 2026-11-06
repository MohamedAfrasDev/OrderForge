// Real local Postgres. The home page offers the demo store only when it exists.
import { describe, expect, it } from "vitest";
import { findDemoStore, findDemoStores } from "@/lib/demo-store";
import { must, serviceClient, unique } from "./helpers";

const db = serviceClient();

describe("findDemoStore", () => {
  it("returns the store's public name and address when it exists", async () => {
    const slug = unique("demo").toLowerCase();
    must(await db.from("merchants").insert({ slug, name: "A demo shop" }).select("id").single());
    expect(await findDemoStore(db, slug)).toEqual({ slug, name: "A demo shop" });
  });

  it("returns null when it does not, so the home page shows no dead link", async () => {
    expect(await findDemoStore(db, unique("absent").toLowerCase())).toBeNull();
  });

  it("returns only public fields", async () => {
    const slug = unique("demo").toLowerCase();
    must(await db.from("merchants").insert({ slug, name: "Another shop" }).select("id").single());
    expect(Object.keys((await findDemoStore(db, slug))!).sort()).toEqual(["name", "slug"]);
  });
});

describe("findDemoStores", () => {
  it("returns the stores that exist, in the order asked, with public fields only", async () => {
    const a = unique("demo-a").toLowerCase();
    const b = unique("demo-b").toLowerCase();
    must(await db.from("merchants").insert([{ slug: b, name: "Second shop" }, { slug: a, name: "First shop" }]).select("id"));
    const found = await findDemoStores(db, [a, b]);
    expect(found).toEqual([{ slug: a, name: "First shop" }, { slug: b, name: "Second shop" }]);
    expect(Object.keys(found[0]!).sort()).toEqual(["name", "slug"]);
  });

  it("leaves out a store that does not exist, so the home page shows no dead link", async () => {
    const a = unique("demo-a").toLowerCase();
    must(await db.from("merchants").insert({ slug: a, name: "Only shop" }).select("id").single());
    expect(await findDemoStores(db, [unique("absent").toLowerCase(), a])).toEqual([{ slug: a, name: "Only shop" }]);
  });

  it("returns an empty list when none exist", async () => {
    expect(await findDemoStores(db, [unique("absent").toLowerCase()])).toEqual([]);
  });

  it("ignores an address that is not a valid store address", async () => {
    expect(await findDemoStores(db, ["Not Valid!", "x".repeat(80)])).toEqual([]);
  });
});
