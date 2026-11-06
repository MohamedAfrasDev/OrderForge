// The request token: signed, expiring, read-only, under its own key. A customer link is not valid as one and the reverse.
import { describe, expect, it } from "vitest";
import { createCustomerLink, verifyCustomerLink } from "@/lib/access/customer-link";
import { createAgentToken, verifyAgentToken } from "@/lib/access/agent-token";

const SECRET = "agent-token-test-secret-long-enough";
const ID = "5b0e6a3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const NOW = new Date("2026-11-06T10:00:00Z");
const LATER = new Date("2026-11-20T10:00:00Z");

describe("the agent request token", () => {
  it("round-trips for the right request and version", () => {
    const t = createAgentToken({ requestId: ID, version: 1, expiresAt: LATER, secret: SECRET });
    expect(verifyAgentToken(t, { secret: SECRET, now: NOW })).toEqual({ ok: true, requestId: ID, version: 1 });
  });

  it("is refused after it expires", () => {
    const t = createAgentToken({ requestId: ID, version: 1, expiresAt: NOW, secret: SECRET });
    expect(verifyAgentToken(t, { secret: SECRET, now: new Date(NOW.getTime() + 1) })).toEqual({ ok: false, reason: "expired" });
  });

  it("is refused with another secret, a changed signature, a changed payload and garbage", () => {
    const t = createAgentToken({ requestId: ID, version: 1, expiresAt: LATER, secret: SECRET });
    expect(verifyAgentToken(t, { secret: "another-secret-long-enough-0000", now: NOW }).ok).toBe(false);
    const [payload, sig] = t.split(".");
    expect(verifyAgentToken(`${payload}.${sig!.slice(0, -2)}AA`, { secret: SECRET, now: NOW }).ok).toBe(false);
    const forged = Buffer.from(JSON.stringify({ i: "00000000-0000-4000-8000-000000000000", v: 1, e: LATER.getTime(), k: "agent" })).toString("base64url");
    expect(verifyAgentToken(`${forged}.${sig}`, { secret: SECRET, now: NOW }).ok).toBe(false);
    for (const junk of ["", "x", "a.b.c", ".", "not a token"]) expect(verifyAgentToken(junk, { secret: SECRET, now: NOW }).ok, junk).toBe(false);
  });

  it("is not a customer link: a customer link is refused as an agent token, and an agent token is refused as a customer link", () => {
    const link = createCustomerLink({ inquiryId: ID, version: 1, expiresAt: LATER, secret: SECRET });
    const agent = createAgentToken({ requestId: ID, version: 1, expiresAt: LATER, secret: SECRET });
    expect(verifyAgentToken(link, { secret: SECRET, now: NOW }).ok).toBe(false);
    expect(verifyCustomerLink(agent, { secret: SECRET, now: NOW }).ok).toBe(false);
  });

  it("carries the access version, so revoking the request revokes it", () => {
    const t = createAgentToken({ requestId: ID, version: 2, expiresAt: LATER, secret: SECRET });
    expect(verifyAgentToken(t, { secret: SECRET, now: NOW, expectedVersion: 2 }).ok).toBe(true);
    expect(verifyAgentToken(t, { secret: SECRET, now: NOW, expectedVersion: 3 })).toEqual({ ok: false, reason: "revoked" });
  });

  it("refuses a short secret and a bad id when making one", () => {
    expect(() => createAgentToken({ requestId: ID, version: 1, expiresAt: LATER, secret: "short" })).toThrow();
    expect(() => createAgentToken({ requestId: "../x", version: 1, expiresAt: LATER, secret: SECRET })).toThrow();
  });
});
