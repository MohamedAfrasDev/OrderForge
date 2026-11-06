import { createHmac, timingSafeEqual } from "node:crypto";

// The token an agent holds for the request it made. Same shape as the customer link, with three differences that matter:
//  - it is signed under its OWN key (the access secret run through a fixed label), so a customer link is not valid as one and the reverse;
//  - its claims carry kind "agent", checked on verify;
//  - it only ever lets the holder READ the request's proposals. Nothing in the app accepts it for anything else.
// Nothing is stored. Bumping the request's access version revokes it, like the customer link.

const MIN_SECRET_LENGTH = 16;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_LABEL = "orderforge.agent-request.v1";

export type AgentTokenInput = { requestId: string; version: number; expiresAt: Date; secret: string };
export type AgentTokenOptions = { secret: string; now?: Date; expectedVersion?: number };
export type AgentTokenResult =
  | { ok: true; requestId: string; version: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "revoked" };

function keyFor(secret: string): Buffer {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error("access link secret is too short");
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

const sign = (payload: string, secret: string): Buffer => createHmac("sha256", keyFor(secret)).update(payload).digest();

export function createAgentToken(input: AgentTokenInput): string {
  if (!REQUEST_ID.test(input.requestId)) throw new Error("invalid request id");
  if (!Number.isSafeInteger(input.version) || input.version < 0) throw new Error("invalid version");
  const payload = Buffer.from(JSON.stringify({ i: input.requestId, v: input.version, e: input.expiresAt.getTime(), k: "agent" })).toString("base64url");
  return `${payload}.${sign(payload, input.secret).toString("base64url")}`;
}

export function verifyAgentToken(token: string, options: AgentTokenOptions): AgentTokenResult {
  const key = sign("", options.secret); // throws on a short secret before anything is read
  void key;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, signature] = parts;

  const given = Buffer.from(signature, "base64url");
  const expected = sign(payload, options.secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims !== "object" || claims === null) return { ok: false, reason: "malformed" };
  const { i, v, e, k } = claims as Record<string, unknown>;
  if (k !== "agent" || typeof i !== "string" || !REQUEST_ID.test(i) || typeof v !== "number" || !Number.isSafeInteger(v) || typeof e !== "number" || !Number.isFinite(e)) {
    return { ok: false, reason: "malformed" };
  }
  if ((options.now ?? new Date()).getTime() >= e) return { ok: false, reason: "expired" };
  if (options.expectedVersion !== undefined && v !== options.expectedVersion) return { ok: false, reason: "revoked" };
  return { ok: true, requestId: i, version: v };
}
