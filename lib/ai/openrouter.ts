import type { ModelPort, ModelRequest, ModelResult, WireMessage } from "./model";

/** A free model first (chosen among the free candidates by the evaluation run). */
export const DEFAULT_PRIMARY_MODEL = "google/gemma-4-31b-it:free";
/** A low-cost paid model, asked only after a provider failure of the primary. */
export const DEFAULT_FALLBACK_MODEL = "openai/gpt-oss-120b";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const MODEL_ID = /^[A-Za-z0-9._\-/:~]{1,100}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_RETRY_ECHO = 2000;

export type OpenRouterConfig = {
  apiKey: string;
  /** The primary model. Must be a free (":free") model unless `allowPaidPrimary` is set. */
  model: string;
  /** Asked only after a provider failure of the primary, never to retry an answer that was bad. */
  fallbackModel?: string;
  allowPaidPrimary?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

function checkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OpenRouter base URL is not a URL");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  const openrouter = url.protocol === "https:" && url.hostname === "openrouter.ai";
  if (!openrouter && !local) throw new Error("OpenRouter host not allowed: the key is only sent to openrouter.ai or a local fake");
  return url.toString().replace(/\/+$/, "");
}

type Attempt =
  | { kind: "content"; content: string }
  | { kind: "provider"; failure: "PROVIDER_FAILURE" | "TIMEOUT"; detail: string; fatal: boolean };

/**
 * The OpenRouter chat completions API with structured output, over plain `fetch`, with a timeout on every request.
 *  - A bad answer (not JSON, fails `parse`) is retried once on the same model with the reasons; if it is bad again the
 *    result is MALFORMED. The fallback model is never used to second-guess a model that answered badly.
 *  - A provider failure (network error, timeout, 408, 429, 5xx, a model that is gone, an error inside a 200) goes to the
 *    fallback model once, which gets its own single retry for a bad answer. 401 and 403 stop at once: the fallback would use
 *    the same key.
 *  - At most four requests leave for one question. The key goes only into the Authorization header, never into a result.
 */
export function createOpenRouterModel(config: OpenRouterConfig): ModelPort {
  if (!config.apiKey) throw new Error("OpenRouter API key is missing");
  if (!MODEL_ID.test(config.model)) throw new Error("OpenRouter model id is not valid");
  if (config.fallbackModel !== undefined && !MODEL_ID.test(config.fallbackModel)) throw new Error("OpenRouter fallback model id is not valid");
  if (!config.model.endsWith(":free") && !config.allowPaidPrimary) {
    throw new Error("the primary model must be a free (:free) model; a paid primary needs allowPaidPrimary");
  }
  const baseUrl = checkBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetch ?? globalThis.fetch;

  async function attempt<T>(model: string, request: ModelRequest<T>, messages: WireMessage[]): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          max_tokens: 1200,
          response_format: { type: "json_schema", json_schema: { name: request.kind, strict: true, schema: request.jsonSchema } },
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        return { kind: "provider", failure: "PROVIDER_FAILURE", detail: `HTTP ${response.status}`, fatal: response.status === 401 || response.status === 403 };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { kind: "content", content: "" };
      }
      const record = body as { error?: { code?: unknown }; choices?: Array<{ message?: { content?: unknown } }> };
      if (record.error) {
        const code = typeof record.error.code === "number" ? ` ${record.error.code}` : "";
        return { kind: "provider", failure: "PROVIDER_FAILURE", detail: `provider error${code}`, fatal: false };
      }
      const content = record.choices?.[0]?.message?.content;
      return { kind: "content", content: typeof content === "string" ? content : "" };
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      return aborted
        ? { kind: "provider", failure: "TIMEOUT", detail: "timeout", fatal: false }
        : { kind: "provider", failure: "PROVIDER_FAILURE", detail: "network error", fatal: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One model: the question, and at most one retry of a bad answer. Returns a final result or the provider failure. */
  async function runOn<T>(model: string, request: ModelRequest<T>, counter: { calls: number }): Promise<{ done: ModelResult<T> } | { provider: Extract<Attempt, { kind: "provider" }> }> {
    let messages: WireMessage[] = request.messages;
    for (let round = 0; round < 2; round++) {
      counter.calls += 1;
      const a = await attempt(model, request, messages);
      if (a.kind === "provider") return { provider: a };

      const errors = judge(a.content);
      if (errors.length === 0) {
        const parsed = request.parse(parseJson(a.content));
        if (parsed.ok) return { done: { ok: true, value: parsed.value, model, calls: counter.calls } };
        errors.push(...parsed.errors);
      }
      if (round === 1) return { done: { ok: false, failure: "MALFORMED", model, detail: "the model's answer was not usable", errors, calls: counter.calls } };
      messages = [
        ...request.messages,
        { role: "assistant", content: a.content.slice(0, MAX_RETRY_ECHO) || "(empty)" },
        { role: "user", content: `Your previous answer was invalid: ${errors.join("; ")}. Answer again with only the JSON object that matches the schema.` },
      ];
    }
    throw new Error("unreachable");
  }

  return {
    async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      const counter = { calls: 0 };
      const first = await runOn(config.model, request, counter);
      if ("done" in first) return first.done;

      const canFallBack = !first.provider.fatal && config.fallbackModel !== undefined && config.fallbackModel !== config.model;
      if (!canFallBack) return { ok: false, failure: first.provider.failure, model: config.model, detail: first.provider.detail, calls: counter.calls };

      const second = await runOn(config.fallbackModel as string, request, counter);
      if ("done" in second) return second.done;
      return { ok: false, failure: second.provider.failure, model: config.fallbackModel as string, detail: second.provider.detail, calls: counter.calls };
    },
  };
}

/** Models often wrap JSON in a code fence. */
function parseJson(content: string): unknown {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(content.trim());
  return JSON.parse(fenced ? fenced[1]! : content.trim());
}

/** Reasons the content cannot even be read as JSON; empty when it can. */
function judge(content: string): string[] {
  if (content.trim() === "") return ["the answer was empty"];
  try {
    parseJson(content);
    return [];
  } catch {
    return ["the answer was not valid JSON"];
  }
}
