import { z } from "zod";

/** Thrown for invalid configuration. Carries variable names only, never values. */
export class EnvError extends Error {
  constructor(readonly variables: string[]) {
    super(`Invalid environment configuration. Check these variables: ${variables.join(", ")}`);
    this.name = "EnvError";
  }
}

const nonEmpty = z.string().min(1);
const secret = z.string().min(16);

const clientShape = {
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: nonEmpty,
};

const serverSchema = z.object({
  ...clientShape,
  SANDBOX_MODE: z.literal("true").transform(() => true as const),
  APP_BASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: secret,
  PAYPAL_ENV: z.literal("sandbox"),
  PAYPAL_CLIENT_ID: nonEmpty,
  PAYPAL_CLIENT_SECRET: secret,
  PAYPAL_WEBHOOK_ID: nonEmpty,
  OPENROUTER_API_KEY: nonEmpty,
  ACCESS_LINK_SECRET: secret,
  CRON_SECRET: secret,
  // Optional: point the PayPal spike at a local fake server (see lib/paypal/client.ts for what is accepted).
  PAYPAL_SPIKE_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()),
  // Optional: the OpenRouter models for intake. The primary is a free (:free) model, the fallback a low-cost paid one that is
  // asked only after a provider failure. Unset means the defaults in lib/ai/openrouter.ts.
  OPENROUTER_MODEL: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[A-Za-z0-9._/:~-]{1,100}$/).optional()),
  OPENROUTER_FALLBACK_MODEL: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[A-Za-z0-9._/:~-]{1,100}$/).optional()),
  // Optional: "local-demo" swaps the intake model for a rule-based stand-in. Refused unless the database is local and the app is not on Vercel.
  INTAKE_MODEL: z.preprocess((v) => (v === "" ? undefined : v), z.literal("local-demo").optional()),
  // Optional: email through Resend. Sending is off unless both the key and the sender are set; empty counts as unset. Never set in tests or CI.
  RESEND_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(8).max(200).regex(/^\S+$/).optional()),
  EMAIL_FROM: z.preprocess((v) => (v === "" ? undefined : v), z.string().max(200).regex(/^([^<>\r\n@]{1,80} <[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/).optional()),
  EMAIL_REPLY_TO: z.preprocess((v) => (v === "" ? undefined : v), z.string().max(254).regex(/^[^\s@<>]+@[^\s@<>]+$/).optional()),
  // Optional: when set, a capture must have been paid to this PayPal merchant id (payments module).
  PAYPAL_PAYEE_MERCHANT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[A-Za-z0-9]{1,32}$/).optional()),
});

const clientSchema = z.object(clientShape);

export type ServerEnv = z.infer<typeof serverSchema>;
export type ClientEnv = z.infer<typeof clientSchema>;

function parse<T extends z.ZodType>(schema: T, source: Record<string, string | undefined>): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const names = new Set(result.error.issues.map((i) => String(i.path[0] ?? "(unknown)")));
  throw new EnvError([...names]);
}

export const parseServerEnv = (source: Record<string, string | undefined>): ServerEnv =>
  parse(serverSchema, source);

export const parseClientEnv = (source: Record<string, string | undefined>): ClientEnv =>
  parse(clientSchema, source);

/** Only the link-signing secret, for code (like proxy.ts) that must not require the whole server environment. */
export function parseAccessLinkSecret(source: Record<string, string | undefined>): string {
  const result = secret.safeParse(source.ACCESS_LINK_SECRET);
  if (!result.success) throw new EnvError(["ACCESS_LINK_SECRET"]);
  return result.data;
}
