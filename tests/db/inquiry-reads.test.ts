import { beforeAll, describe, expect, it } from "vitest";
import { createCustomerLink } from "@/lib/access/customer-link";
import {
  authorizeCustomerLink,
  findOwnedAsset,
  getCustomerMessages,
  getPublicMerchant,
  type VerifiedInquiryId,
} from "@/lib/access/inquiry-reads";
import { createChain, must, serviceClient, unique, type Chain } from "./helpers";

const db = serviceClient();
const SECRET = "db-test-secret-with-enough-length";
const NOW = new Date("2026-11-05T12:00:00Z");
const HOUR = 60 * 60 * 1000;

let a: Chain;
let b: Chain;
let assetB: string;

const tokenFor = (inquiryId: string, version = 1, expiresAt = new Date(NOW.getTime() + HOUR)) =>
  createCustomerLink({ inquiryId, version, expiresAt, secret: SECRET });

const authorize = (token: string) => authorizeCustomerLink(db, token, { secret: SECRET, now: NOW });

async function verified(chain: Chain): Promise<VerifiedInquiryId> {
  const result = await authorize(tokenFor(chain.inquiryId));
  if (!result.ok) throw new Error("expected a valid link");
  return result.inquiry.id;
}

beforeAll(async () => {
  a = await createChain(db);
  b = await createChain(db);
  must(
    await db.from("messages").insert([
      { inquiry_id: a.inquiryId, role: "customer", body: "message for A" },
      { inquiry_id: b.inquiryId, role: "customer", body: "message for B" },
    ]),
  );
  const asset = must(
    await db
      .from("assets")
      .insert({ inquiry_id: b.inquiryId, storage_path: unique("logos/b"), mime_type: "image/png", size_bytes: 10 })
      .select("id")
      .single(),
  );
  assetB = asset.id;
});

describe("authorizeCustomerLink", () => {
  it("opens the inquiry the link was issued for", async () => {
    const result = await authorize(tokenFor(a.inquiryId));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inquiry.id).toBe(a.inquiryId);
      expect(result.inquiry.status).toBe("NEW");
      expect(result.inquiry.merchantName).toBe("Test merchant");
    }
  });

  it("denies a tampered token", async () => {
    const [, sig] = tokenFor(a.inquiryId).split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ i: b.inquiryId, v: 1, e: NOW.getTime() + HOUR })).toString(
      "base64url",
    );
    expect(await authorize(`${forgedPayload}.${sig}`)).toEqual({ ok: false });
  });

  it("denies an expired token", async () => {
    expect(await authorize(tokenFor(a.inquiryId, 1, new Date(NOW.getTime() - 1)))).toEqual({ ok: false });
  });

  it("denies a signed token for an inquiry that does not exist", async () => {
    expect(await authorize(tokenFor("11111111-1111-4111-8111-111111111111"))).toEqual({ ok: false });
    expect(await authorize(tokenFor("not-a-uuid"))).toEqual({ ok: false });
  });

  it("denies a link after the inquiry's access version is bumped (revocation)", async () => {
    const own = await createChain(db);
    const old = tokenFor(own.inquiryId, 1);
    expect((await authorize(old)).ok).toBe(true);

    must(await db.from("inquiries").update({ access_version: 2 }).eq("id", own.inquiryId));
    expect(await authorize(old)).toEqual({ ok: false });
    expect((await authorize(tokenFor(own.inquiryId, 2))).ok).toBe(true);
  });

  it.each(["", "garbage", "a.b", "a.b.c"])("denies malformed token %j", async (token) => {
    expect(await authorize(token)).toEqual({ ok: false });
  });
});

describe("reads are scoped to the verified inquiry", () => {
  it("returns only that inquiry's messages", async () => {
    const messages = await getCustomerMessages(db, await verified(a));
    expect(messages.map((m) => m.body)).toEqual(["message for A"]);

    const forB = await getCustomerMessages(db, await verified(b));
    expect(forB.map((m) => m.body)).toEqual(["message for B"]);
  });

  it("finds an asset only through the inquiry that owns it", async () => {
    expect(await findOwnedAsset(db, await verified(a), assetB)).toBeNull();
    const own = await findOwnedAsset(db, await verified(b), assetB);
    expect(own?.id).toBe(assetB);
  });

  it("ignores a malformed asset id", async () => {
    expect(await findOwnedAsset(db, await verified(a), "not-a-uuid")).toBeNull();
  });
});

describe("getPublicMerchant", () => {
  it("returns only the public fields for a known slug", async () => {
    const slug = unique("pub");
    must(await db.from("merchants").insert({ slug, name: "Public Shop" }));
    expect(await getPublicMerchant(db, slug)).toEqual({ slug, name: "Public Shop" });
  });

  it("returns null for an unknown or malformed slug", async () => {
    expect(await getPublicMerchant(db, "does-not-exist-zz")).toBeNull();
    expect(await getPublicMerchant(db, "Bad Slug!")).toBeNull();
  });
});
