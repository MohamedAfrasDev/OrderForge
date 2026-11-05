// Public surface of the journey domain: where a customer's order stands, and the words for it. Pure.
export { journeyOf } from "./journey";
export type { Journey, JourneyInput, JourneyStep, StepState } from "./journey";
export { FORBIDDEN, STEP_IDS, STEP_LABELS, WORDS, forbiddenIn } from "./wording";
export type { StepId, WordsKey } from "./wording";
