import { describe, expect, it } from "vitest";
import {
  DEFAULT_VALIDITY_HOURS,
  QUOTE_EVENTS,
  QUOTE_STATUSES,
  expiresAt,
  isExpired,
  isLive,
  isTerminal,
  transition,
} from "@/domain/quote/state";
import type { QuoteEvent, QuoteStatus } from "@/domain/quote/types";

// The spec's table, written out independently of the implementation.
const LEGAL: Array<[QuoteStatus, QuoteEvent, QuoteStatus]> = [
  ["DRAFT", "PUBLISH", "PUBLISHED"],
  ["DRAFT", "WITHDRAW", "WITHDRAWN"],
  ["PUBLISHED", "ACCEPT", "ACCEPTED"],
  ["PUBLISHED", "SUPERSEDE", "SUPERSEDED"],
  ["PUBLISHED", "EXPIRE", "EXPIRED"],
  ["PUBLISHED", "WITHDRAW", "WITHDRAWN"],
  ["ACCEPTED", "SUPERSEDE", "SUPERSEDED"],
];

describe("transition", () => {
  it("covers every status and event pair", () => {
    expect(QUOTE_STATUSES).toHaveLength(6);
    expect(QUOTE_EVENTS).toHaveLength(5);
    for (const from of QUOTE_STATUSES) {
      for (const event of QUOTE_EVENTS) {
        const legal = LEGAL.find(([f, e]) => f === from && e === event);
        const result = transition(from, event);
        if (legal) expect(result, `${from} + ${event}`).toBe(legal[2]);
        else expect(result, `${from} + ${event}`).toEqual({ error: "ILLEGAL_TRANSITION" });
      }
    }
  });

  it("never returns to DRAFT", () => {
    for (const from of QUOTE_STATUSES) {
      for (const event of QUOTE_EVENTS) expect(transition(from, event)).not.toBe("DRAFT");
    }
  });

  it("an accepted quote cannot go back to published, expire or be withdrawn here", () => {
    expect(transition("ACCEPTED", "EXPIRE")).toEqual({ error: "ILLEGAL_TRANSITION" });
    expect(transition("ACCEPTED", "WITHDRAW")).toEqual({ error: "ILLEGAL_TRANSITION" });
    expect(transition("ACCEPTED", "PUBLISH")).toEqual({ error: "ILLEGAL_TRANSITION" });
  });

  it("terminal states have no way out", () => {
    for (const s of ["SUPERSEDED", "EXPIRED", "WITHDRAWN"] as const) {
      for (const event of QUOTE_EVENTS) expect(transition(s, event)).toEqual({ error: "ILLEGAL_TRANSITION" });
    }
  });

  it("only returns states from the known set (seeded walk)", () => {
    let seed = 12345;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    let state: QuoteStatus = "DRAFT";
    for (let i = 0; i < 500; i++) {
      const event = QUOTE_EVENTS[next() % QUOTE_EVENTS.length]!;
      const result = transition(state, event);
      if (typeof result === "string") {
        expect(QUOTE_STATUSES).toContain(result);
        state = result;
      }
    }
  });
});

describe("isLive and isTerminal", () => {
  it("live means PUBLISHED or ACCEPTED, the two states the database allows one of per inquiry", () => {
    expect(QUOTE_STATUSES.filter(isLive)).toEqual(["PUBLISHED", "ACCEPTED"]);
  });

  it("terminal means SUPERSEDED, EXPIRED or WITHDRAWN", () => {
    expect(QUOTE_STATUSES.filter(isTerminal)).toEqual(["SUPERSEDED", "EXPIRED", "WITHDRAWN"]);
  });
});

describe("expiry", () => {
  const published = "2026-11-03T10:00:00.000Z";

  it("defaults to 72 hours", () => {
    expect(DEFAULT_VALIDITY_HOURS).toBe(72);
  });

  it("expiresAt adds the validity window", () => {
    expect(expiresAt(published, 72)).toBe("2026-11-06T10:00:00.000Z");
    expect(expiresAt(published, 1)).toBe("2026-11-03T11:00:00.000Z");
  });

  it("is not expired before or exactly at the boundary, expired one millisecond after", () => {
    expect(isExpired(published, 72, "2026-11-06T09:59:59.999Z")).toBe(false);
    expect(isExpired(published, 72, "2026-11-06T10:00:00.000Z")).toBe(false);
    expect(isExpired(published, 72, "2026-11-06T10:00:00.001Z")).toBe(true);
  });

  it("handles an offset timestamp as the same instant", () => {
    expect(isExpired("2026-11-03T15:30:00+05:30", 72, "2026-11-06T10:00:00.000Z")).toBe(false);
    expect(isExpired("2026-11-03T15:30:00+05:30", 72, "2026-11-06T10:00:00.001Z")).toBe(true);
  });

  it.each([
    ["not a date", 72],
    [published, 0],
    [published, -1],
    [published, 1.5],
    [published, Number.NaN],
  ])("throws on bad input (%s, %s)", (at, hours) => {
    expect(() => isExpired(at as string, hours as number, published)).toThrow();
  });

  it("throws on an invalid now", () => {
    expect(() => isExpired(published, 72, "nope")).toThrow();
  });
});
