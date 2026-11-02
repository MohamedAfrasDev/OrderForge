// Synthetic demo fixtures. All names, prices and stock levels are illustrative.
// IDs are fixed so the seed is idempotent and tests can refer to them.

export const MERCHANT_ID = "00000000-0000-4000-8000-000000000001";

export const merchant = {
  id: MERCHANT_ID,
  slug: "demo-gift-boxes",
  name: "Demo Gift Boxes (simulated)",
  currency: "USD",
};

export const PRODUCT_IDS = {
  notebook: "00000000-0000-4000-8000-0000000000a1",
  pen: "00000000-0000-4000-8000-0000000000a2",
  organizer: "00000000-0000-4000-8000-0000000000a3",
  brandedCard: "00000000-0000-4000-8000-0000000000a4",
  packaging: "00000000-0000-4000-8000-0000000000a5",
  bottle: "00000000-0000-4000-8000-0000000000a6",
  truffles: "00000000-0000-4000-8000-0000000000a7",
} as const;

type Product = {
  id: string;
  merchant_id: string;
  sku: string;
  name: string;
  category: string;
  unit_price_minor: number;
  is_food: boolean;
  attributes: Record<string, unknown>;
};

const base = { merchant_id: MERCHANT_ID };

export const products: Product[] = [
  { ...base, id: PRODUCT_IDS.notebook, sku: "NOTEBOOK-A5", name: "A5 notebook", category: "stationery", unit_price_minor: 1200, is_food: false, attributes: {} },
  { ...base, id: PRODUCT_IDS.pen, sku: "PEN-BLK", name: "Black gel pen", category: "stationery", unit_price_minor: 300, is_food: false, attributes: {} },
  { ...base, id: PRODUCT_IDS.organizer, sku: "ORGANIZER-DESK", name: "Desk organizer", category: "desk", unit_price_minor: 1400, is_food: false, attributes: {} },
  { ...base, id: PRODUCT_IDS.brandedCard, sku: "CARD-BRANDED", name: "Branded welcome card", category: "branding", unit_price_minor: 200, is_food: false, attributes: { customization: "logo" } },
  { ...base, id: PRODUCT_IDS.packaging, sku: "PACK-BOX", name: "Gift box packaging", category: "packaging", unit_price_minor: 500, is_food: false, attributes: {} },
  { ...base, id: PRODUCT_IDS.bottle, sku: "BOTTLE-STEEL", name: "Steel water bottle", category: "drinkware", unit_price_minor: 1300, is_food: false, attributes: {} },
  { ...base, id: PRODUCT_IDS.truffles, sku: "TRUFFLES-BOX", name: "Chocolate truffles", category: "food", unit_price_minor: 800, is_food: true, attributes: {} },
];

// The bottle has exactly 24 in stock, so 30 boxes cannot include it.
export const stock = [
  { product_id: PRODUCT_IDS.notebook, on_hand: 200, reserved: 0 },
  { product_id: PRODUCT_IDS.pen, on_hand: 500, reserved: 0 },
  { product_id: PRODUCT_IDS.organizer, on_hand: 100, reserved: 0 },
  { product_id: PRODUCT_IDS.brandedCard, on_hand: 500, reserved: 0 },
  { product_id: PRODUCT_IDS.packaging, on_hand: 200, reserved: 0 },
  { product_id: PRODUCT_IDS.bottle, on_hand: 24, reserved: 0 },
  { product_id: PRODUCT_IDS.truffles, on_hand: 50, reserved: 0 },
];

export const businessRules = [
  { merchant_id: MERCHANT_ID, key: "logo_print", value: { formats: ["png", "svg"], min_width_px: 600 } },
  { merchant_id: MERCHANT_ID, key: "production_lead_days", value: { days: 7 } },
  { merchant_id: MERCHANT_ID, key: "fulfilment", value: { method: "customer_pickup" } },
];
