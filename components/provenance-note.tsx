import { PROVENANCE_LABELS, provenanceOfFigure } from "@/domain/journey";

/**
 * Says in words that a price was worked out by code from the shop's prices and stock, not by the assistant. The meaning is in the text,
 * with a mark that does not depend on colour.
 */
export function CalculatedNote() {
  const { label, detail } = PROVENANCE_LABELS[provenanceOfFigure()];
  return (
    <p data-provenance="calculated" className="text-xs text-muted-foreground">
      <span aria-hidden="true" className="mr-1 font-semibold text-foreground">=</span>
      <span className="font-medium text-foreground">{label}.</span> {detail}
    </p>
  );
}
