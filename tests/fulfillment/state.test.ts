import { describe, expect, it } from "vitest";
import { JOB_STATUSES, allowedMoves, transition, type JobStatus } from "@/domain/fulfillment";

// Written separately from the implementation: from -> the statuses it may move to (ON_HOLD resumes only where it was).
const TABLE: Record<JobStatus, JobStatus[]> = {
  QUEUED: ["PREPARING", "ON_HOLD"],
  PREPARING: ["READY_FOR_PICKUP", "ON_HOLD"],
  READY_FOR_PICKUP: ["COLLECTED", "ON_HOLD"],
  COLLECTED: [],
  ON_HOLD: [], // plus the status it left, given in the context
};

const ILLEGAL = { error: "ILLEGAL_TRANSITION" };

describe("job transition table", () => {
  it("lists the five statuses", () => {
    expect([...JOB_STATUSES].sort()).toEqual(["COLLECTED", "ON_HOLD", "PREPARING", "QUEUED", "READY_FOR_PICKUP"]);
  });

  for (const from of JOB_STATUSES) {
    for (const to of JOB_STATUSES) {
      const legal = TABLE[from].includes(to);
      it(`${from} -> ${to} is ${legal ? "allowed" : "refused"}`, () => {
        expect(transition(from, to, {})).toEqual(legal ? to : ILLEGAL);
      });
    }
  }

  it("a new job can only start QUEUED", () => {
    for (const to of JOB_STATUSES) expect(transition(null, to, {})).toEqual(to === "QUEUED" ? "QUEUED" : ILLEGAL);
  });

  it("COLLECTED is final, even with a hold context", () => {
    for (const to of JOB_STATUSES) expect(transition("COLLECTED", to, { heldFrom: "PREPARING" })).toEqual(ILLEGAL);
  });

  describe("resuming from ON_HOLD", () => {
    for (const left of ["QUEUED", "PREPARING", "READY_FOR_PICKUP"] as const) {
      it(`returns to ${left} and nowhere else`, () => {
        for (const to of JOB_STATUSES) {
          expect(transition("ON_HOLD", to, { heldFrom: left })).toEqual(to === left ? left : ILLEGAL);
        }
      });
    }

    it("cannot resume without knowing where it was, or to a status that cannot be held", () => {
      for (const to of JOB_STATUSES) {
        expect(transition("ON_HOLD", to, {})).toEqual(ILLEGAL);
        expect(transition("ON_HOLD", to, { heldFrom: null })).toEqual(ILLEGAL);
        expect(transition("ON_HOLD", to, { heldFrom: "COLLECTED" })).toEqual(ILLEGAL);
        expect(transition("ON_HOLD", to, { heldFrom: "ON_HOLD" })).toEqual(ILLEGAL);
      }
    });

    it("the hold context is ignored away from ON_HOLD", () => {
      expect(transition("QUEUED", "PREPARING", { heldFrom: "READY_FOR_PICKUP" })).toBe("PREPARING");
      expect(transition("QUEUED", "READY_FOR_PICKUP", { heldFrom: "READY_FOR_PICKUP" })).toEqual(ILLEGAL);
    });
  });

  it("allowedMoves lists exactly the legal targets", () => {
    for (const from of JOB_STATUSES) {
      expect([...allowedMoves(from, {})].sort()).toEqual([...TABLE[from]].sort());
    }
    expect(allowedMoves("ON_HOLD", { heldFrom: "PREPARING" })).toEqual(["PREPARING"]);
    expect(allowedMoves(null, {})).toEqual(["QUEUED"]);
  });

  it("no status can skip a step or go backwards", () => {
    expect(transition("QUEUED", "READY_FOR_PICKUP", {})).toEqual(ILLEGAL);
    expect(transition("QUEUED", "COLLECTED", {})).toEqual(ILLEGAL);
    expect(transition("PREPARING", "QUEUED", {})).toEqual(ILLEGAL);
    expect(transition("READY_FOR_PICKUP", "PREPARING", {})).toEqual(ILLEGAL);
  });
});
