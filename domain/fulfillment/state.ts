import { JOB_STATUSES, type JobStatus, type TransitionContext } from "./types";

export { JOB_STATUSES };

/** The statuses a job can be paused from. */
const HOLDABLE: readonly JobStatus[] = ["QUEUED", "PREPARING", "READY_FOR_PICKUP"];

/** The forward step from each status. COLLECTED is final and ON_HOLD resumes through its context. */
const NEXT: Partial<Record<JobStatus, JobStatus>> = {
  QUEUED: "PREPARING",
  PREPARING: "READY_FOR_PICKUP",
  READY_FOR_PICKUP: "COLLECTED",
};

/** Every status the job may move to from `from` (null for a job that does not exist yet). */
export function allowedMoves(from: JobStatus | null, context: TransitionContext): JobStatus[] {
  if (from === null) return ["QUEUED"];
  if (from === "COLLECTED") return [];
  if (from === "ON_HOLD") {
    const left = context.heldFrom;
    return left != null && HOLDABLE.includes(left) ? [left] : [];
  }
  const moves: JobStatus[] = [];
  const next = NEXT[from];
  if (next) moves.push(next);
  moves.push("ON_HOLD");
  return moves;
}

/**
 * The only job state machine. A move is the listed target or ILLEGAL_TRANSITION: nothing is skipped, nothing goes back,
 * COLLECTED is final, and ON_HOLD returns only to the status it left. Asking for the status a job is already in is not a
 * move; callers treat it as a repeat of the earlier request.
 */
export function transition(from: JobStatus | null, to: JobStatus, context: TransitionContext): JobStatus | { error: "ILLEGAL_TRANSITION" } {
  return allowedMoves(from, context).includes(to) ? to : { error: "ILLEGAL_TRANSITION" };
}
