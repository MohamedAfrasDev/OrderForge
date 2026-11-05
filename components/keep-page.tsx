"use client";

import { useState, useSyncExternalStore } from "react";
import { buttonVariants } from "@/components/ui/button";
import { keepLinkMailto } from "@/lib/keep-link";
import { cn } from "@/lib/utils";

const subscribe = () => () => {};
// The address the customer is on, without anything after the path (a notice in the address is not part of the way back).
const currentLink = () => `${window.location.origin}${window.location.pathname}`;
const noLinkYet = () => "";

/**
 * "Keep this page": the link to the order, a way to copy it and a way to email it to themselves. It is built from the address
 * the customer is already on; this component sends and stores nothing. It says plainly that the link is the only way back, and, only when
 * it is true, that the link was emailed to the address they gave (or is on its way).
 */
export function KeepPage({ shopName, emailed = null }: { shopName: string; emailed?: "sent" | "pending" | null }) {
  const link = useSyncExternalStore(subscribe, currentLink, noLinkYet);
  const [copied, setCopied] = useState(false);
  if (link === "") return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard here: the link is in the box for them to select.
      setCopied(false);
    }
  }

  return (
    <section aria-label="Keep this page" className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="text-sm">
        <span className="font-medium">Keep this page.</span> This link is the only way back to your order, and anyone who has it can open it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          readOnly
          value={link}
          aria-label="Link to your order"
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs"
        />
        <button type="button" onClick={copy} className={cn(buttonVariants({ variant: "outline" }))}>
          {copied ? "Copied" : "Copy link"}
        </button>
        <a href={keepLinkMailto(link, shopName)} className={cn(buttonVariants({ variant: "outline" }))}>
          Email it to me
        </a>
      </div>
      {emailed ? (
        <p data-testid="link-emailed" className="text-sm text-muted-foreground">
          {emailed === "sent" ? "We also emailed this link to the address you gave." : "We're emailing this link to the address you gave."}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {copied ? "Link copied." : ""}
      </p>
    </section>
  );
}
