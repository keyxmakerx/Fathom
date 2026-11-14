// Opens the Trail wherever it lives now. r116 (ADR-0091): the Trail is a tab of the History panel on the right
// edge, beside Saves; before that it was its own edge tab ("Open the trail"). Leaves it open if it already is.
export async function openTheTrail(page) {
  if ((await page.locator('.racks-trail__rows').count()) > 0) return;
  const old = page.locator('button[aria-label="Open the trail"]');
  if ((await old.count()) > 0) {
    await old.click();
    return;
  }
  if ((await page.locator('[data-testid=history-tab-trail]').count()) === 0) await page.locator('[data-testid=dock-history]').click();
  await page.locator('[data-testid=history-tab-trail]').click();
  await page.locator('.racks-trail__rows').first().waitFor({ timeout: 10_000 });
}
