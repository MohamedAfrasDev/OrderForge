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
