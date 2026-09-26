// Slows only the drive's own browser tab, via Chromium's DevTools protocol,
// behind an env switch — an ordinary drive run is untouched.
//
// Usage: FATHOM_DRIVE_CPU_THROTTLE=6 node scripts/drive-hand-entry.mjs

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
