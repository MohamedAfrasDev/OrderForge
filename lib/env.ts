import "server-only";
import { parseServerEnv, type ServerEnv } from "@/lib/env-schema";

let cached: ServerEnv | undefined;

/** Validated server environment. Parsed lazily so `next build` does not need real secrets. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
