import { describe, expect, it } from "vitest";
import { expectedPayment, unconfirmedConditions, verifyAuthorization, verifyCapture } from "@/domain/payments/verify";
import type { Condition } from "@/domain/quote";

const attempt = {
  amountMinor: 108000,
  currency: "USD" as const,
  paypalOrderId: "ORDER-1",
  authorizationId: "AUTH-1",
};

const goodAuthorization = { orderId: "ORDER-1", authorizationId: "AUTH-1", authorizationStatus: "CREATED", amountMinor: 108000, currency: "USD" };
const goodOrder = { id: "ORDER-1", authorizationId: "AUTH-1", captureId: "CAP-1" };
const goodCapture = { captureId: "CAP-1", status: "COMPLETED", amountMinor: 108000, currency: "USD" };

describe("expectedPayment", () => {
  it("is the accepted snapshot's total and currency, and nothing else", () => {
    expect(expectedPayment({ totalMinor: 108000, currency: "USD" } as never)).toEqual({ amountMinor: 108000, currency: "USD" });
  });

  it("refuses a snapshot whose total is not a positive integer", () => {
    for (const totalMinor of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => expectedPayment({ totalMinor, currency: "USD" } as never), String(totalMinor)).toThrow();
    }
  });
});

describe("verifyAuthorization", () => {
  it("accepts an authorization that matches the attempt exactly", () => {
    expect(verifyAuthorization(attempt, goodAuthorization)).toEqual({ ok: true });
  });

  it.each([
    ["a different order", { orderId: "ORDER-2" }, "ORDER_MISMATCH"],
    ["a status other than CREATED", { authorizationStatus: "PENDING" }, "STATUS_NOT_AS_EXPECTED"],
    ["an already-captured authorization", { authorizationStatus: "CAPTURED" }, "STATUS_NOT_AS_EXPECTED"],
    ["a different currency", { currency: "EUR" }, "CURRENCY_MISMATCH"],
    ["a lower amount", { amountMinor: 107999 }, "AMOUNT_MISMATCH"],
    ["a higher amount", { amountMinor: 108001 }, "AMOUNT_MISMATCH"],
    ["a missing amount", { amountMinor: undefined }, "EVIDENCE_MISSING"],
    ["a missing currency", { currency: undefined }, "EVIDENCE_MISSING"],
  ])("is a financial exception for %s", (_name, patch, reason) => {
    const result = verifyAuthorization(attempt, { ...goodAuthorization, ...patch });
    expect(result).toMatchObject({ ok: false, exception: reason });
  });

  it("reports every problem at once, in a fixed order", () => {
    const result = verifyAuthorization(attempt, { orderId: "X", authorizationId: "AUTH-1", authorizationStatus: "PENDING", amountMinor: 1, currency: "EUR" });
    expect(result).toEqual({ ok: false, exception: "ORDER_MISMATCH", reasons: ["ORDER_MISMATCH", "STATUS_NOT_AS_EXPECTED", "CURRENCY_MISMATCH", "AMOUNT_MISMATCH"] });
  });

  it("an attempt with no recorded order cannot be verified", () => {
    expect(verifyAuthorization({ ...attempt, paypalOrderId: null }, goodAuthorization)).toMatchObject({ ok: false, exception: "ORDER_MISMATCH" });
  });
});

