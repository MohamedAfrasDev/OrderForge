"use client";

import { Button } from "@/components/ui/button";

/**
 * Prints the pick list it sits in and nothing else. It marks the list `data-printing` for the moment of printing; the print stylesheet in
 * globals.css hides everything on the page except a marked list. The mark is taken off again afterwards.
 */
export function PrintButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="print:hidden"
      onClick={(event) => {
        const list = event.currentTarget.closest("[data-pick-list]");
        if (!list) return window.print();
        list.setAttribute("data-printing", "");
        const done = () => {
          list.removeAttribute("data-printing");
          window.removeEventListener("afterprint", done);
        };
        window.addEventListener("afterprint", done);
        window.print();
        // Some browsers do not report the end of printing: take the mark off when print() returns as well.
        done();
      }}
    >
      Print pick list
    </Button>
  );
}
