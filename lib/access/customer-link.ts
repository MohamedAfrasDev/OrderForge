import { createHmac, timingSafeEqual } from "node:crypto";

// Token format: base64url(JSON {i: inquiryId, v: version, e: expiryMs}) + "." + base64url(HMAC-SHA256).
// Revocation: bump the inquiry's stored version and pass it as expectedVersion on verify.

const MIN_SECRET_LENGTH = 16;
const INQUIRY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type CreateInput = {
  inquiryId: string;
  version: number;
  expiresAt: Date;
  secret: string;
};

export type VerifyOptions = {
  secret: string;
  now?: Date;
  expectedVersion?: number;
};

export type VerifyResult =
  | { ok: true; inquiryId: string; version: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "revoked" };

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error("access link secret is too short");
  }
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function createCustomerLink(input: CreateInput): string {
  assertSecret(input.secret);
  if (!INQUIRY_ID.test(input.inquiryId)) throw new Error("invalid inquiry id");
  if (!Number.isSafeInteger(input.version) || input.version < 0) throw new Error("invalid version");

  const payload = Buffer.from(
    JSON.stringify({ i: input.inquiryId, v: input.version, e: input.expiresAt.getTime() }),
  ).toString("base64url");
  return `${payload}.${sign(payload, input.secret).toString("base64url")}`;
}

export function verifyCustomerLink(token: string, options: VerifyOptions): VerifyResult {
  assertSecret(options.secret);

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, signature] = parts;

  // Check the signature before parsing anything, comparing in constant time.
  const given = Buffer.from(signature, "base64url");
  const expected = sign(payload, options.secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims !== "object" || claims === null) return { ok: false, reason: "malformed" };
  const { i, v, e } = claims as Record<string, unknown>;
  if (
    typeof i !== "string" ||
    !INQUIRY_ID.test(i) ||
    typeof v !== "number" ||
    !Number.isSafeInteger(v) ||
    typeof e !== "number" ||
    !Number.isFinite(e)
  ) {
    return { ok: false, reason: "malformed" };
  }

  if ((options.now ?? new Date()).getTime() >= e) return { ok: false, reason: "expired" };
  if (options.expectedVersion !== undefined && v !== options.expectedVersion) {
    return { ok: false, reason: "revoked" };
  }
  return { ok: true, inquiryId: i, version: v };
}
