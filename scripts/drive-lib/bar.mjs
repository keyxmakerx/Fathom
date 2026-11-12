// Presses one of Docs, History, Share or Print wherever it is right now. r116: Docs and History are tabs of the
// right edge on every view (Inventory and Sheet too), Print sits in the design name's menu, and Share is in the bar
// (in "More" when the row is too narrow, Bar.tsx).
export async function barAction(page, id) {
  if (id === 'docs' || id === 'history') {
    await page.locator(`[data-testid="dock-${id}"]`).click();
    return;
  }
  if (id === 'print') {
    await page.locator('.shell-bar__path-caret').last().click();
    await page.locator('[data-testid="shell-print"]').click();
    return;
  }
  if ((await page.locator('[data-testid="shell-share"]').count()) === 0) await page.locator('[data-testid="shell-more"]').click();
  await page.locator('[data-testid="shell-share"]').click();
}
