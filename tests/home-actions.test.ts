import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { forbiddenIn } from "@/domain/journey";
import { HomeActions } from "@/app/home-actions";

const html = (store: { slug: string; name: string } | null) => renderToStaticMarkup(createElement(HomeActions, { store }));
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the home page's actions", () => {
  it("offers the customer flow first when the demo store exists, and shop sign in second", () => {
    const markup = html({ slug: "demo-gift-boxes", name: "Demo Gift Boxes" });
    expect(markup).toContain('href="/store/demo-gift-boxes"');
    expect(markup).toContain("Try it as a customer");
    expect(markup).toContain('href="/merchant"');
    expect(markup).toContain("Shop sign in");
    expect(markup.indexOf("Try it as a customer")).toBeLessThan(markup.indexOf("Shop sign in"));
  });

  it("shows no customer link at all when there is no demo store (no dead link), and says so", () => {
    const markup = html(null);
    expect(markup).not.toContain("Try it as a customer");
    expect(markup).not.toContain("/store/");
    expect(markup).toContain("Shop sign in");
    expect(textOf(markup)).toMatch(/no store is open for orders/i);
  });

  it("does not trust the store's name in a link", () => {
    expect(html({ slug: "demo-gift-boxes", name: '"><script>alert(1)</script>' })).not.toContain("<script>");
  });

  it("uses the customer's vocabulary", () => {
    for (const store of [{ slug: "demo-gift-boxes", name: "Demo" }, null]) expect(forbiddenIn(textOf(html(store)))).toEqual([]);
  });

  describe("with more than one demo store", () => {
    const first = { slug: "demo-gift-boxes", name: "Demo Gift Boxes (simulated)" };
    const second = { slug: "demo-event-kits", name: "Demo Event Kits (simulated)" };
    const htmlWith = (store: { slug: string; name: string } | null, others: Array<{ slug: string; name: string }>) =>
      renderToStaticMarkup(createElement(HomeActions, { store, others }));

    it("keeps one main action, the first store, and offers the others by name as quieter links", () => {
      const markup = htmlWith(first, [second]);
      expect((markup.match(/Try it as a customer/g) ?? []).length).toBe(1);
      expect(markup).toContain('href="/store/demo-gift-boxes"');
      expect(markup).toContain('href="/store/demo-event-kits"');
      expect(textOf(markup)).toContain("Demo Event Kits (simulated)");
      expect(markup.indexOf("/store/demo-gift-boxes")).toBeLessThan(markup.indexOf("/store/demo-event-kits"));
      expect(markup.indexOf("Shop sign in")).toBeGreaterThan(markup.indexOf("Try it as a customer"));
    });

    it("says the stores are demos with simulated data", () => {
      expect(textOf(htmlWith(first, [second]))).toMatch(/simulated/i);
    });

    it("shows no link to a store that is not given (no dead link)", () => {
      expect(htmlWith(first, [])).not.toContain("demo-event-kits");
    });

    it("never puts a store's name in a link or lets it inject markup", () => {
      const markup = htmlWith(first, [{ slug: "demo-event-kits", name: '"><script>alert(1)</script>' }]);
      expect(markup).not.toContain("<script>");
    });

    it("uses the customer's vocabulary", () => {
      expect(forbiddenIn(textOf(htmlWith(first, [second])))).toEqual([]);
    });
  });
});
