import type { PromptMessage } from "@/domain/intake";
import type { ModelFailure, ModelKind, ModelPort, ModelRequest, ModelResult } from "./model";

/** One scripted step: a raw JSON answer, a failure, or a function that builds the answer from the request. */
export type FakeStep = unknown;

export type FakeModelScript = {
  answers: Partial<Record<ModelKind, FakeStep[]>>;
  /** The model id reported as having answered. */
  model?: string;
};

export type FakeModel = ModelPort & { requests: Array<{ kind: ModelKind; messages: PromptMessage[] }> };

const isFailure = (step: unknown): step is { fail: ModelFailure } =>
  typeof step === "object" && step !== null && Object.keys(step).length === 1 && "fail" in step;

/**
 * A scripted stand-in for the provider, for tests and for the local end-to-end server (never selectable on a hosted
 * deployment). Each call takes the next step for its kind. It models the final outcome of the real client, so it does not
 * retry: a raw answer is run through the request's own `parse` (a bad one is MALFORMED), `{ fail }` is that failure, and
 * running out of steps is a provider failure. Every request is recorded.
 */
export function createFakeModel(script: FakeModelScript): FakeModel {
  const queues = new Map<ModelKind, FakeStep[]>(Object.entries(script.answers).map(([k, v]) => [k as ModelKind, [...(v ?? [])]]));
  const model = script.model ?? "fake-model";
  const requests: FakeModel["requests"] = [];

  return {
    requests,
    async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      requests.push({ kind: request.kind, messages: request.messages.map((m) => ({ ...m })) });
      const queue = queues.get(request.kind);
      if (!queue || queue.length === 0) return { ok: false, failure: "PROVIDER_FAILURE", model, detail: "no scripted answer", calls: 1 };

      let step = queue.shift();
      if (typeof step === "function") step = (step as (r: ModelRequest<T>) => unknown)(request);
      if (isFailure(step)) return { ok: false, failure: step.fail, model, detail: "scripted failure", calls: 1 };

      const parsed = request.parse(step);
      if (parsed.ok) return { ok: true, value: parsed.value, model, calls: 1 };
      return { ok: false, failure: "MALFORMED", model, detail: "the scripted answer was not usable", errors: parsed.errors, calls: 1 };
    },
  };
}