describe("verifyCapture", () => {
  it("accepts a completed capture that matches the attempt, its order and its authorization", () => {
    expect(verifyCapture(attempt, goodOrder, goodCapture)).toEqual({ ok: true });
  });

  it.each([
    ["a pending capture", { status: "PENDING" }, {}, "STATUS_NOT_AS_EXPECTED"],
    ["a declined capture", { status: "DECLINED" }, {}, "STATUS_NOT_AS_EXPECTED"],
    ["a partial capture", { amountMinor: 50000 }, {}, "AMOUNT_MISMATCH"],
    ["an over-capture", { amountMinor: 108001 }, {}, "AMOUNT_MISMATCH"],
    ["a different currency", { currency: "GBP" }, {}, "CURRENCY_MISMATCH"],
    ["a missing amount", { amountMinor: undefined }, {}, "EVIDENCE_MISSING"],
    ["a capture that is not the order's capture", { captureId: "CAP-9" }, {}, "ORDER_MISMATCH"],
    ["an order that is not the attempt's", {}, { id: "ORDER-9" }, "ORDER_MISMATCH"],
    ["an authorization that is not the attempt's", {}, { authorizationId: "AUTH-9" }, "AUTHORIZATION_MISMATCH"],
    ["an order with no authorization", {}, { authorizationId: undefined }, "AUTHORIZATION_MISMATCH"],
  ])("is a financial exception for %s", (_name, capturePatch, orderPatch, reason) => {
    const result = verifyCapture(attempt, { ...goodOrder, ...orderPatch }, { ...goodCapture, ...capturePatch });
    expect(result).toMatchObject({ ok: false, exception: reason });
  });

  describe("the payee, when one is configured", () => {
    it("accepts the configured merchant", () => {
      expect(verifyCapture(attempt, goodOrder, goodCapture, { expected: "MERCHANT-1", actual: "MERCHANT-1" })).toEqual({ ok: true });
    });

    it("is a financial exception for another merchant", () => {
      expect(verifyCapture(attempt, goodOrder, goodCapture, { expected: "MERCHANT-1", actual: "MERCHANT-2" })).toMatchObject({ ok: false, exception: "PAYEE_MISMATCH" });
    });

    it("cannot be verified when PayPal did not say who was paid", () => {
      expect(verifyCapture(attempt, goodOrder, goodCapture, { expected: "MERCHANT-1", actual: null })).toMatchObject({ ok: false, exception: "EVIDENCE_MISSING" });
    });

    it("is skipped when no payee is configured", () => {
      expect(verifyCapture(attempt, goodOrder, goodCapture, { actual: "ANYONE" })).toEqual({ ok: true });
      expect(verifyCapture(attempt, goodOrder, goodCapture, undefined)).toEqual({ ok: true });
    });
  });
});

describe("unconfirmedConditions", () => {
  const slot: Condition = { code: "PRODUCTION_SLOT_CONFIRMATION", text: "Slot pending." };
  const art: Condition = { code: "ARTWORK_ACCEPTANCE", text: "Artwork pending." };
  const approved: Condition = { code: "MERCHANT_APPROVED_CUSTOMIZATION", text: "Foil lid approved." };

  it("nothing blocks a quote with no conditions", () => {
    expect(unconfirmedConditions([], [])).toEqual([]);
  });

  it("the two pending conditions must be confirmed, in the quote's order", () => {
    expect(unconfirmedConditions([art, slot], [])).toEqual(["ARTWORK_ACCEPTANCE", "PRODUCTION_SLOT_CONFIRMATION"]);
    expect(unconfirmedConditions([art, slot], ["PRODUCTION_SLOT_CONFIRMATION"])).toEqual(["ARTWORK_ACCEPTANCE"]);
    expect(unconfirmedConditions([art, slot], ["ARTWORK_ACCEPTANCE", "PRODUCTION_SLOT_CONFIRMATION"])).toEqual([]);
  });

  it("a condition the merchant already approved in their own words needs no further confirmation", () => {
    expect(unconfirmedConditions([approved], [])).toEqual([]);
  });

  it("ignores confirmations of things the quote does not have, and does not mutate its input", () => {
    const conditions = [slot];
    const copy = structuredClone(conditions);
    expect(unconfirmedConditions(conditions, ["SOMETHING_ELSE", "ARTWORK_ACCEPTANCE"])).toEqual(["PRODUCTION_SLOT_CONFIRMATION"]);
    expect(conditions).toEqual(copy);
  });

  it("reports a repeated condition once", () => {
    expect(unconfirmedConditions([slot, { ...slot, text: "again" }], [])).toEqual(["PRODUCTION_SLOT_CONFIRMATION"]);
  });
});
