export function SandboxBanner() {
  return (
    <div
      role="status"
      aria-label="Sandbox notice"
      className="w-full bg-amber-400 px-4 py-1.5 text-center text-sm font-medium text-amber-950"
    >
      Sandbox · simulated data
      <span className="hidden sm:inline"> · No real money moves. PayPal sandbox only.</span>
    </div>
  );
}
