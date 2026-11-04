import type { Journey } from "@/domain/journey";
import { JourneyStrip } from "./journey-strip";

const TURN = { you: "Your turn", shop: "The shop's turn", nobody: null } as const;

/**
 * The top of every customer page about an order: whose shop it is, the progress strip, and a plain headline saying what happens
 * next and who it waits on. Everything it says comes from `journeyOf`.
 */
export function CustomerHeader({ shopName, journey }: { shopName: string; journey: Journey }) {
  const turn = TURN[journey.waitingOn];
  return (
    <header data-testid="order-header" className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm text-muted-foreground">{shopName}</p>
        <h1 className="text-sm font-medium text-muted-foreground">Your request</h1>
      </div>
      <JourneyStrip journey={journey} />
      <div className="flex flex-col gap-1.5">
        {turn ? <p className="w-fit rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">{turn}</p> : null}
        <h2 className="text-2xl font-semibold tracking-tight">{journey.headline}</h2>
        <p className="text-sm text-muted-foreground">{journey.detail}</p>
      </div>
    </header>
  );
}
