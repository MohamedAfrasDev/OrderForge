import { describe, expect, it } from "vitest";
import type { IntakeErrorCode } from "@/domain/intake";
import { forbiddenIn } from "@/domain/journey";
import { intakeFailureMessage } from "@/services/intake/customer-messages";

const CODES: IntakeErrorCode[] = [
  "INQUIRY_NOT_FOUND",
  "MESSAGE_TOO_LONG",
  "LIMIT_REACHED",
  "ALREADY_ANSWERED",
  "MODEL_UNAVAILABLE",
  "MODEL_OUTPUT_INVALID",
  "PROPOSAL_STALE",
  "CONFIGURATION_BLOCKED",
  "NOT_FOUND",
  "INVALID_INPUT",
  "ILLEGAL_TRANSITION",
];

describe("what the customer is told", () => {
  it("has plain words for every coded result, with no code names, ids or internals", () => {
    for (const code of CODES) {
      const text = intakeFailureMessage(code);
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, code).not.toMatch(/[A-Z]{3,}_[A-Z_]+|model|provider|openrouter|stack|error/i);
    }
  });

  it("uses only the customer's vocabulary: no forbidden word in any message", () => {
    for (const code of CODES) expect(forbiddenIn(intakeFailureMessage(code)), code).toEqual([]);
  });

  it("offers a way forward when the assistant fails", () => {
    expect(intakeFailureMessage("MODEL_UNAVAILABLE")).toMatch(/try again/i);
    expect(intakeFailureMessage("MODEL_UNAVAILABLE")).toMatch(/shop/i);
    expect(intakeFailureMessage("MODEL_OUTPUT_INVALID")).toBe(intakeFailureMessage("MODEL_UNAVAILABLE"));
  });
});
