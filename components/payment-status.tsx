import { cents, format } from "@/lib/money";
import { noticeMessage, statusMessage, type PaymentNotice } from "@/services/payments/customer-messages";
import type { CustomerPaymentView } from "@/services/payments/read";

type Props = {
  view: CustomerPaymentView;
  notice: PaymentNotice | null;
  /** The accepted price's total in cents: what PayPal sets aside. It is the quote's figure, shown, never computed here. */
  totalMinor: number;
  /** A server action bound to the customer's link. Nothing is read from the browser. */
  pay: () => Promise<void>;
};

/**
 * Where the customer's payment stands, in plain words, and, when they can pay, exactly what PayPal will and won't do: the money is
 * set aside, the shop decides, and only if the shop accepts are they charged.
 */
export function PaymentStatus({ view, notice, totalMinor, pay }: Props) {
  const message = statusMessage(view.status);
  const again = view.status === "PAYING" || view.status === "FAILED";
  return (
    <section aria-label="Payment" className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="text-lg font-semibold tracking-tight">Payment</h2>
      {notice ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {noticeMessage(notice)}
        </p>
      ) : null}
      {message ? <p className="text-sm">{message}</p> : null}
      {view.canPay ? (
        <div className="flex flex-col gap-3 rounded-md bg-muted p-3">
          <p className="text-sm">
            <span className="font-medium">You won&apos;t be charged yet.</span> PayPal sets aside {format(cents(totalMinor))}. The shop reviews your order and, only if they accept, you&apos;re charged. If they say no, the hold disappears.
          </p>
          <form action={pay}>
            <button type="submit" className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
              {again ? "Continue on PayPal" : "Approve on PayPal"}
            </button>
          </form>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">Sandbox demo: PayPal test accounts only, no real money.</p>
    </section>
  );
}
