import type { IntakeErrorCode } from "@/domain/intake";

/** What the customer is told for each coded result. Plain words, no internals, nothing that echoes what they typed. */
export function intakeFailureMessage(code: IntakeErrorCode): string {
  switch (code) {
    case "MESSAGE_TOO_LONG":
      return "That message is too long. Please keep it under 4,000 characters.";
    case "INVALID_INPUT":
      return "Please check what you entered and try again.";
    case "LIMIT_REACHED":
      return "This conversation has reached its limit, so the merchant will take over from here.";
    case "MODEL_UNAVAILABLE":
    case "MODEL_OUTPUT_INVALID":
      return "The assistant could not answer just now. Your message is kept. You can try again or ask the merchant to take over.";
    case "PROPOSAL_STALE":
      return "That option is no longer available as shown, so nothing was ordered. Send a message and the assistant will propose again.";
    case "ILLEGAL_TRANSITION":
      return "That is no longer possible at this stage of your request.";
    case "ALREADY_ANSWERED":
      return "That message was already answered.";
    case "CONFIGURATION_BLOCKED":
      return "That box cannot be made as asked.";
    case "INQUIRY_NOT_FOUND":
    case "NOT_FOUND":
      return "We could not find that request.";
  }
}
