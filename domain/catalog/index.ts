// Public surface of the catalog engine. Pure: no Next.js, Supabase, Node or network.
export { proposeAlternatives, DEFAULT_ALTERNATIVES_LIMIT, MAX_ALTERNATIVES_LIMIT } from "./alternatives";
export { addDays, isCalendarDate } from "./dates";
export { catalogForModel } from "./model-view";
export type { ModelCatalogView, ModelProduct } from "./model-view";
export { calculateQuote } from "./price";
export { boxTemplateRuleSchema, configurationSchema, requirementsSchema } from "./schemas";
export type { BoxTemplateRule } from "./schemas";
export { validateConfiguration } from "./validate";
export type {
  Alternative,
  Blocker,
  Catalog,
  Configuration,
  PricedConfiguration,
  PricedLine,
  Product,
  ProposeOptions,
  Requirements,
  Slot,
  Stock,
  ValidationInput,
  ValidationResult,
} from "./types";
