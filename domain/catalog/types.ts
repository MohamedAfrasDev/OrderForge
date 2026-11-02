import type { Cents } from "@/lib/money";

/** What the merchant sells (a snapshot, loaded by the service layer). */
export type Product = {
  id: string;
  sku: string;
  name: string;
  category: string;
  unitPriceMinor: Cents;
  isFood: boolean;
  active: boolean;
};

export type Slot = {
  id: string;
  label: string;
  quantity: number;
  allowedSkus: string[];
  customization?: "logo";
};

export type Catalog = {
  products: Product[];
  slots: Slot[];
  rules: { minOrderQuantity?: number; productionLeadDays: number };
};

/** productId -> available = on_hand - reserved */
export type Stock = Record<string, number>;

/** What the customer wants. Constraints only; nothing here is payable. */
export type Requirements = {
  noFood: boolean;
  maxPricePerBoxMinor?: Cents;
  logoRequired: boolean;
  /** YYYY-MM-DD, no time zone */
  requestedPickupDate?: string;
};

/** What is chosen. Only these two fields exist; there is no input for a price. */
export type Configuration = {
  boxCount: number;
  /** slotId -> sku */
  selections: Record<string, string>;
};

export type Blocker =
  | { code: "UNKNOWN_PRODUCT"; slotId: string; sku: string }
  | { code: "INACTIVE_PRODUCT"; slotId: string; sku: string }
  | { code: "UNKNOWN_SLOT"; slotId: string }
  | { code: "SLOT_NOT_FILLED"; slotId: string }
  | { code: "PRODUCT_NOT_ALLOWED_IN_SLOT"; slotId: string; sku: string }
  | { code: "FOOD_NOT_ALLOWED"; slotId: string; sku: string }
  | { code: "INSUFFICIENT_STOCK"; sku: string; needed: number; available: number }
  | { code: "OVER_BUDGET"; perBoxMinor: Cents; maxMinor: Cents }
  | { code: "LOGO_NOT_COVERED" }
  | { code: "BELOW_MIN_QUANTITY"; boxCount: number; minimum: number }
  | { code: "INVALID_QUANTITY"; boxCount: number }
  | { code: "UNSUPPORTED_DATE"; requested: string; earliest: string };

export type PricedLine = {
  slotId: string;
  sku: string;
  name: string;
  unitPriceMinor: Cents;
  quantity: number;
};

export type PricedConfiguration = {
  lines: PricedLine[];
  perBoxMinor: Cents;
  boxCount: number;
  totalMinor: Cents;
  currency: "USD";
};

/** A valid single swap inside one slot. `priced` is the full price of the swapped box. */
export type Alternative = {
  slotId: string;
  fromSku: string;
  toSku: string;
  /** swapped per-box price minus the original per-box price; negative means cheaper */
  perBoxDeltaMinor: number;
  priced: PricedConfiguration;
};

export type ProposeOptions = { limit?: number };

export type ValidationInput = {
  configuration: Configuration;
  catalog: Catalog;
  requirements: Requirements;
  stock: Stock;
  /** YYYY-MM-DD. Passed in; the engine never reads the clock. */
  today: string;
};

export type ValidationResult =
  | { ok: true; priced: PricedConfiguration }
  | { ok: false; blockers: Blocker[] };
