import type { EmailMessage, EmailPort, EmailResult } from "./port";

export type FakeEmail = EmailPort & {
  /** Every message handed to `send`, in order, including the ones that "failed". */
  readonly sent: EmailMessage[];
  /** The messages the fake accepted (`ok: true`). */
  readonly delivered: EmailMessage[];
};

export type FakeEmailOptions = {
  /** `send` answers `ok: false` this many times first (Infinity for always). */
  failTimes?: number;
  /** `send` throws this many times first (Infinity for always). */
  throwTimes?: number;
  /** `send` waits this long before answering. */
  delayMs?: number;
};

/** A provider that sends nothing and records everything, for tests (labeled mocked). It never touches the network. */
export function createFakeEmail(options: FakeEmailOptions = {}): FakeEmail {
  let fails = options.failTimes ?? 0;
  let throws = options.throwTimes ?? 0;
  const sent: EmailMessage[] = [];
  const delivered: EmailMessage[] = [];
  return {
    sent,
    delivered,
    async send(message): Promise<EmailResult> {
      sent.push(message);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (throws > 0) {
        throws -= 1;
        throw new Error("fake email provider threw");
      }
      if (fails > 0) {
        fails -= 1;
        return { ok: false };
      }
      delivered.push(message);
      return { ok: true };
    },
  };
}
