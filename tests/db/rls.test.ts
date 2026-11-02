import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anonClient,
  codeOf,
  createChain,
  createMerchantUser,
  must,
  serviceClient,
  signedInClient,
  SQLSTATE,
  unique,
  type Chain,
} from "./helpers";

const admin = serviceClient();

// Merchant A owns chainA; merchant B owns chainB. Each can only see their own.
let clientA: SupabaseClient;
let clientB: SupabaseClient;
let chainA: Chain;
let chainB: Chain;
let productA: string;
let attemptA: string;

async function seedMerchantData(chain: Chain) {
  const product = must(
    await admin.from("products").insert({
      merchant_id: chain.merchantId, sku: unique("SKU"), name: "p", category: "c", unit_price_minor: 100,
    }).select("id").single(),
  );
  must(await admin.from("stock").insert({ product_id: product.id, on_hand: 10 }));
  must(await admin.from("business_rules").insert({ merchant_id: chain.merchantId, key: "k", value: {} }));
  must(await admin.from("messages").insert({ inquiry_id: chain.inquiryId, role: "customer", body: "hello" }));
  const reservation = must(
    await admin.from("reservations").insert({ purchase_id: chain.purchaseId }).select("id").single(),
  );
  must(await admin.from("reservation_lines").insert({ reservation_id: reservation.id, product_id: product.id, quantity: 1 }));
  const attempt = must(
    await admin.from("payment_attempts").insert({
      purchase_id: chain.purchaseId, amount_minor: 100, quote_hash: chain.quoteHash,
    }).select("id").single(),
  );
  must(await admin.from("payment_events").insert({
    payment_attempt_id: attempt.id, event_type: "x", source: "api", evidence_label: "mocked",
  }));
  must(await admin.from("merchant_decisions").insert({
    purchase_id: chain.purchaseId, quote_version_id: chain.quoteId, merchant_id: chain.merchantId,
  }));
  const job = must(
    await admin.from("preparation_jobs").insert({ purchase_id: chain.purchaseId, worksheet: {} }).select("id").single(),
  );
  must(await admin.from("preparation_events").insert({ job_id: job.id, status: "QUEUED" }));
  must(await admin.from("audit_events").insert({
    actor: "test", action: "x", entity: "e", entity_id: "1", correlation_id: "corr-12345678",
  }));
  return { productId: product.id as string, attemptId: attempt.id as string };
}

beforeAll(async () => {
  const userA = await createMerchantUser(admin);
  const userB = await createMerchantUser(admin);
  chainA = await createChain(admin, userA.id);
  chainB = await createChain(admin, userB.id);
  const a = await seedMerchantData(chainA);
  await seedMerchantData(chainB);
  productA = a.productId;
  attemptA = a.attemptId;
  clientA = await signedInClient(userA.email, userA.password);
  clientB = await signedInClient(userB.email, userB.password);
});

// table -> column that holds the owning chain's id, so we can assert exact visibility
const MERCHANT_SCOPED: Array<[table: string, column: string, valueOf: (c: Chain) => string]> = [
  ["merchants", "id", (c) => c.merchantId],
  ["products", "merchant_id", (c) => c.merchantId],
  ["business_rules", "merchant_id", (c) => c.merchantId],
  ["inquiries", "merchant_id", (c) => c.merchantId],
  ["messages", "inquiry_id", (c) => c.inquiryId],
  ["quote_versions", "inquiry_id", (c) => c.inquiryId],
  ["approvals", "id", (c) => c.approvalId],
  ["purchases", "merchant_id", (c) => c.merchantId],
  ["reservations", "purchase_id", (c) => c.purchaseId],
  ["payment_attempts", "purchase_id", (c) => c.purchaseId],
  ["merchant_decisions", "merchant_id", (c) => c.merchantId],
  ["preparation_jobs", "purchase_id", (c) => c.purchaseId],
];

describe("anonymous access", () => {
  it.each([...MERCHANT_SCOPED.map(([t]) => t), "stock", "payment_events", "audit_events"])(
    "is denied on %s",
    async (table) => {
      const result = await anonClient().from(table).select("*").limit(1);
      expect(codeOf(result)).toBe(SQLSTATE.denied);
    },
  );
});

describe("a merchant reads only their own rows", () => {
  it.each(MERCHANT_SCOPED)("%s", async (table, column, valueOf) => {
    const mine = must(await clientA.from(table).select("*").eq(column, valueOf(chainA)), `${table} mine`);
    const theirs = must(await clientA.from(table).select("*").eq(column, valueOf(chainB)), `${table} theirs`);
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs).toHaveLength(0);

    // and the other way round
    const bSeesA = must(await clientB.from(table).select("*").eq(column, valueOf(chainA)), `${table} b->a`);
    expect(bSeesA).toHaveLength(0);
  });

  it("stock, through the product", async () => {
    expect(must(await clientA.from("stock").select("*").eq("product_id", productA))).toHaveLength(1);
    expect(must(await clientB.from("stock").select("*").eq("product_id", productA))).toHaveLength(0);
  });

  it("reservation lines, payment events and preparation events, through their parents", async () => {
    for (const table of ["reservation_lines", "payment_events", "preparation_events"]) {
      const a = must(await clientA.from(table).select("*"), table);
      const b = must(await clientB.from(table).select("*"), table);
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);
      // each merchant sees only rows tied to their own chain: no row ids are shared
      const aIds = new Set(a.map((r: { id: string }) => r.id));
      expect(b.some((r: { id: string }) => aIds.has(r.id))).toBe(false);
    }
    const attempts = must(await clientB.from("payment_events").select("*").eq("payment_attempt_id", attemptA));
    expect(attempts).toHaveLength(0);
  });

  it("cannot read audit_events at all", async () => {
    expect(must(await clientA.from("audit_events").select("*"))).toHaveLength(0);
  });
});

describe("a merchant cannot write through the client", () => {
  it("cannot insert, update or delete", async () => {
    const insert = await clientA.from("inquiries").insert({ merchant_id: chainA.merchantId });
    expect(codeOf(insert)).toBe(SQLSTATE.denied);

    const update = await clientA.from("products").update({ name: "hacked" }).eq("id", productA);
    expect(codeOf(update)).toBe(SQLSTATE.denied);

    const del = await clientA.from("messages").delete().eq("inquiry_id", chainA.inquiryId);
    expect(codeOf(del)).toBe(SQLSTATE.denied);

    const stock = await clientA.from("stock").update({ on_hand: 9999 }).eq("product_id", productA);
    expect(codeOf(stock)).toBe(SQLSTATE.denied);

    const name = must(await admin.from("products").select("name").eq("id", productA).single());
    expect(name.name).toBe("p");
  });

  it("cannot call demo_reset", async () => {
    const result = await clientA.rpc("demo_reset");
    expect(codeOf(result)).toBe(SQLSTATE.denied);
    expect(must(await admin.from("merchants").select("id").eq("id", chainA.merchantId))).toHaveLength(1);
  });

  it("cannot call demo_reset anonymously either", async () => {
    expect(codeOf(await anonClient().rpc("demo_reset"))).toBe(SQLSTATE.denied);
  });
});
