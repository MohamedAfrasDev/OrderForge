// Public surface of the intake domain. Pure: no Next.js, Supabase, Node, PayPal, model or network.
export { extractionSchema, parseExtraction } from "./extraction";
export type { ParsedExtraction } from "./extraction";
export { blockingFields, confirmedBoxCount, emptyRequirements, mergeRequirements, toCatalogRequirements } from "./requirements";
export { inquiryTransition } from "./state";
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
