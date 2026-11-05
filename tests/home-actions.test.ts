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
});
