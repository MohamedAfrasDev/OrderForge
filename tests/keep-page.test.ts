import { describe, expect, it } from "vitest";
import { forbiddenIn } from "@/domain/journey";
import { keepLinkMailto } from "@/lib/keep-link";

const LINK = "https://orders.example.com/o/abc.def-ghi_jkl";

function parts(mailto: string) {
  const url = new URL(mailto);
  return { protocol: url.protocol, address: url.pathname, subject: url.searchParams.get("subject") ?? "", body: url.searchParams.get("body") ?? "" };
}

describe("keepLinkMailto: the link to the customer's own order, as an email they send to themselves", () => {
  it("builds a mailto link with no address, so the customer chooses where it goes", () => {
    const m = parts(keepLinkMailto(LINK, "Demo Gift Boxes"));
    expect(m.protocol).toBe("mailto:");
    expect(m.address).toBe("");
  });

  it("puts the link and an honest line in the body, and names the shop in the subject", () => {
    const m = parts(keepLinkMailto(LINK, "Demo Gift Boxes"));
    expect(m.subject).toBe("Your order with Demo Gift Boxes");
    expect(m.body).toContain(LINK);
    expect(m.body).toMatch(/only way back/i);
    expect(m.body).toMatch(/anyone who has/i);
  });

  it("uses only the customer's vocabulary in what it writes", () => {
    const m = parts(keepLinkMailto(LINK, "Demo Gift Boxes"));
    expect(forbiddenIn(m.subject)).toEqual([]);
    expect(forbiddenIn(m.body.replace(LINK, ""))).toEqual([]);
  });

  it("cannot be bent by the shop's name: no new lines, no extra mail headers, a sensible length", () => {
    const m = parts(keepLinkMailto(LINK, "Evil\r\nBcc: someone@example.com\nSubject: hello"));
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(keepLinkMailto(LINK, "Evil\r\nBcc: someone@example.com")).not.toMatch(/%0[AD]Bcc/i);
    const long = parts(keepLinkMailto(LINK, "x".repeat(500)));
    expect(long.subject.length).toBeLessThanOrEqual(120);
  });

  it("keeps the link intact through encoding", () => {
    const tricky = "https://orders.example.com/o/a.b?x=1&y=2#frag";
    expect(parts(keepLinkMailto(tricky, "Shop")).body).toContain(tricky);
  });

  it("does not put the address of anyone in the message", () => {
    expect(keepLinkMailto(LINK, "Shop")).not.toMatch(/@/);
  });
});
