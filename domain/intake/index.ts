// Public surface of the intake domain. Pure: no Next.js, Supabase, Node, PayPal, model or network.
export { amountsOfAlternative, rankAlternatives, rankingSchema } from "./alternatives";
export type { RankedAlternative, RankingInput } from "./alternatives";
export { extractionSchema, parseExtraction } from "./extraction";
export { PROMPT_VERSION, buildPrompt, proposeJsonSchema, proposeSchema } from "./prompts";
export type { AlternativeForPrompt, ConversationEntry, Prompt, PromptContext, PromptMessage } from "./prompts";
export { acceptExplanation, acceptQuestion, askSchema, fallbackQuestion } from "./questions";
export type { ParsedExtraction } from "./extraction";
export { blockingFields, confirmedBoxCount, emptyRequirements, mergeRequirements, toCatalogRequirements } from "./requirements";
export { parseAnswer, quickRepliesFor } from "./quick-replies";
export type { ParsedAnswer, QuickChoice, QuickReplies } from "./quick-replies";
export { inquiryTransition } from "./state";
export { STORED_REQUIREMENTS_TAG, emptyStored, storedRequirementsSchema } from "./stored";
export type { OpenQuestion, Proposal, ProposalAlternative, StoredRequirements } from "./stored";
export { BLOCKING_FIELDS, FIELD_NAMES, FIELD_STATUSES, INQUIRY_STATUSES } from "./types";
export type {
  BlockingField,
  ExtractedField,
  Extraction,
  Field,
  FieldName,
  FieldStatus,
  InquiryEvent,
  InquiryStatus,
  IntakeErrorCode,
  IntakeResult,
  RequirementsDoc,
  Source,
} from "./types";
