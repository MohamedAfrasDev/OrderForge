/** Runs a pass and swallows everything: an email problem is never allowed to reach the action that caused the event. */
export async function notifyBestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // The scheduled run tries again. Nothing about the cause (an address, a link, a provider message) is kept here.
  }
}

