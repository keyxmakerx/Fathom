// Slows the drive's own browser tab through Chromium's DevTools protocol when
// FATHOM_DRIVE_CPU_THROTTLE is set, e.g. FATHOM_DRIVE_CPU_THROTTLE=6.

/** Applies FATHOM_DRIVE_CPU_THROTTLE to `page`; does nothing when it is unset. */
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
