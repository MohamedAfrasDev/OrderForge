import type { EmailMessage, EmailPort, EmailResult } from "./port";

const RESEND_ORIGIN = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export type ResendOptions = {
  apiKey: string;
  /** The sender: "Name <address>" or an address. `onboarding@resend.dev` works only for the Resend account owner's own address until a domain is verified. */
  from: string;
  replyTo?: string;
  timeoutMs?: number;
  /** For tests only: a local fake server. Only `http://127.0.0.1:<port>` and `http://localhost:<port>` are accepted besides Resend itself. */
  baseUrl?: string;
  /** For tests only. */
  fetchImpl?: typeof fetch;
};

/** The key may be sent to api.resend.com, or to a local fake in tests. Any other host is a mistake (or an attack) and is refused before anything is sent. */
function checkedOrigin(baseUrl: string | undefined): string {
  const url = new URL(baseUrl ?? RESEND_ORIGIN);
  const resend = url.protocol === "https:" && url.hostname === "api.resend.com" && !url.port && !url.username && !url.password;
  const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && !url.username && !url.password;
  if (!resend && !local) throw new Error("Email host not allowed: the key is only sent to api.resend.com or a local fake");
  return url.origin;
}

/**
 * Sends one email through Resend's HTTP API: `POST /emails` with `fetch`, no SDK. The notification's id goes in the `Idempotency-Key`
 * header, so a retry after a crash cannot send twice. Anything but a 2xx is a failure for the outbox to retry. The key is only ever in the
 * `Authorization` header: it is not in the result, an error message, a log or the body. Redirects are never followed, so the header cannot
 * travel to another host.
 */
export function createResendEmail(options: ResendOptions): EmailPort {
  const origin = checkedOrigin(options.baseUrl);
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async send(message: EmailMessage): Promise<EmailResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${origin}/emails`, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": message.idempotencyKey },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            ...((message.replyTo ?? options.replyTo) ? { reply_to: message.replyTo ?? options.replyTo } : {}),
          }),
        });
        // The body is not read: it can name the recipient, and nothing here needs it.
        void response.body?.cancel().catch(() => undefined);
        return { ok: response.status >= 200 && response.status < 300 };
      } catch {
        // A timeout, a dropped connection, a refused redirect or a network error: all the same to the outbox, and none of them carries the key.
        return { ok: false };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
