import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getPublicMerchant } from "@/lib/access/inquiry-reads";
import { createAdminClient } from "@/lib/supabase/admin";
import { startInquiryAction } from "./actions";
import { StartForm } from "./start-form";

export const metadata: Metadata = { title: "Custom order · OrderForge" };
// The first turn runs the assistant inside the request.
export const maxDuration = 60;

export default function StorePage({ params }: PageProps<"/store/[slug]">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Storefront params={params} />
      </Suspense>
    </main>
  );
}

async function Storefront({ params }: { params: PageProps<"/store/[slug]">["params"] }) {
  const { slug } = await params;
  const merchant = await getPublicMerchant(createAdminClient(), slug);
  if (!merchant) notFound();

  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">{merchant.name}</h1>
      <p className="max-w-md text-muted-foreground">
        Describe the custom order you have in mind and we will turn it into an exact, priced proposal.
      </p>
      <StartForm action={startInquiryAction.bind(null, merchant.slug)} />
    </>
  );
}
