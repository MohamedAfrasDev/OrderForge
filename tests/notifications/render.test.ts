import { describe, expect, it } from "vitest";
import { forbiddenIn } from "@/domain/journey";
import { ALL_KINDS, escapeHtml, recipientOf, render, type RenderData } from "@/domain/notifications";

// A link as long and odd as a real one, so the scan below proves it is the words that are clean, not that the link was short.
const LINK = "https://orderforge.example/o/eyJpIjoiNTBhYjEyMzQiLCJ2IjoxLCJlIjoxNzk0MDAwMDAwMDAwfQ.q3Zr8W_aX-0pLmN";
const data: RenderData = { shopName: "Demo Gift Boxes (simulated)", link: LINK, totalText: "$1,080.00", boxCount: 30 };
const withoutLink = (text: string) => text.split(LINK).join("the link");

describe("render", () => {
  for (const kind of ALL_KINDS) {
    describe(kind, () => {
      const email = render(kind, data);

      it("says it is a sandbox demo, in the subject and the body", () => {
        expect(email.subject).toContain("sandbox demo");
        expect(email.text).toContain("This is a sandbox demo: no real money moves.");
        expect(email.html).toContain("This is a sandbox demo: no real money moves.");
      });

      it("is in the customer's words: no raw state, code, id, SKU or forbidden word anywhere", () => {
        for (const part of [email.subject, withoutLink(email.text)]) expect(forbiddenIn(part), part).toEqual([]);
      });

      it("carries the link in the text and in the HTML, and no tracking", () => {
        expect(email.text).toContain(LINK);
        expect(email.html).toContain(`href="${LINK}"`);
        expect(email.html).not.toMatch(/<img|<script|<style|<iframe|pixel|utm_/i);
      });

      it("explains why the person got it", () => {
        expect(email.text).toMatch(recipientOf(kind) === "customer" ? /gave this address when you started/ : /you run this shop/);
      });

      it("has a plain text twin of the same sentences as the HTML", () => {
        const sentences = email.text.split("\n").filter((l) => l && !l.includes(LINK) && !l.startsWith("This is a sandbox") && !l.startsWith("You're getting this"));
        for (const line of sentences) expect(email.html).toContain(escapeHtml(line));
      });
    });
  }

  it("uses the amounts and counts it is given, and works without them", () => {
    expect(render("price_ready", data).text).toContain("$1,080.00 for 30 boxes");
    expect(render("price_ready", { shopName: "S", link: LINK }).text).toContain("S prepared your price.");
    expect(render("order_accepted", data).text).toContain("PayPal took $1,080.00");
    expect(render("order_awaiting_ok", data).text).toContain("$1,080.00");
    expect(render("price_ready", { ...data, boxCount: 1 }).text).toContain("for 1 box.");
  });

  it("escapes every inserted value in the HTML and leaves the plain text as written", () => {
    const hostile: RenderData = { shopName: `<script>alert("x")</script> & Co`, link: `https://x.test/o/a"onmouseover="y`, totalText: "<b>$1</b>", boxCount: 2 };
    for (const kind of ALL_KINDS) {
      const email = render(kind, hostile);
      expect(email.html, kind).not.toContain("<script>");
      expect(email.html, kind).not.toContain("<b>");
      expect(email.html, kind).not.toContain(`"onmouseover="`);
      expect(email.html, kind).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
    }
    expect(render("shop_replied", hostile).text).toContain("<script>");
  });

  it("escapeHtml escapes the five characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("shop emails say what to do and link to the shop's own pages, without a customer's words", () => {
    const handed = render("request_handed_over", { shopName: "S", link: "https://orderforge.example/merchant/inquiries" });
    expect(handed.subject).toContain("A customer needs a reply");
    expect(handed.text).toContain("https://orderforge.example/merchant/inquiries");
    const ok = render("order_awaiting_ok", { shopName: "S", link: "https://orderforge.example/merchant/decisions", totalText: "$40.00" });
    expect(ok.text).toContain("Accept it to take the payment, or decline it to release the hold.");
  });
});
