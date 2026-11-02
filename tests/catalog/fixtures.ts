import type { Catalog, Product, Requirements, Slot, Stock, ValidationInput } from "@/domain/catalog/types";
import { cents } from "@/lib/money";

export const product = (sku: string, name: string, price: number, over: Partial<Product> = {}): Product => ({
  id: `id-${sku}`,
  sku,
  name,
  category: "misc",
  unitPriceMinor: cents(price),
  isFood: false,
  active: true,
  ...over,
});

/** The illustrative demo catalog from the brief. All figures are fixtures. */
export const demoProducts: Product[] = [
  product("NB-01", "Notebook", 1200, { category: "stationery" }),
  product("PN-01", "Pen", 300, { category: "stationery" }),
  product("BOT-01", "Water bottle", 1300, { category: "drinkware" }),
  product("ORG-01", "Desk organizer", 1400, { category: "desk" }),
  product("TRF-01", "Chocolate truffles", 900, { category: "food", isFood: true }),
  product("CARD-01", "Branded card", 200, { category: "print" }),
  product("PKG-01", "Gift packaging", 500, { category: "packaging" }),
];

export const demoSlots: Slot[] = [
  { id: "notebook", label: "Notebook", quantity: 1, allowedSkus: ["NB-01"] },
  { id: "pen", label: "Pen", quantity: 1, allowedSkus: ["PN-01"] },
  { id: "gift", label: "Gift item", quantity: 1, allowedSkus: ["BOT-01", "ORG-01", "TRF-01"] },
  { id: "card", label: "Branded card", quantity: 1, allowedSkus: ["CARD-01"], customization: "logo" },
  { id: "packaging", label: "Packaging", quantity: 1, allowedSkus: ["PKG-01"] },
];

export const demoCatalog: Catalog = {
  products: demoProducts,
  slots: demoSlots,
  rules: { productionLeadDays: 0 },
};

/** available = on_hand - reserved, keyed by product id. 24 bottles is the demo's stock constraint. */
export const demoStock: Stock = {
  "id-NB-01": 500,
  "id-PN-01": 500,
  "id-BOT-01": 24,
  "id-ORG-01": 60,
  "id-TRF-01": 100,
  "id-CARD-01": 500,
  "id-PKG-01": 500,
};

export const demoRequirements: Requirements = { noFood: true, logoRequired: true, maxPricePerBoxMinor: cents(3999) };

export const withGift = (sku: string): Record<string, string> => ({
  notebook: "NB-01",
  pen: "PN-01",
  gift: sku,
  card: "CARD-01",
  packaging: "PKG-01",
});

export function demoInput(over: Partial<ValidationInput> = {}): ValidationInput {
  return {
    configuration: { boxCount: 20, selections: withGift("BOT-01") },
    catalog: demoCatalog,
    requirements: demoRequirements,
    stock: demoStock,
    today: "2026-11-02",
    ...over,
  };
}
