import { noticeMessage, statusMessage, type PaymentNotice } from "@/services/payments/customer-messages";
import type { CustomerPaymentView } from "@/services/payments/read";

type Props = {
  view: CustomerPaymentView;
  notice: PaymentNotice | null;
  /** A server action bound to the customer's link. Nothing is read from the browser. */
  pay: () => Promise<void>;
};

/** Where the customer's payment stands, in plain words, with the way to pay when that is possible. */
export function PaymentStatus({ view, notice, pay }: Props) {
  const message = statusMessage(view.status);
  return (
    <section aria-label="Payment" className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="text-lg font-semibold tracking-tight">Payment</h2>
      {notice ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {noticeMessage(notice)}
        </p>
      ) : null}
      <p className="text-sm">{message ?? "Pay with PayPal to confirm your order. The merchant reviews it, and you are charged only when they accept."}</p>
      {view.canPay ? (
        <form action={pay}>
          <button type="submit" className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
            {view.status === "PAYING" || view.status === "FAILED" ? "Continue with PayPal" : "Pay with PayPal"}
          </button>
        </form>
      ) : null}
      <p className="text-xs text-muted-foreground">Sandbox demo: PayPal test accounts only, no real money.</p>
    </section>
  );
}
