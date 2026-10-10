// The bar folds Docs, History, Share and Print into "More" when the row is
// too wide (Bar.tsx); this presses one wherever it is right now.
export async function barAction(page, id) {
  const direct = page.locator(`[data-testid="shell-${id}"]`);
  if ((await direct.count()) === 0) await page.locator('[data-testid="shell-more"]').click();
  await page.locator(`[data-testid="shell-${id}"]`).click();
}
