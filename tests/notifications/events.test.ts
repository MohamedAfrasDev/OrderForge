import { describe, expect, it } from "vitest";
import { ALL_KINDS, eventsToQueue, parseOptionalEmail, recipientOf, type RequestState } from "@/domain/notifications";

const base: RequestState = { inquiryId: "inq-1", hasCustomerEmail: true, withShop: false, publishedQuoteIds: [], shopMessageIds: [], purchases: [] };
const keys = (s: RequestState) => eventsToQueue(s).map((e) => e.dedupeKey);

describe("eventsToQueue", () => {
  it("a new request with an address calls for the saved-link email and nothing else", () => {
    expect(eventsToQueue(base)).toEqual([{ kind: "request_started", recipient: "customer", dedupeKey: "request_started:inq-1" }]);
  });

  it("a request with no address calls for no customer email at all, at any stage", () => {
    const full: RequestState = {
      ...base,
      hasCustomerEmail: false,
      withShop: true,
      publishedQuoteIds: ["q1"],
      shopMessageIds: ["m1"],
      purchases: [{ purchaseId: "p1", awaitingShop: false, decision: "accepted", jobId: "j1", jobReady: true }],
    };
    expect(eventsToQueue(full).every((e) => e.recipient === "shop")).toBe(true);
    expect(keys(full)).toEqual(["request_handed_over:inq-1"]);
  });

  it("each event has its own key from the id of the thing that happened", () => {
    const state: RequestState = {
      ...base,
      withShop: true,
      publishedQuoteIds: ["q1", "q2"],
      shopMessageIds: ["m1"],
      purchases: [
        { purchaseId: "p1", awaitingShop: true, decision: null, jobId: null, jobReady: false },
        { purchaseId: "p2", awaitingShop: false, decision: "accepted", jobId: "j2", jobReady: true },
        { purchaseId: "p3", awaitingShop: false, decision: "declined", jobId: null, jobReady: false },
      ],
    };
    expect(keys(state)).toEqual([
      "request_handed_over:inq-1",
      "order_awaiting_ok:p1",
      "request_started:inq-1",
      "price_ready:q1",
      "price_ready:q2",
      "shop_replied:m1",
      "order_accepted:p2",
      "ready_for_pickup:j2",
      "order_declined:p3",
    ]);
  });

  it("calls for the shop's emails only while they are true: not awaiting after the decision, not handed over before", () => {
    expect(keys({ ...base, purchases: [{ purchaseId: "p1", awaitingShop: false, decision: "accepted", jobId: null, jobReady: false }] })).not.toContain("order_awaiting_ok:p1");
    expect(keys(base)).not.toContain("request_handed_over:inq-1");
  });

  it("a job that is not ready yet calls for no pickup email", () => {
    expect(keys({ ...base, purchases: [{ purchaseId: "p1", awaitingShop: false, decision: "accepted", jobId: "j1", jobReady: false }] })).not.toContain("ready_for_pickup:j1");
  });

  it("is the same every time it is asked: keys are unique and stable", () => {
    const state: RequestState = { ...base, withShop: true, publishedQuoteIds: ["q1"], shopMessageIds: ["m1", "m2"], purchases: [] };
    expect(keys(state)).toEqual(keys(state));
    expect(new Set(keys(state)).size).toBe(keys(state).length);
  });

  it("every kind has a recipient, and the kinds are the ones the database allows", () => {
    expect([...ALL_KINDS].sort()).toEqual(["order_accepted", "order_awaiting_ok", "order_declined", "price_ready", "ready_for_pickup", "request_handed_over", "request_started", "shop_replied"]);
    for (const kind of ALL_KINDS) expect(["customer", "shop"]).toContain(recipientOf(kind));
    expect(recipientOf("order_awaiting_ok")).toBe("shop");
    expect(recipientOf("price_ready")).toBe("customer");
  });
});

describe("parseOptionalEmail", () => {
  it("empty means no address", () => {
    for (const raw of ["", "   ", null, undefined]) expect(parseOptionalEmail(raw)).toEqual({ ok: true, email: null });
  });
  it("trims and lowercases a good address", () => {
    expect(parseOptionalEmail("  Sam.Lee+orders@Example.COM ")).toEqual({ ok: true, email: "sam.lee+orders@example.com" });
  });
  it("refuses what is not an address", () => {
    for (const raw of ["sam", "sam@", "@example.com", "sam@example", "sam@@example.com", "sam @example.com", "sam@exa mple.com", "sam@example..com", "sam@.example.com", "sam@example.com.", `${"a".repeat(250)}@example.com`, 5, {}, []]) {
      expect(parseOptionalEmail(raw), String(raw)).toEqual({ ok: false });
    }
  });
});
