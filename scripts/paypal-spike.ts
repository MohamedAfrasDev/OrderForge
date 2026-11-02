// PayPal spike: authorize -> capture and authorize -> void, with every step recorded as evidence.
//
//   npm run paypal:spike -- --mode=both|capture|void [--yes-real-sandbox] [--confirm-host=<supabase host>]
//
// Safe by default:
//  - PAYPAL_ENV must be "sandbox" and SANDBOX_MODE must be "true".
//  - Talking to the REAL PayPal sandbox needs --yes-real-sandbox. Without it, set PAYPAL_SPIKE_BASE_URL
//    to a local fake (`npm run paypal:fake`), and everything is labeled "mocked".
//  - Writing to a non-local Supabase project needs --confirm-host (same rule as the seed scripts).
import { randomUUID } from "node:crypto";
import { createPayPalClient } from "../lib/paypal/client.ts";
import { createSpikeOrder, evidenceLabelFor, finishSpike, waitForApproval } from "../lib/paypal/spike.ts";
import type { EvidenceLabel, SpikeDeps, SpikeMode, SpikeStep } from "../lib/paypal/spike.ts";
import { spikeStore } from "../lib/paypal/spike-store.ts";
import { adminClient } from "./lib.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

if (process.env.PAYPAL_ENV !== "sandbox") {
  throw new Error("Refusing to run: PAYPAL_ENV must be exactly 'sandbox'.");
}

const modeArg = flag("mode") ?? "both";
if (!["both", "capture", "void"].includes(modeArg)) throw new Error("--mode must be both, capture or void");
const modes: SpikeMode[] = modeArg === "both" ? ["capture", "void"] : [modeArg as SpikeMode];

const baseUrl = process.env.PAYPAL_SPIKE_BASE_URL || undefined;
const evidenceLabel: EvidenceLabel = evidenceLabelFor(baseUrl);
const isLocalFake = evidenceLabel === "mocked";
if (!isLocalFake && !args.includes("--yes-real-sandbox")) {
  throw new Error(
    "Refusing to contact the real PayPal sandbox without --yes-real-sandbox.\n" +
      "To try the flow without PayPal, start `npm run paypal:fake` and set PAYPAL_SPIKE_BASE_URL.",
  );
}

const db = adminClient(); // also enforces SANDBOX_MODE and the remote-host confirmation
const store = spikeStore(db);
const client = createPayPalClient({
  env: "sandbox",
  clientId: need("PAYPAL_CLIENT_ID"),
  clientSecret: need("PAYPAL_CLIENT_SECRET"),
  baseUrl,
});

const deps: SpikeDeps = {
  client,
  recordEvent: store.recordEvent,
  insertAudit: store.insertAudit,
  evidenceLabel,
  correlationId: randomUUID(),
  actor: "cli:paypal-spike",
};

const show = (steps: SpikeStep[]) => {
  for (const s of steps) console.log(`  [${s.outcome.padEnd(7)}] ${s.step}: ${s.detail}  (${s.evidence})`);
};

console.log(`PayPal spike · evidence: ${evidenceLabel} · correlation ${deps.correlationId}`);
let allOk = true;

for (const mode of modes) {
  console.log(`\n== authorize then ${mode} ==`);
  const created = await createSpikeOrder(deps);
  show(created.steps);
  if (!created.orderId) {
    allOk = false;
    continue;
  }

  if (isLocalFake) {
    // Stand-in for the buyer's approval click; the fake exposes a control endpoint for it.
    await fetch(`${baseUrl}/__fake/approve/${created.orderId}`, { method: "POST" });
  } else {
    console.log(`  Open this link and approve with a sandbox BUYER account:\n  ${created.approveUrl ?? "(no approval link returned)"}`);
    const waited = await waitForApproval(deps, created.orderId);
    show(waited);
    if (!waited.every((s) => s.outcome === "ok")) {
      allOk = false;
      continue;
    }
  }

  const report = await finishSpike(deps, { orderId: created.orderId, mode });
  show(report.steps);
  if (!report.ok) allOk = false;
}

console.log(allOk ? "\nAll steps succeeded." : "\nSome steps did not succeed. See above; nothing was retried automatically.");
process.exit(allOk ? 0 : 1);
