// Real local Postgres. The home page offers the demo store only when it exists.
import { describe, expect, it } from "vitest";
import { findDemoStore } from "@/lib/demo-store";
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
