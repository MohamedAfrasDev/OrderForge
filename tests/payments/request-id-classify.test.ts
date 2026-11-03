import { describe, expect, it } from "vitest";
import { classifyPayPal } from "@/domain/payments/classify";
import { requestId } from "@/domain/payments/request-id";
import type { PayPalResult } from "@/lib/paypal/types";

const ATTEMPT = "5b1f0f0e-6c0b-4f6e-9c58-0f3a3f1d2a11";

describe("requestId", () => {
  it("is stable: the same attempt and operation always give the same id", () => {
    expect(requestId(ATTEMPT, "capture")).toBe(`of-${ATTEMPT}-capture`);
    expect(requestId(ATTEMPT, "capture")).toBe(requestId(ATTEMPT, "capture"));
  });

  it("differs per operation and per attempt, so PayPal cannot mistake one operation for another", () => {
    const ids = (["create", "authorize", "capture", "void"] as const).map((op) => requestId(ATTEMPT, op));
    expect(new Set(ids).size).toBe(4);
    expect(requestId("00000000-0000-4000-8000-000000000000", "capture")).not.toBe(requestId(ATTEMPT, "capture"));
  });

  it("is printable ASCII within PayPal's limits", () => {
    for (const op of ["create", "authorize", "capture", "void"] as const) {
      expect(requestId(ATTEMPT, op)).toMatch(/^[\x20-\x7E]{1,10000}$/);
    }
  });

  it.each([
    ["not a uuid", "not-an-attempt"],
    ["empty", ""],
    ["with a newline", `${ATTEMPT}\n`],
    ["with a space", `${ATTEMPT} x`],
  ])("refuses an attempt id that is %s", (_n, id) => {
    expect(() => requestId(id, "capture")).toThrow();
  });

  it("refuses an unknown operation", () => {
    expect(() => requestId(ATTEMPT, "refund" as never)).toThrow();
  });
});

describe("classifyPayPal", () => {
  const ok = { kind: "ok" } as const;
  const providerError = (status: number) => ({ kind: "provider_error", status }) as const;

  it.each(["authorize", "capture", "void", "create"] as const)("an ok answer is DONE for %s", (op) => {
    expect(classifyPayPal(ok, op)).toBe("DONE");
  });

  it.each(["authorize", "capture", "void"] as const)("a request that never left (no access token) is NOT_SENT for %s: safe to retry", (op) => {
    expect(classifyPayPal({ kind: "not_sent" }, op)).toBe("NOT_SENT");
  });

  it.each(["authorize", "capture", "void"] as const)("a timeout is UNKNOWN for %s: the request may have been processed", (op) => {
    expect(classifyPayPal({ kind: "timeout" }, op)).toBe("UNKNOWN");
  });

  it.each(["authorize", "capture", "void"] as const)("an unreadable 2xx body is UNKNOWN for %s: it may have taken effect", (op) => {
    expect(classifyPayPal({ kind: "malformed" }, op)).toBe("UNKNOWN");
  });

  it.each([400, 401, 403, 404, 409, 422])("a %s from PayPal is a definitive failure of that call (for example a 422 PREVIOUSLY_CAPTURED)", (status) => {
    for (const op of ["authorize", "capture", "void", "create"] as const) expect(classifyPayPal(providerError(status), op)).toBe("DEFINITIVE_FAILURE");
  });

  it.each([500, 502, 503, 504])("a %s from PayPal is UNKNOWN: a server error does not prove nothing happened", (status) => {
    for (const op of ["authorize", "capture", "void"] as const) expect(classifyPayPal(providerError(status), op)).toBe("UNKNOWN");
  });

  it("408 (request timeout) is UNKNOWN and 429 (rate limited, rejected before processing) is NOT_SENT", () => {
    expect(classifyPayPal(providerError(408), "capture")).toBe("UNKNOWN");
    expect(classifyPayPal(providerError(429), "capture")).toBe("NOT_SENT");
  });

  it("creating an order moves no money and is idempotent by request id, so an uncertain create is safe to retry", () => {
    expect(classifyPayPal({ kind: "timeout" }, "create")).toBe("NOT_SENT");
    expect(classifyPayPal({ kind: "malformed" }, "create")).toBe("NOT_SENT");
    expect(classifyPayPal(providerError(503), "create")).toBe("NOT_SENT");
    expect(classifyPayPal(providerError(422), "create")).toBe("DEFINITIVE_FAILURE");
  });

  it("accepts the PayPal client's own result type", () => {
    const refused: PayPalResult<{ id: string }> = { kind: "provider_error", status: 422, errorName: "UNPROCESSABLE_ENTITY", issues: ["PREVIOUSLY_CAPTURED"] };
    const answered: PayPalResult<{ id: string }> = { kind: "ok", data: { id: "x" } };
    const lost: PayPalResult<{ id: string }> = { kind: "timeout", cause: "timeout" };
    expect(classifyPayPal(refused, "void")).toBe("DEFINITIVE_FAILURE");
    expect(classifyPayPal(answered, "capture")).toBe("DONE");
    expect(classifyPayPal(lost, "capture")).toBe("UNKNOWN");
  });
});
