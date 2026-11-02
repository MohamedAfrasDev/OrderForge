// Evidence label: real Postgres (local Supabase). PayPal is not involved.
import { describe, expect, it } from "vitest";
import { recordPaymentEvent } from "@/lib/paypal/webhook-store";
import type { PaymentEventRow } from "@/lib/paypal/webhook-handler";
import { must, serviceClient, unique } from "./helpers";

const db = serviceClient();

const row = (id: string, overrides: Partial<PaymentEventRow> = {}): PaymentEventRow => ({
  provider_event_id: id,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  source: "webhook",
  evidence_label: "replayed",
  payload: { resource_id: "CAP-1", amount_minor: 108000 },
  ...overrides,
});

describe("recordPaymentEvent", () => {
  it("records a new event", async () => {
    const id = unique("WH");
    expect(await recordPaymentEvent(db, row(id))).toBe("recorded");

    const stored = must(await db.from("payment_events").select("*").eq("provider_event_id", id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      source: "webhook",
      evidence_label: "replayed",
      payload: { resource_id: "CAP-1", amount_minor: 108000 },
    });
  });

  it("reports a redelivery as a duplicate and leaves exactly one row", async () => {
    const id = unique("WH");
    expect(await recordPaymentEvent(db, row(id))).toBe("recorded");
    expect(await recordPaymentEvent(db, row(id))).toBe("duplicate");
    expect(await recordPaymentEvent(db, row(id))).toBe("duplicate");

    expect(must(await db.from("payment_events").select("id").eq("provider_event_id", id))).toHaveLength(1);
  });

  it("survives a burst of simultaneous redeliveries with one row and no failures", async () => {
    const id = unique("WH");
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => recordPaymentEvent(db, row(id))));
    expect(outcomes.filter((o) => o === "recorded")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(9);
    expect(must(await db.from("payment_events").select("id").eq("provider_event_id", id))).toHaveLength(1);
  });

  it("throws, rather than reporting success, for any other database failure", async () => {
    const bad = row(unique("WH"), { evidence_label: "trust-me" as PaymentEventRow["evidence_label"] });
    await expect(recordPaymentEvent(db, bad)).rejects.toThrow(/payment_events insert failed/);
  });
});
