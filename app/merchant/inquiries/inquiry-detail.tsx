import { cents, format } from "@/lib/money";
import type { CustomerSpecField, MerchantInquiry } from "@/services/intake/read";
import { ReplyForm } from "./reply-form";

export const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

const STATUS_WORDS: Record<string, string> = {
  confirmed: "confirmed",
  needs_confirmation: "needs confirmation",
  conflicted: "conflicting",
  unknown: "not specified",
};

function show(f: CustomerSpecField): string {
  const v = f.value;
  if (v === null || v === undefined) return "Not specified";
  if (f.name === "maxPricePerBoxMinor" && typeof v === "number") return format(cents(v));
  if (f.name === "noFood" || f.name === "logoRequired") return v === true ? "Yes" : "No";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** One handed-over request in full: what the customer wants, the conversation, and the reply box. Shown in the Requests grid's detail area. */
export function InquiryDetail({ inquiry }: { inquiry: MerchantInquiry }) {
  return (
    <article aria-label={`Inquiry ${inquiry.inquiryId.slice(0, 8)}`} className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">Inquiry {inquiry.inquiryId.slice(0, 8)}</h3>
        <p className="text-sm text-muted-foreground">Handed over {formatTime(inquiry.handedOverAt)}</p>
      </header>

      <div>
        <h4 className="text-sm font-medium">What the customer wants</h4>
        {inquiry.fields.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Nothing was recorded before the handover. Read the conversation below.</p>
        ) : (
          <dl className="mt-1 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            {inquiry.fields.map((f) => (
              <div key={f.name} className="contents">
                <dt className="font-medium">{f.label}</dt>
                <dd>
                  {show(f)}
                  {f.status === "unknown" ? null : <span className="text-xs text-muted-foreground"> ({STATUS_WORDS[f.status]})</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {inquiry.question ? <p className="mt-2 text-sm">The assistant was waiting on: {inquiry.question}</p> : null}
      </div>

      <div>
        <h4 className="text-sm font-medium">Conversation</h4>
        <ol className="mt-1 flex flex-col gap-2">
          {inquiry.messages.map((m) => (
            <li key={m.id} className="rounded-md border border-border p-2">
              <p className="text-xs text-muted-foreground">
                {m.role} · {formatTime(m.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
            </li>
          ))}
        </ol>
      </div>

      <ReplyForm inquiryId={inquiry.inquiryId} />
    </article>
  );
}
