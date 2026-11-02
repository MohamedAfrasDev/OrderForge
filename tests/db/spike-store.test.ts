// Evidence label: PayPal side MOCKED (tests/support/fake-paypal.ts); the database side is real Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPayPalClient } from "@/lib/paypal/client";
import { createSpikeOrder, finishSpike } from "@/lib/paypal/spike";
import { spikeStore } from "@/lib/paypal/spike-store";
import { startFakePayPal, type FakePayPal } from "../support/fake-paypal";
import { must, serviceClient, unique } from "./helpers";

const db = serviceClient();
let fake: FakePayPal;

beforeAll(async () => {
  fake = await startFakePayPal();
});
afterAll(async () => {
  await fake.close();
});

describe("spike evidence in Postgres", () => {
  it("stores one payment_events row and one audit_events row per step, labeled and without secrets", async () => {
    const correlationId = unique("spike-corr");
    const store = spikeStore(db);
    const deps = {
      client: createPayPalClient({
        env: "sandbox",
        clientId: "db-spike-client",
        clientSecret: "db-spike-secret-value-123456",
        baseUrl: fake.url,
      }),
      recordEvent: store.recordEvent,
      insertAudit: store.insertAudit,
      evidenceLabel: "mocked" as const,
      correlationId,
      actor: "db-test",
    };

    const created = await createSpikeOrder(deps);
    fake.approve(created.orderId!);
    const report = await finishSpike(deps, { orderId: created.orderId!, mode: "capture" });
    expect(report.ok).toBe(true);

    const events = must(
      await db.from("payment_events").select("event_type, source, evidence_label, payload, provider_event_id, payment_attempt_id")
        .eq("payload->>order_id", created.orderId!).order("created_at", { ascending: true }),
    );
    expect(events.map((e: { event_type: string }) => e.event_type).sort()).toEqual(
      ["spike.authorized", "spike.captured", "spike.order_created"].sort(),
    );
    for (const e of events) {
      expect(e).toMatchObject({ source: "spike", evidence_label: "mocked", provider_event_id: null, payment_attempt_id: null });
    }

    const audits = must(await db.from("audit_events").select("action, actor, entity, entity_id, data").eq("correlation_id", correlationId));
    expect(audits.map((a: { action: string }) => a.action).sort()).toEqual(
      ["spike.authorized", "spike.captured", "spike.order_created"].sort(),
    );
    expect(audits.every((a: { actor: string; entity: string }) => a.actor === "db-test" && a.entity === "paypal_spike")).toBe(true);

    const everything = JSON.stringify({ events, audits });
    expect(everything).not.toContain("db-spike-secret-value-123456");
    expect(everything).not.toContain("fake-access-token");
  });
});
