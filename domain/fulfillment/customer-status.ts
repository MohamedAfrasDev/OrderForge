import type { CustomerStatus, JobStatus } from "./types";

/** The four words a customer sees. QUEUED and PREPARING both read as being prepared; a hold reads as delayed, with no reason. */
export function customerStatusOf(status: JobStatus): CustomerStatus {
  switch (status) {
    case "QUEUED":
    case "PREPARING":
      return "PREPARING";
    case "READY_FOR_PICKUP":
      return "READY";
    case "COLLECTED":
      return "COLLECTED";
    case "ON_HOLD":
      return "DELAYED";
  }
}
