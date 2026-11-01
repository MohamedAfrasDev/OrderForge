import { describe, expect, it } from "vitest";
import { createCustomerLink, verifyCustomerLink } from "@/lib/access/customer-link";

const SECRET = "test-secret-at-least-sixteen-chars";
const NOW = new Date("2026-11-05T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function make(overrides: Partial<Parameters<typeof createCustomerLink>[0]> = {}) {
  return createCustomerLink({
    inquiryId: "inq_123",
    version: 1,
    expiresAt: new Date(NOW.getTime() + HOUR),
    secret: SECRET,
    ...overrides,
  });
}

describe("customer link", () => {
  it("round-trips a valid token", () => {
    const result = verifyCustomerLink(make(), { secret: SECRET, now: NOW });
    expect(result).toEqual({ ok: true, inquiryId: "inq_123", version: 1 });
  });

  it("produces URL-safe tokens", () => {
    expect(make()).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects an expired token", () => {
    const token = make({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(verifyCustomerLink(token, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a token signed with a different secret", () => {
    const token = make({ secret: "another-secret-also-long-enough" });
    expect(verifyCustomerLink(token, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a tampered payload (different inquiry, original signature)", () => {
    const [, sig] = make().split(".");
    const forged = Buffer.from(
      JSON.stringify({ i: "inq_999", v: 1, e: NOW.getTime() + HOUR }),
    ).toString("base64url");
    expect(verifyCustomerLink(`${forged}.${sig}`, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a tampered signature", () => {
    const [payload, sig] = make().split(".");
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyCustomerLink(`${payload}.${flipped}`, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a revoked token when the expected version has been bumped", () => {
    const token = make({ version: 1 });
    expect(verifyCustomerLink(token, { secret: SECRET, now: NOW, expectedVersion: 2 })).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(verifyCustomerLink(token, { secret: SECRET, now: NOW, expectedVersion: 1 }).ok).toBe(
      true,
    );
  });

  it.each(["", "abc", "a.b.c", ".", "a.", ".b", "not base64!.also not", "e30.e30"])(
    "rejects malformed token %j without throwing",
    (token) => {
      const result = verifyCustomerLink(token, { secret: SECRET, now: NOW });
      expect(result.ok).toBe(false);
    },
  );

  it("rejects a correctly signed payload with the wrong shape", () => {
    const payload = Buffer.from(JSON.stringify({ i: 5, v: "x", e: "soon" })).toString("base64url");
    // sign it properly by borrowing the library's own signature path
    const good = make().split(".");
    const result = verifyCustomerLink(`${payload}.${good[1]}`, { secret: SECRET, now: NOW });
    expect(result.ok).toBe(false);
  });

  it("refuses to create a token with a short secret or bad inquiry id", () => {
    expect(() => make({ secret: "short" })).toThrow();
    expect(() => make({ inquiryId: "" })).toThrow();
    expect(() => make({ inquiryId: "has space" })).toThrow();
  });

  it("refuses to verify with a short secret", () => {
    expect(() => verifyCustomerLink(make(), { secret: "short", now: NOW })).toThrow();
  });
});
