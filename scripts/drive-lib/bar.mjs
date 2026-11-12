// Presses one of Docs, History, Share or Print wherever it is right now. On the drawing (r31-bar A) Docs and
// History are tabs of the right-hand panel and Print sits in the design's menu; elsewhere the bar folds them into
// "More" when the row is too wide (Bar.tsx).
export async function barAction(page, id) {
  const tab = page.locator(`[data-testid="dock-${id}"]`);
  if ((id === 'docs' || id === 'history') && (await tab.count()) > 0) {
    await tab.click();
    return;
  }
  const direct = page.locator(`[data-testid="shell-${id}"]`);
  if ((await direct.count()) === 0) {
    // Print is in the design's menu only on the canvas (Bar.tsx `toolsOnCanvas`); on other places it is a chip or folded into More.
    if ((await page.locator('[data-testid="shell-more"]').count()) > 0) await page.locator('[data-testid="shell-more"]').click();
    else if (id === 'print' && (await page.locator('.shell-bar__path-caret').count()) > 0) await page.locator('.shell-bar__path-caret').last().click();
  }
  await page.locator(`[data-testid="shell-${id}"]`).click();
}
