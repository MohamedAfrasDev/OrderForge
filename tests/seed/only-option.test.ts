// `--only=<shop>` on the seed command line. Pure: no database. A typo must never fall back to "seed everything".
import { describe, expect, it } from "vitest";
import { SEED_SLUGS, parseOnly } from "../../scripts/lib.ts";

describe("parseOnly", () => {
  it("is undefined when the option is absent, so every shop is seeded as before", () => {
    expect(parseOnly([])).toBeUndefined();
    expect(parseOnly(["node", "seed.ts", "--confirm-host=x.supabase.co"])).toBeUndefined();
  });

  it("returns the shop named", () => {
    expect(parseOnly(["--only=demo-event-kits"])).toBe("demo-event-kits");
    expect(parseOnly(["node", "seed.ts", "--confirm-host=x.supabase.co", "--only=demo-gift-boxes"])).toBe("demo-gift-boxes");
  });

  it("knows exactly the demo shops the seed creates", () => {
    expect(SEED_SLUGS).toEqual(["demo-gift-boxes", "demo-event-kits"]);
  });

  it.each(["--only=nope", "--only=", "--only", "--only=Demo-Event-Kits", "--only=demo-event-kits ", "--only=constructor", "--only=demo-event-kits,demo-gift-boxes", "--only==demo-event-kits"])(
    "refuses %s with a message that lists the valid shops",
    (arg) => {
      expect(() => parseOnly([arg])).toThrow(/--only must name a demo shop: one of demo-gift-boxes, demo-event-kits/);
    },
  );

  it("refuses the option given twice, even with the same value", () => {
    expect(() => parseOnly(["--only=demo-event-kits", "--only=demo-event-kits"])).toThrow(/once/);
    expect(() => parseOnly(["--only=demo-event-kits", "--only=demo-gift-boxes"])).toThrow(/once/);
  });

  it("does not mistake a different option that starts with the same letters", () => {
    expect(parseOnly(["--only-seed-nothing"])).toBeUndefined();
  });
});
