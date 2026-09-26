// GitHub issue #66: reproducing "nodes blink under load" without actually
// loading the machine — slow only the drive's own browser tab, with
// Chromium's DevTools protocol, behind an env switch so an ordinary drive
// run (this file's other callers, unthrottled) is untouched.
//
// Usage: FATHOM_DRIVE_CPU_THROTTLE=6 node scripts/drive-hand-entry.mjs
// A rate of 1 is "no throttling" (Chromium's own default); 4 to 10 is the
// range this issue was reproduced at.

/** Applies `FATHOM_DRIVE_CPU_THROTTLE` (a number, e.g. "6") to `page`'s own
 * CDP session, if set. A no-op — no CDP session opened at all — when unset,
 * so a caller that never reads this env var never slows down. */
export async function applyDriveCpuThrottle(page) {
  const raw = process.env.FATHOM_DRIVE_CPU_THROTTLE;
  if (!raw) return;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`FATHOM_DRIVE_CPU_THROTTLE must be a positive number, got ${JSON.stringify(raw)}`);
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  console.log(`==> CPU throttling this drive's own browser tab at rate ${rate} (FATHOM_DRIVE_CPU_THROTTLE)`);
}
