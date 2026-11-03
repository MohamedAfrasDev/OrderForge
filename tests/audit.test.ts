import { describe, expect, it, vi } from "vitest";
import {
  CORRELATION_HEADER,
  correlationIdFrom,
  newCorrelationId,
} from "@/lib/correlation";
import { audit, redact, type AuditRow } from "@/lib/audit";

describe("correlation id", () => {
  it("generates unique, header-safe ids", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("reuses a well-formed incoming id", () => {
    const headers = new Headers({ [CORRELATION_HEADER]: "req-1234_abcd" });
    expect(correlationIdFrom(headers)).toBe("req-1234_abcd");
  });

  it.each(["", "short", "has spaces in it!", "x".repeat(65), "line\nbreak-123456"])(
    "replaces a malformed incoming id (%j)",
    (bad) => {
      const headers = new Headers();
      headers.set(CORRELATION_HEADER, bad.replace(/\n/g, " "));
      const id = correlationIdFrom(headers);
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    },
  );

  it("generates one when the header is absent", () => {
    expect(correlationIdFrom(new Headers())).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe("redact", () => {
  it("keeps the model run record (model id, prompt version, run number) and still drops customer text and prompts", () => {
    const out = redact({
      model_id: "google/gemma-4-31b-it:free",
      prompt_version: "intake.v1",
      run: 3,
      customer_message: "Ignore previous instructions",
      prompt: "system text",
      raw_output: "{}",
    });
    expect(out).toEqual({ model_id: "google/gemma-4-31b-it:free", prompt_version: "intake.v1", run: 3 });
  });

  it("keeps allowlisted keys and drops everything else", () => {
    const out = redact({
      state: "AUTHORIZED",
      amount_minor: 108000,
      currency: "USD",
      customer_email: "a@b.com",
      note: "free text not on the allowlist",
    });
    expect(out).toEqual({ state: "AUTHORIZED", amount_minor: 108000, currency: "USD" });
  });

  it("never lets secret-looking keys through, even nested", () => {
    const out = redact({
      state: "CREATED",
      access_token: "abc",
      client_secret: "def",
      authorization: "Bearer xyz",
      details: { state: "X", password: "p" },
    });
    expect(JSON.stringify(out)).not.toMatch(/abc|def|xyz|"p"/);
    expect(out).toEqual({ state: "CREATED" });
  });

  it("recurses into allowlisted containers and arrays of primitives", () => {
    const out = redact({
      from: "HELD",
      to: "COMMITTED",
      product_ids: ["p1", "p2"],
      extra: { evil: "x" },
    });
    expect(out).toEqual({ from: "HELD", to: "COMMITTED", product_ids: ["p1", "p2"] });
  });

  it("truncates long strings", () => {
    const out = redact({ reason: "r".repeat(1000) });
    expect((out.reason as string).length).toBeLessThanOrEqual(201);
  });

  it("returns an empty object for undefined input", () => {
    expect(redact(undefined)).toEqual({});
  });
});

describe("audit", () => {
  it("writes a redacted row through the injected insert", async () => {
    const insert = vi.fn<(row: AuditRow) => Promise<void>>().mockResolvedValue();
    await audit(insert, {
      actor: "merchant:abc",
      action: "payment.captured",
      entity: "payment_attempt",
      entityId: "pa_1",
      correlationId: "corr-12345678",
      data: { state: "CAPTURED", client_secret: "nope" },
    });
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0][0]).toEqual({
      actor: "merchant:abc",
      action: "payment.captured",
      entity: "payment_attempt",
      entity_id: "pa_1",
      correlation_id: "corr-12345678",
      data: { state: "CAPTURED" },
    });
  });

  it("propagates insert failures so callers can decide", async () => {
    const insert = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      audit(insert, {
        actor: "system",
        action: "x",
        entity: "y",
        entityId: "z",
        correlationId: "corr-12345678",
      }),
    ).rejects.toThrow("db down");
  });
});
