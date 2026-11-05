import type { Journey, StepState } from "@/domain/journey";

const BAR: Record<StepState, string> = {
  done: "bg-foreground",
  current: "bg-primary ring-2 ring-ring/60",
  stopped: "bg-destructive ring-2 ring-destructive/40",
  upcoming: "bg-border",
};

const SAID: Record<StepState, string> = {
  done: "done",
  current: "you are here",
  stopped: "stopped here",
  upcoming: "still to come",
};

/**
 * Six steps, the one the customer is on marked. On a phone only the current step's name is shown under the bars (the others are
 * still read out to a screen reader); from a tablet up every step is named. Drawn from `journeyOf`, never from a raw state.
 */
export function JourneyStrip({ journey }: { journey: Journey }) {
  const total = journey.steps.length;
  const atEnd = journey.current >= total;
  const here = atEnd ? null : journey.steps[journey.current];
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label="Your progress" className="grid grid-cols-6 gap-1.5">
        {journey.steps.map((step, i) => (
          <li key={step.id} data-state={step.state} aria-current={step.state === "current" || step.state === "stopped" ? "step" : undefined} className="flex flex-col gap-1.5">
            <span aria-hidden="true" className={`h-1.5 rounded-full ${BAR[step.state]}`} />
            <span className="sr-only">
              Step {i + 1} of {total}: {step.label}, {SAID[step.state]}
            </span>
            <span aria-hidden="true" className={`hidden text-xs sm:block ${step.state === "upcoming" ? "text-muted-foreground" : "font-medium"}`}>
              {step.label}
            </span>
          </li>
        ))}
      </ol>
      <p aria-hidden="true" className="text-xs text-muted-foreground sm:hidden">
        {here ? `Step ${journey.current + 1} of ${total}: ${here.label}` : "All done"}
      </p>
    </div>
  );
}
