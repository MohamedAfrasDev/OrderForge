/** What the app needs from an email provider, and nothing more. The real one is `lib/email/resend.ts`; tests use `lib/email/fake.ts`. */
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The notification's id: a provider that supports it never sends the same key twice, so a retry after a crash cannot send twice. */
  idempotencyKey: string;
  replyTo?: string;
};

/** `ok: false` is any failure to send (a refusal, a timeout, a network error). The reason is deliberately not part of the result. */
export type EmailResult = { ok: boolean };

export interface EmailPort {
  send(message: EmailMessage): Promise<EmailResult>;
}
