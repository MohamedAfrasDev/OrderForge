import { describe, expect, it } from "vitest";
import { EnvError, parseAccessLinkSecret, parseClientEnv, parseServerEnv } from "@/lib/env-schema";

const SECRET = "s3cr3t-value-that-must-never-leak-0123456789";

const validServer = {
  SANDBOX_MODE: "true",
  APP_BASE_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: SECRET,
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "client-id",
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: "client-id",
  PAYPAL_CLIENT_SECRET: SECRET,
  PAYPAL_WEBHOOK_ID: "webhook-id",
  OPENROUTER_API_KEY: SECRET,
  ACCESS_LINK_SECRET: SECRET,
  CRON_SECRET: SECRET,
};

function errorOf(fn: () => unknown): EnvError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EnvError);
    return e as EnvError;
  }
  throw new Error("expected EnvError");
}

describe("parseServerEnv", () => {
  it("accepts a complete valid environment", () => {
    const env = parseServerEnv(validServer);
    expect(env.PAYPAL_ENV).toBe("sandbox");
    expect(env.SANDBOX_MODE).toBe(true);
    expect(env.APP_BASE_URL).toBe("http://localhost:3000");
  });

  it("names every missing variable and never includes values", () => {
    const rest: Record<string, string> = { ...validServer };
    delete rest.CRON_SECRET;
    delete rest.PAYPAL_WEBHOOK_ID;
    const err = errorOf(() => parseServerEnv(rest));
    expect(err.variables.sort()).toEqual(["CRON_SECRET", "PAYPAL_WEBHOOK_ID"]);
    expect(err.message).toContain("CRON_SECRET");
    expect(err.message).not.toContain(SECRET);
  });

  it("the email variables are optional, and empty counts as unset", () => {
    const bare = parseServerEnv(validServer);
    expect([bare.RESEND_API_KEY, bare.EMAIL_FROM, bare.EMAIL_REPLY_TO]).toEqual([undefined, undefined, undefined]);
    const empty = parseServerEnv({ ...validServer, RESEND_API_KEY: "", EMAIL_FROM: "", EMAIL_REPLY_TO: "" });
    expect([empty.RESEND_API_KEY, empty.EMAIL_FROM, empty.EMAIL_REPLY_TO]).toEqual([undefined, undefined, undefined]);
  });

  it("accepts a key, a sender (plain or with a name) and a reply address", () => {
    for (const from of ["onboarding@resend.dev", "OrderForge Demo <onboarding@resend.dev>"]) {
      const env = parseServerEnv({ ...validServer, RESEND_API_KEY: "re_abcdefgh12345678", EMAIL_FROM: from, EMAIL_REPLY_TO: "shop@example.com" });
      expect(env).toMatchObject({ RESEND_API_KEY: "re_abcdefgh12345678", EMAIL_FROM: from, EMAIL_REPLY_TO: "shop@example.com" });
    }
  });

  it("refuses malformed email settings by name, without showing their values", () => {
    for (const [name, value] of [["RESEND_API_KEY", "short"], ["RESEND_API_KEY", "has a space in it 12345"], ["EMAIL_FROM", "not an address"], ["EMAIL_FROM", "Name <a@b.c>\r\nBcc: x@y.z"], ["EMAIL_REPLY_TO", "Name <a@b.c>"]] as const) {
      const err = errorOf(() => parseServerEnv({ ...validServer, [name]: value }));
      expect(err.variables, `${name}=${value}`).toEqual([name]);
      expect(err.message).not.toContain(value);
    }
  });

  it("refuses PAYPAL_ENV=live", () => {
    const err = errorOf(() => parseServerEnv({ ...validServer, PAYPAL_ENV: "live" }));
    expect(err.variables).toEqual(["PAYPAL_ENV"]);
    expect(err.message).not.toContain("live");
  });

  it.each(["false", "", "1", "TRUE"])("refuses SANDBOX_MODE=%j", (v) => {
    const err = errorOf(() => parseServerEnv({ ...validServer, SANDBOX_MODE: v }));
    expect(err.variables).toEqual(["SANDBOX_MODE"]);
  });

  it("rejects a malformed URL without echoing it", () => {
    const bad = "not-a-url-with-secret-" + SECRET;
    const err = errorOf(() => parseServerEnv({ ...validServer, APP_BASE_URL: bad }));
    expect(err.variables).toEqual(["APP_BASE_URL"]);
    expect(err.message).not.toContain(SECRET);
  });

  it("rejects empty and too-short secrets", () => {
    const err = errorOf(() =>
      parseServerEnv({ ...validServer, PAYPAL_CLIENT_SECRET: "", ACCESS_LINK_SECRET: "short" }),
    );
    expect(err.variables.sort()).toEqual(["ACCESS_LINK_SECRET", "PAYPAL_CLIENT_SECRET"]);
  });
});

describe("parseClientEnv", () => {
  const validClient = {
    NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    NEXT_PUBLIC_PAYPAL_CLIENT_ID: "client-id",
  };

  it("accepts only the public variables", () => {
    expect(parseClientEnv(validClient)).toEqual(validClient);
  });

  it("ignores server secrets even if present in the source", () => {
    const parsed = parseClientEnv({ ...validClient, SUPABASE_SERVICE_ROLE_KEY: SECRET });
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it("names missing public variables", () => {
    const err = errorOf(() => parseClientEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" }));
    expect(err.variables.sort()).toEqual([
      "NEXT_PUBLIC_PAYPAL_CLIENT_ID",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ]);
  });
});

describe("parseAccessLinkSecret", () => {
  it("returns a long enough secret", () => {
    expect(parseAccessLinkSecret({ ACCESS_LINK_SECRET: SECRET })).toBe(SECRET);
  });

  it.each([undefined, "", "short"])("rejects %j and names only the variable", (value) => {
    const err = errorOf(() => parseAccessLinkSecret({ ACCESS_LINK_SECRET: value }));
    expect(err.variables).toEqual(["ACCESS_LINK_SECRET"]);
    expect(err.message).not.toContain(String(value || "zzz-never"));
  });
});
