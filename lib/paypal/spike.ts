// The PayPal "spike": prove authorize -> capture and authorize -> void work end to end, with every
// step recorded as evidence. It is a development tool (CLI and merchant dev page), not the payment
// flow: the payments module owns real purchases and their state machine.
//
// Relative imports with extensions and erasable syntax only, so Node can run it from scripts/.
import { audit } from "../audit.ts";
import type { AuditInsert } from "../audit.ts";
import { cents } from "../money.ts";
import type { PayPalClient } from "./client.ts";
import type { PayPalResult } from "./types.ts";

export type EvidenceLabel = "mocked" | "replayed" | "real-sandbox";
export type SpikeMode = "capture" | "void";
export type StepOutcome = "ok" | "failed" | "unknown";

/** Evidence label for a PayPal base URL: a local fake is "mocked", anything else is the real sandbox. */
export function evidenceLabelFor(baseUrl: string | undefined): EvidenceLabel {
  const host = baseUrl ? new URL(baseUrl).hostname : undefined;
  return host === "127.0.0.1" || host === "localhost" ? "mocked" : "real-sandbox";
}

/** Fixed demo amount: $10.80. Small on purpose, so sandbox buyers never run short. */
export const SPIKE_AMOUNT = cents(1080);

export type SpikeEventRow = {
  event_type: string;
  source: "spike";
  evidence_label: EvidenceLabel;
  payload: Record<string, string | number>;
};

export type SpikeDeps = {
  client: PayPalClient;
  recordEvent: (row: SpikeEventRow) => Promise<void>;
  insertAudit: AuditInsert;
  evidenceLabel: EvidenceLabel;
  correlationId: string;
  actor: string;
  /** Where PayPal sends the buyer after approving (the dev page). Required for the link-based approval flow. */
  approvalReturnUrl?: string;
  /** Source of the idempotency key for the order. Defaults to crypto.randomUUID. */
  newRequestId?: () => string;
};

export type SpikeStep = {
  step: string;
  outcome: StepOutcome;
  detail: string;
  evidence: EvidenceLabel;
};

export type SpikeReport = { steps: SpikeStep[]; ok: boolean };

type Data = Record<string, string | number>;

async function log(
  deps: SpikeDeps,
  steps: SpikeStep[],
  orderId: string,
  step: string,
  outcome: StepOutcome,
  detail: string,
  data: Data = {},
) {
  steps.push({ step, outcome, detail, evidence: deps.evidenceLabel });
  await deps.recordEvent({
    event_type: `spike.${step}`,
    source: "spike",
    evidence_label: deps.evidenceLabel,
    payload: { outcome, order_id: orderId, ...data },
  });
  await audit(deps.insertAudit, {
    actor: deps.actor,
    action: `spike.${step}`,
    entity: "paypal_spike",
    entityId: orderId,
    correlationId: deps.correlationId,
    data: { status: outcome },
  });
}

/** One line saying what a non-ok PayPal result means for what we do next. */
function describeFailure(result: Exclude<PayPalResult<unknown>, { kind: "ok" }>): string {
  switch (result.kind) {
    case "provider_error":
      return `PayPal refused (HTTP ${result.status}${result.errorName ? ` ${result.errorName}` : ""}${result.issues.length ? `: ${result.issues.join(", ")}` : ""})`;
    case "not_sent":
      return `nothing was sent (${result.reason}); safe to retry`;
    case "timeout":
      return `no answer (${result.cause}); the outcome is unknown`;
    case "malformed":
      return "PayPal answered but the reply was unreadable; the outcome is unknown";
  }
}

const isUnknown = (result: PayPalResult<unknown>) => result.kind === "timeout" || result.kind === "malformed";

