import { jobMessage } from "@/services/fulfillment/customer-messages";
import type { CustomerJobView } from "@/services/fulfillment/read";

/** Where the customer's order is once it is paid: preparing, ready, collected or delayed. Nothing more is shown. */
export function JobStatus({ view }: { view: CustomerJobView }) {
  return (
    <section aria-label="Your order" className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <h2 className="text-lg font-semibold tracking-tight">Your order</h2>
      <p className="text-sm">{jobMessage(view.status, view.readyBy)}</p>
    </section>
  );
}
