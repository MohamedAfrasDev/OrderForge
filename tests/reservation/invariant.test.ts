import { describe, expect, it } from "vitest";
import { stockInvariant } from "@/domain/reservation/invariant";

describe("stockInvariant", () => {
  it("passes when reserved equals the quantity on live reservations", () => {
    const stock = [
      { productId: "p-1", onHand: 100, reserved: 30 },
      { productId: "p-2", onHand: 50, reserved: 0 },
    ];
    expect(stockInvariant(stock, [{ productId: "p-1", quantity: 10 }, { productId: "p-1", quantity: 20 }])).toEqual([]);
  });

  it("reports reserved stock that no live reservation accounts for", () => {
    const found = stockInvariant([{ productId: "p-1", onHand: 100, reserved: 30 }], [{ productId: "p-1", quantity: 20 }]);
    expect(found).toEqual([{ code: "RESERVED_MISMATCH", productId: "p-1", reserved: 30, expected: 20 }]);
  });

  it("reports a live reservation that stock does not reflect", () => {
    const found = stockInvariant([{ productId: "p-1", onHand: 100, reserved: 0 }], [{ productId: "p-1", quantity: 5 }]);
    expect(found).toEqual([{ code: "RESERVED_MISMATCH", productId: "p-1", reserved: 0, expected: 5 }]);
  });

  it("reports a live reservation for a product with no stock row", () => {
    const found = stockInvariant([], [{ productId: "p-9", quantity: 5 }]);
    expect(found).toEqual([{ code: "RESERVED_MISMATCH", productId: "p-9", reserved: 0, expected: 5 }]);
  });

  it("reports reserved above on_hand", () => {
    const found = stockInvariant([{ productId: "p-1", onHand: 10, reserved: 12 }], [{ productId: "p-1", quantity: 12 }]);
    expect(found).toEqual([{ code: "RESERVED_EXCEEDS_ON_HAND", productId: "p-1", onHand: 10, reserved: 12 }]);
  });

  it("with a baseline, on_hand must have fallen by exactly the committed quantity", () => {
    const stock = [{ productId: "p-1", onHand: 70, reserved: 0 }];
    const options = { baselineOnHand: { "p-1": 100 }, committedLines: [{ productId: "p-1", quantity: 30 }] };
    expect(stockInvariant(stock, [], options)).toEqual([]);
    expect(stockInvariant([{ productId: "p-1", onHand: 71, reserved: 0 }], [], options)).toEqual([
      { code: "ON_HAND_MISMATCH", productId: "p-1", onHand: 71, expected: 70 },
    ]);
  });

  it("reports several problems at once, ordered by product id", () => {
    const found = stockInvariant(
      [
        { productId: "p-2", onHand: 5, reserved: 9 },
        { productId: "p-1", onHand: 5, reserved: 1 },
      ],
      [],
    );
    expect(found.map((d) => `${d.productId}:${d.code}`)).toEqual([
      "p-1:RESERVED_MISMATCH",
      "p-2:RESERVED_EXCEEDS_ON_HAND",
      "p-2:RESERVED_MISMATCH",
    ]);
  });

  it("does not mutate its inputs", () => {
    const stock = [{ productId: "p-1", onHand: 1, reserved: 0 }];
    const lines = [{ productId: "p-1", quantity: 1 }];
    const copy = structuredClone({ stock, lines });
    stockInvariant(stock, lines);
    expect({ stock, lines }).toEqual(copy);
  });
});
