export const CORRELATION_HEADER = "x-correlation-id";

const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

/** Reuse an incoming id only if it is well-formed; otherwise mint a new one. */
export function correlationIdFrom(headers: Headers): string {
  const incoming = headers.get(CORRELATION_HEADER);
  return incoming !== null && SAFE_ID.test(incoming) ? incoming : newCorrelationId();
}
