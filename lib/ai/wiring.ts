import "server-only";
import { getServerEnv } from "@/lib/env";
import { createLocalDemoModel, localDemoAllowed } from "./local-demo";
import type { ModelPort } from "./model";
import { openRouterConfigFromEnv } from "./config";
import { createOpenRouterModel } from "./openrouter";

let model: ModelPort | undefined;

/** The intake model: OpenRouter (free primary, low-cost paid fallback), or the local stand-in when INTAKE_MODEL=local-demo on a local host. */
export function getIntakeModel(): ModelPort {
  if (model) return model;
  const env = getServerEnv();
  if (env.INTAKE_MODEL === "local-demo") {
    if (!localDemoAllowed(env.NEXT_PUBLIC_SUPABASE_URL, Boolean(process.env.VERCEL))) throw new Error("INTAKE_MODEL=local-demo is only allowed with a local database and outside Vercel");
    model = createLocalDemoModel();
  } else {
    model = createOpenRouterModel(openRouterConfigFromEnv(env));
  }
  return model;
}
