import type { PromptMessage } from "@/domain/intake";

export type ModelKind = "extract" | "ask" | "propose" | "rank";

/** What kind of failure it was. A provider failure is the provider's fault (down, slow, limited); MALFORMED is the model's. */
export type ModelFailure = "PROVIDER_FAILURE" | "TIMEOUT" | "MALFORMED";

/** The messages that go on the wire: a retry also echoes the model's own earlier answer. */
export type WireMessage = { role: "system" | "user" | "assistant"; content: string };

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * One question for the model. `parse` turns its raw JSON answer into a value or lists every problem (so one retry can fix
 * them all); `jsonSchema` is the shape asked for through the provider's structured output.
 */
export type ModelRequest<T> = {
  kind: ModelKind;
  messages: PromptMessage[];
  jsonSchema: Record<string, unknown>;
  parse: (raw: unknown) => ParseOutcome<T>;
};

/**
 * `calls` counts every request that left for the provider, a retry or a fallback included, so the caller can keep to its
 * budget. `model` is the model that answered (or the last one asked). `detail` is short and never holds a key or a body.
 */
export type ModelResult<T> =
  | { ok: true; value: T; model: string; calls: number }
  | { ok: false; failure: ModelFailure; model: string | null; detail: string; errors?: string[]; calls: number };

export interface ModelPort {
  complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>>;
}
