export function SandboxBanner() {
  return (
    <div
      role="status"
      aria-label="Sandbox notice"
      className="w-full bg-amber-400 px-3 py-1 text-center text-xs font-medium text-amber-950 sm:px-4 sm:py-1.5 sm:text-sm"
    >
      Sandbox · simulated data
      <span className="hidden sm:inline"> · No real money moves. PayPal sandbox only.</span>
    </div>
  );
}
