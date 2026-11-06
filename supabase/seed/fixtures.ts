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

// The merchant's box template (catalog-engine). Products are named by SKU. Every slot is required;
// the card slot carries the logo, and the gift slot is where substitutions happen.
export const boxTemplate = {
  slots: [
    { id: "notebook", label: "Notebook", quantity: 1, allowedSkus: ["NOTEBOOK-A5"] },
    { id: "pen", label: "Pen", quantity: 1, allowedSkus: ["PEN-BLK"] },
    { id: "gift", label: "Gift item", quantity: 1, allowedSkus: ["BOTTLE-STEEL", "ORGANIZER-DESK", "TRUFFLES-BOX"] },
    { id: "card", label: "Branded card", quantity: 1, allowedSkus: ["CARD-BRANDED"], customization: "logo" },
    { id: "packaging", label: "Packaging", quantity: 1, allowedSkus: ["PACK-BOX"] },
  ],
};

export const businessRules = [
  { merchant_id: MERCHANT_ID, key: "box_template", value: boxTemplate },
  { merchant_id: MERCHANT_ID, key: "logo_print", value: { formats: ["png", "svg"], min_width_px: 600 } },
  { merchant_id: MERCHANT_ID, key: "production_lead_days", value: { days: 7 } },
  { merchant_id: MERCHANT_ID, key: "fulfilment", value: { method: "customer_pickup" } },
];

// The first shop's profile: who it makes things for. The intake prompt names the shop and its kind from this rule.
const giftBoxProfile = { merchant_id: MERCHANT_ID, key: "shop_profile", value: { productKind: "gift box" } };

// ---------------------------------------------------------------------------------------------------------------------
// The second demo shop: event welcome kits. Same requirement fields as the first (quantity, no food, logo, budget, date),
// different catalog, template and prices, so the engine is shown to be driven by data. The insulated bottle has 40 in stock,
// so 50 kits cannot include it and the engine proposes the enamel mug.
//   20 kits with the bottle: 900 + 250 + 1500 + 300 + 400 = 3350 a kit, 67000 in total
//   50 kits with the mug:    900 + 250 + 1100 + 300 + 400 = 2950 a kit, 147500 in total
// ---------------------------------------------------------------------------------------------------------------------

export const MERCHANT2_ID = "00000000-0000-4000-8000-000000000002";

export const merchant2 = {
  id: MERCHANT2_ID,
  slug: "demo-event-kits",
  name: "Demo Event Kits (simulated)",
  currency: "USD",
};

export const PRODUCT2_IDS = {
  tote: "00000000-0000-4000-8000-0000000000b1",
  lanyard: "00000000-0000-4000-8000-0000000000b2",
  bottle: "00000000-0000-4000-8000-0000000000b3",
  mug: "00000000-0000-4000-8000-0000000000b4",
  stickers: "00000000-0000-4000-8000-0000000000b5",
  packaging: "00000000-0000-4000-8000-0000000000b6",
} as const;

const base2 = { merchant_id: MERCHANT2_ID };

export const products2: Product[] = [
  { ...base2, id: PRODUCT2_IDS.tote, sku: "TOTE-CANVAS", name: "Canvas tote bag", category: "bags", unit_price_minor: 900, is_food: false, attributes: {} },
  { ...base2, id: PRODUCT2_IDS.lanyard, sku: "LANYARD-PRINT", name: "Printed lanyard", category: "badges", unit_price_minor: 250, is_food: false, attributes: { customization: "logo" } },
  { ...base2, id: PRODUCT2_IDS.bottle, sku: "BOTTLE-INSULATED", name: "Insulated bottle", category: "drinkware", unit_price_minor: 1500, is_food: false, attributes: {} },
  { ...base2, id: PRODUCT2_IDS.mug, sku: "MUG-ENAMEL", name: "Enamel mug", category: "drinkware", unit_price_minor: 1100, is_food: false, attributes: {} },
  { ...base2, id: PRODUCT2_IDS.stickers, sku: "STICKERS-PACK", name: "Sticker pack", category: "stationery", unit_price_minor: 300, is_food: false, attributes: {} },
  { ...base2, id: PRODUCT2_IDS.packaging, sku: "PACK-KIT", name: "Kit mailer box", category: "packaging", unit_price_minor: 400, is_food: false, attributes: {} },
];

export const stock2 = [
  { product_id: PRODUCT2_IDS.tote, on_hand: 300, reserved: 0 },
  { product_id: PRODUCT2_IDS.lanyard, on_hand: 400, reserved: 0 },
  { product_id: PRODUCT2_IDS.bottle, on_hand: 40, reserved: 0 },
  { product_id: PRODUCT2_IDS.mug, on_hand: 200, reserved: 0 },
  { product_id: PRODUCT2_IDS.stickers, on_hand: 600, reserved: 0 },
  { product_id: PRODUCT2_IDS.packaging, on_hand: 300, reserved: 0 },
];

export const boxTemplate2 = {
  slots: [
    { id: "tote", label: "Tote bag", quantity: 1, allowedSkus: ["TOTE-CANVAS"] },
    { id: "lanyard", label: "Lanyard", quantity: 1, allowedSkus: ["LANYARD-PRINT"], customization: "logo" },
    { id: "drink", label: "Drinkware", quantity: 1, allowedSkus: ["BOTTLE-INSULATED", "MUG-ENAMEL"] },
    { id: "stickers", label: "Stickers", quantity: 1, allowedSkus: ["STICKERS-PACK"] },
    { id: "packaging", label: "Packaging", quantity: 1, allowedSkus: ["PACK-KIT"] },
  ],
};

export const businessRules2 = [
  { merchant_id: MERCHANT2_ID, key: "box_template", value: boxTemplate2 },
  { merchant_id: MERCHANT2_ID, key: "logo_print", value: { formats: ["png", "svg"], min_width_px: 600 } },
  { merchant_id: MERCHANT2_ID, key: "production_lead_days", value: { days: 7 } },
  { merchant_id: MERCHANT2_ID, key: "fulfilment", value: { method: "customer_pickup" } },
  { merchant_id: MERCHANT2_ID, key: "shop_profile", value: { productKind: "event welcome kit" } },
];

export type Shop = {
  merchant: { id: string; slug: string; name: string; currency: string };
  products: Product[];
  stock: Array<{ product_id: string; on_hand: number; reserved: number }>;
  rules: Array<{ merchant_id: string; key: string; value: unknown }>;
  /** The environment variables holding this shop owner's demo login. */
  owner: { emailVar: string; passwordVar: string };
};

/** Every demo shop, in the order the seed creates them. The first is the original gift-box shop, unchanged. */
export const shops: Shop[] = [
  {
    merchant,
    products,
    stock,
    rules: [...businessRules, giftBoxProfile],
    owner: { emailVar: "DEMO_MERCHANT_EMAIL", passwordVar: "DEMO_MERCHANT_PASSWORD" },
  },
  {
    merchant: merchant2,
    products: products2,
    stock: stock2,
    rules: businessRules2,
    owner: { emailVar: "DEMO_MERCHANT2_EMAIL", passwordVar: "DEMO_MERCHANT2_PASSWORD" },
  },
];
