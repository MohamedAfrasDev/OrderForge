import { describe, expect, it } from "vitest";
import { QUOTE_EVENTS, QUOTE_STATUSES, transition } from "@/domain/quote/state";
import type { QuoteStatus } from "@/domain/quote/types";
import { codeOf, must, randomHash, serviceClient, SQLSTATE } from "./helpers";
import { newInquiry, NOW } from "./quote-helpers";

const db = serviceClient();

// Evidence label for this file: real Postgres (local Supabase), not mocked.

/** A quote row in the given status, on its own inquiry (so the one-live-quote index never interferes). */
async function quoteIn(status: QuoteStatus): Promise<{ id: string; hash: string | null; inquiryId: string }> {
  const { inquiryId } = await newInquiry(db);
  const hash = status === "DRAFT" || status === "WITHDRAWN" ? null : randomHash();
  const row = must(
    await db
      .from("quote_versions")
      .insert({
        inquiry_id: inquiryId,
        version: 1,
        status,
        lines: { boxCount: 1, perBoxMinor: 1, lines: [] },
        total_minor: 1,
        quote_hash: hash,
        published_at: status === "DRAFT" ? null : NOW,
      })
      .select("id")
      .single(),
    `insert ${status}`,
  );
  return { id: row.id, hash, inquiryId };
}

describe("quote status transitions match the TypeScript table", () => {
  const legalTargets = (from: QuoteStatus): Set<QuoteStatus> => {
    const out = new Set<QuoteStatus>();
    for (const event of QUOTE_EVENTS) {
      const to = transition(from, event);
      if (typeof to === "string") out.add(to);
    }
    return out;
  };

  const pairs = QUOTE_STATUSES.flatMap((from) => QUOTE_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const));

  it.each(pairs)("%s to %s", async (from, to) => {
    const q = await quoteIn(from);
    const result = await db
      .from("quote_versions")
      .update({ status: to, quote_hash: q.hash ?? randomHash() })
      .eq("id", q.id);
    const allowed = legalTargets(from).has(to);
    if (allowed) {
      expect(codeOf(result), `${from} -> ${to} should be allowed`).toBe("none");
    } else {
      // A forbidden pair is refused by the guard trigger, or (for a DRAFT that would also change its hash) by it first.
      expect(codeOf(result), `${from} -> ${to} should be refused`).toBe(SQLSTATE.raised);
    }
  });
});

describe("immutability", () => {
  it("rejects a move from ACCEPTED back to PUBLISHED, the gap in the foundation trigger", async () => {
    const q = await quoteIn("ACCEPTED");
    expect(codeOf(await db.from("quote_versions").update({ status: "PUBLISHED" }).eq("id", q.id))).toBe(SQLSTATE.raised);
  });

  it("rejects DRAFT straight to ACCEPTED", async () => {
    const q = await quoteIn("DRAFT");
    const r = await db.from("quote_versions").update({ status: "ACCEPTED", quote_hash: randomHash() }).eq("id", q.id);
    expect(codeOf(r)).toBe(SQLSTATE.raised);
  });

  it("allows a DRAFT to be withdrawn without a hash", async () => {
    const q = await quoteIn("DRAFT");
    expect(codeOf(await db.from("quote_versions").update({ status: "WITHDRAWN" }).eq("id", q.id))).toBe("none");
  });

  it("still allows a DRAFT to be edited freely", async () => {
    const q = await quoteIn("DRAFT");
    expect(codeOf(await db.from("quote_versions").update({ total_minor: 99 }).eq("id", q.id))).toBe("none");
  });

  it.each([
    ["total_minor", { total_minor: 2 }],
    ["lines", { lines: { boxCount: 9, perBoxMinor: 9, lines: [] } }],
    ["quote_hash", { quote_hash: "b".repeat(64) }],
    ["pending_conditions", { pending_conditions: [{ code: "ARTWORK_ACCEPTANCE", text: "x" }] }],
    ["published_at", { published_at: "2030-01-01T00:00:00Z" }],
  ])("rejects an edit of %s on an ACCEPTED quote", async (_name, patch) => {
    const q = await quoteIn("ACCEPTED");
    expect(codeOf(await db.from("quote_versions").update(patch).eq("id", q.id))).toBe(SQLSTATE.raised);
  });

  it("rejects an edit of a PUBLISHED quote's lines and deleting it", async () => {
    const q = await quoteIn("PUBLISHED");
    expect(codeOf(await db.from("quote_versions").update({ lines: {} }).eq("id", q.id))).toBe(SQLSTATE.raised);
    expect(codeOf(await db.from("quote_versions").delete().eq("id", q.id))).toBe(SQLSTATE.raised);
  });

  it("approvals can be neither changed nor removed", async () => {
    const { inquiryId } = await newInquiry(db);
    const hash = randomHash();
    const quote = must(
      await db
        .from("quote_versions")
        .insert({ inquiry_id: inquiryId, version: 1, status: "ACCEPTED", lines: {}, total_minor: 1, quote_hash: hash, published_at: NOW })
        .select("id")
        .single(),
    );
    const approval = must(
      await db.from("approvals").insert({ quote_version_id: quote.id, quote_hash: hash, terms_text: "t" }).select("id").single(),
    );
    expect(codeOf(await db.from("approvals").update({ terms_text: "changed" }).eq("id", approval.id))).toBe(SQLSTATE.raised);
    expect(codeOf(await db.from("approvals").delete().eq("id", approval.id))).toBe(SQLSTATE.raised);
  });
});
