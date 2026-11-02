// Money is always an integer count of minor units (USD cents in v1).
// Rounding policy: half away from zero, applied only in roundHalfUp.
declare const brand: unique symbol;
export type Cents = number & { readonly [brand]: "Cents" };

function assertInteger(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${what} must be a safe integer`);
  }
}

export function cents(n: number): Cents {
  assertInteger(n, "money");
  return n as Cents;
}

export const add = (a: Cents, b: Cents): Cents => cents(a + b);

export function mulInt(a: Cents, quantity: number): Cents {
  assertInteger(quantity, "quantity");
  return cents(a * quantity);
}

export function sum(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((total, v) => add(total, v), cents(0));
}

/** amount * numerator / denominator, rounded half away from zero. Uses BigInt so the product cannot lose precision. */
export function roundHalfUp(amount: Cents, numerator: number, denominator: number): Cents {
  assertInteger(numerator, "numerator");
  assertInteger(denominator, "denominator");
  if (denominator <= 0) throw new RangeError("denominator must be positive");

  const product = BigInt(amount) * BigInt(numerator);
  const den = BigInt(denominator);
  const negative = product < BigInt(0);
  const abs = negative ? -product : product;
  const rounded = (abs * BigInt(2) + den) / (den * BigInt(2));
  return cents(Number(negative ? -rounded : rounded));
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Display only. Never parse the result back into money. */
export function format(amount: Cents): string {
  return usd.format(amount / 100);
}