export async function createSpikeOrder(
  deps: SpikeDeps,
): Promise<{ orderId?: string; approveUrl?: string; steps: SpikeStep[] }> {
  const steps: SpikeStep[] = [];
  const requestId = (deps.newRequestId ?? (() => crypto.randomUUID()))();
  const result = await deps.client.createOrder({
    amount: SPIKE_AMOUNT,
    referenceId: `spike-${requestId.slice(0, 8)}`,
    requestId,
    returnUrl: deps.approvalReturnUrl,
  });

  if (result.kind !== "ok") {
    await log(deps, steps, "none", "order_create_failed", isUnknown(result) ? "unknown" : "failed", describeFailure(result), { request_id: requestId });
    return { steps };
  }
  const { id, status, approveUrl } = result.data;
  await log(deps, steps, id, "order_created", "ok", `order ${id} is ${status}; the buyer must approve it`, {
    status,
    amount_minor: SPIKE_AMOUNT,
    request_id: requestId,
  });
  return { orderId: id, approveUrl, steps };
}

/** Poll until the buyer has approved the order. Used by the CLI; the dev page has a button instead. */
export async function waitForApproval(
  deps: SpikeDeps,
  orderId: string,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<SpikeStep[]> {
  const steps: SpikeStep[] = [];
  const { timeoutMs = 300_000, intervalMs = 3_000, now = Date.now } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;

  for (;;) {
    const result = await deps.client.getOrder(orderId);
    if (result.kind === "ok" && result.data.status === "APPROVED") {
      await log(deps, steps, orderId, "order_approved", "ok", "the buyer approved the order");
      return steps;
    }
    if (result.kind === "provider_error") {
      await log(deps, steps, orderId, "approval_check_failed", "failed", describeFailure(result));
      return steps;
    }
    if (result.kind === "ok" && ["VOIDED", "COMPLETED"].includes(result.data.status)) {
      await log(deps, steps, orderId, "approval_check_failed", "failed", `order is ${result.data.status}, not waiting for approval`);
      return steps;
    }
    if (now() >= deadline) {
      await log(deps, steps, orderId, "approval_timed_out", "failed", "the buyer did not approve in time");
      return steps;
    }
    await sleep(intervalMs);
  }
}

const requestIdFor = (orderId: string, operation: "authorize" | "capture" | "void") => `spike-${orderId}-${operation}`;

/**
 * Authorize an approved order, then capture or void it. Every PayPal operation uses a request id derived
 * from the order, so running this again after a failure repeats nothing PayPal has already done.
 * It never retries by itself: after an unknown outcome it asks PayPal what happened and reports that.
 */
export async function finishSpike(deps: SpikeDeps, input: { orderId: string; mode: SpikeMode }): Promise<SpikeReport> {
  const { orderId, mode } = input;
  const steps: SpikeStep[] = [];
  const report = (): SpikeReport => ({ steps, ok: steps.length > 0 && steps.every((s) => s.outcome === "ok") });
  const note = (step: string, outcome: StepOutcome, detail: string, data?: Data) =>
    log(deps, steps, orderId, step, outcome, detail, data);

  // 1. Where is the order? (Also what makes a re-run resume instead of repeat.)
  const order = await deps.client.getOrder(orderId);
  if (order.kind !== "ok") {
    await note("order_lookup_failed", isUnknown(order) ? "unknown" : "failed", describeFailure(order));
    return report();
  }

  let authorizationId = order.data.authorizationId;
  if (authorizationId) {
    await note("authorize_skipped", "ok", `already authorized as ${authorizationId}`, { authorization_id: authorizationId });
  } else {
    if (order.data.status !== "APPROVED") {
      await note("not_approved", "failed", `order is ${order.data.status}; the buyer has not approved it yet`, { status: order.data.status });
      return report();
    }

    // 2. Authorize.
    const authorized = await deps.client.authorizeOrder(orderId, requestIdFor(orderId, "authorize"));
    if (authorized.kind === "ok") {
      const a = authorized.data;
      if (a.amountMinor !== SPIKE_AMOUNT || a.currency !== "USD" || a.authorizationStatus !== "CREATED") {
        await note("financial_exception", "failed", `authorization ${a.authorizationId} does not match the order (${a.amountMinor} ${a.currency}, ${a.authorizationStatus}); not capturing`, {
          authorization_id: a.authorizationId,
          amount_minor: a.amountMinor,
          currency: a.currency,
        });
        return report();
      }
      authorizationId = a.authorizationId;
      await note("authorized", "ok", `funds held under ${authorizationId}`, {
        authorization_id: authorizationId,
        amount_minor: a.amountMinor,
        currency: a.currency,
      });
    } else {
      await note("authorize_failed", isUnknown(authorized) ? "unknown" : "failed", describeFailure(authorized));
      if (!isUnknown(authorized)) return report();
      // Unknown outcome: ask PayPal rather than guess or retry.
      const again = await deps.client.getOrder(orderId);
      if (again.kind !== "ok" || !again.data.authorizationId) {
        await note("authorize_unresolved", "unknown", "PayPal shows no authorization yet; check again before retrying");
        return report();
      }
      authorizationId = again.data.authorizationId;
      await note("authorize_confirmed_by_query", "ok", `PayPal shows authorization ${authorizationId}`, { authorization_id: authorizationId });
    }
  }

  if (mode === "capture") {
    await capture(deps, orderId, authorizationId, note);
  } else {
    await voidIt(deps, orderId, authorizationId, note);
  }
  return report();
}

type Note = (step: string, outcome: StepOutcome, detail: string, data?: Data) => Promise<void>;

async function capture(deps: SpikeDeps, orderId: string, authorizationId: string, note: Note) {
  const result = await deps.client.captureAuthorization(authorizationId, requestIdFor(orderId, "capture"), {
    amount: SPIKE_AMOUNT,
    finalCapture: true,
  });

  if (result.kind === "ok") {
    const c = result.data;
    if (c.status !== "COMPLETED" || c.amountMinor !== SPIKE_AMOUNT || c.currency !== "USD") {
      await note("financial_exception", "failed", `capture ${c.captureId} is ${c.status} for ${c.amountMinor} ${c.currency}, not the expected ${SPIKE_AMOUNT} USD`, {
        capture_id: c.captureId,
        amount_minor: c.amountMinor ?? 0,
      });
      return;
    }
    await note("captured", "ok", `captured ${c.captureId}`, { capture_id: c.captureId, amount_minor: c.amountMinor, currency: c.currency });
    return;
  }

  await note("capture_failed", isUnknown(result) ? "unknown" : "failed", describeFailure(result), { authorization_id: authorizationId });
  if (!isUnknown(result)) return;

  // OUTCOME_UNKNOWN: query before anything else. Never repeat the capture blindly.
  const state = await deps.client.getAuthorization(authorizationId);
  if (state.kind === "ok" && state.data.status === "CAPTURED") {
    await note("capture_confirmed_by_query", "ok", `PayPal shows ${authorizationId} as CAPTURED, so the capture did happen`, { authorization_id: authorizationId });
  } else if (state.kind === "ok") {
    await note("capture_not_found", "unknown", `PayPal shows ${authorizationId} as ${state.data.status}; the capture has not happened, re-run to retry with the same request id`, {
      authorization_id: authorizationId,
      status: state.data.status,
    });
  } else {
    await note("capture_unresolved", "unknown", `could not confirm either way (${describeFailure(state)}); stay in a checking state`);
  }
}

async function voidIt(deps: SpikeDeps, orderId: string, authorizationId: string, note: Note) {
  const result = await deps.client.voidAuthorization(authorizationId, requestIdFor(orderId, "void"));

  if (result.kind !== "ok") {
    await note("void_failed", isUnknown(result) ? "unknown" : "failed", describeFailure(result), { authorization_id: authorizationId });
    if (!isUnknown(result)) return;
  }

  // A void that timed out proves nothing, and even a success is worth confirming: ask PayPal.
  const state = await deps.client.getAuthorization(authorizationId);
  if (state.kind === "ok" && state.data.status === "VOIDED") {
    await note("voided", "ok", `PayPal confirms ${authorizationId} is VOIDED; funds are released`, { authorization_id: authorizationId });
  } else if (state.kind === "ok") {
    await note("void_not_confirmed", "unknown", `PayPal shows ${authorizationId} as ${state.data.status}; stay in a checking state until it reads VOIDED`, {
      authorization_id: authorizationId,
      status: state.data.status,
    });
  } else {
    await note("void_unresolved", "unknown", `could not confirm either way (${describeFailure(state)}); stay in a checking state`);
  }
}
