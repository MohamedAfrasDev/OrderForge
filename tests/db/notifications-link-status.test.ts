// Real local Postgres: what "Keep this page" may say about the email of the link.
import { describe, expect, it } from "vitest";
import { linkEmailStatus } from "@/services/notifications/read";
import { must, serviceClient, unique } from "./helpers";
import { newMerchant } from "./intake-helpers";

const db = serviceClient();

async function inquiryWith(status: string | null) {
  const m = await newMerchant(db);
  const i = must(await db.from("inquiries").insert({ merchant_id: m.id, customer_email: "sam@example.com" }).select("id").single());
  if (status) {
    must(await db.from("notifications").insert({ inquiry_id: i.id, recipient: "customer", kind: "request_started", dedupe_key: unique("request_started"), status, ...(status === "SENT" ? { sent_at: "2026-11-05T10:00:00Z" } : {}) }));
  }
  return i.id as string;
}

describe("linkEmailStatus", () => {
  it("says sent when the saved-link email went out, and pending while it is on its way", async () => {
    expect(await linkEmailStatus(db, await inquiryWith("SENT"))).toBe("sent");
    expect(await linkEmailStatus(db, await inquiryWith("PENDING"))).toBe("pending");
  });

  it("says nothing when it was skipped or failed, or when there is no such email, so the page never promises one that is not coming", async () => {
    for (const status of ["SKIPPED", "FAILED", null]) expect(await linkEmailStatus(db, await inquiryWith(status)), String(status)).toBeNull();
  });

  it("looks only at the request's own email, and does not look at other emails of the request", async () => {
    const id = await inquiryWith(null);
    must(await db.from("notifications").insert({ inquiry_id: id, recipient: "customer", kind: "price_ready", dedupe_key: unique("price_ready"), status: "SENT", sent_at: "2026-11-05T10:00:00Z" }));
    expect(await linkEmailStatus(db, id)).toBeNull();
  });
});
