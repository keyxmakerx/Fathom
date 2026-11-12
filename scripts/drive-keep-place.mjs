// Sign-off thread "Keep Inventory where you left it": leaving Inventory for the canvas and coming back
// lands on the same screen: the list, its filter, sort and scroll, and an open page with its tab.
// Same harness as drive-inventory.mjs. Usage: node scripts/drive-keep-place.mjs
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { barAction } from './drive-lib/bar.mjs';
import { check, fails, waitForServer } from './drive-lib/kit.mjs';

const pw = await import(
  process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js'
);

// The filter line is folded behind the toolbar's Filter button until it is asked for (r30-small).
async function openFilter(p, label) {
  const line = p.getByLabel(label);
  if ((await line.count()) === 0) await p.getByRole('button', { name: 'Filter', exact: true }).click();
  return line;
}
// The name box opens from + Device (r30-small).
async function openAdder(p) {
  const box = p.getByLabel(/Name of the new/);
  if ((await box.count()) === 0) await p.getByRole('button', { name: '+ Device', exact: true }).click();
  return box;
}

const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM
  || '/opt/pw-browsers/chromium';
const CLIENT = ROOT + '/client';
const DRIVE_LIB = ROOT + '/scripts/drive-lib';
// Not shared with any other `scripts/drive-*.mjs` — `grep -h "PORT = "
// scripts/drive-*.mjs` before picking a new one.
const PORT = 18461;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

// Step 0: the wasm artefact.
const WASM_ARTIFACT = CLIENT + '/public/engine/fathom_wasm.wasm';
if (!existsSync(WASM_ARTIFACT)) {
  console.log('==> building the wasm artefact (missing): bash scripts/build-wasm.sh');
  execFileSync('bash', [ROOT + '/scripts/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
check('the wasm artefact exists', existsSync(WASM_ARTIFACT), WASM_ARTIFACT);

// Step 1: copy the shared throwaway harness into `client/`.
for (const f of [PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE]) {
  if (existsSync(f)) {
    console.error(`refusing to run: ${f} already exists (left from an earlier run?); remove it first`);
    process.exit(2);
  }
}
writeFileSync(
  PREVIEW_HTML,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Fathom — ADR-0062 proof preview (throwaway, not shipped)</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/drive.tsx"></script>
  </body>
</html>
`,
);
mkdirSync(CLIENT + '/public', { recursive: true });
copyFileSync(DRIVE_LIB + '/harness.tsx', PREVIEW_TSX);
copyFileSync(DRIVE_LIB + '/seed.ts', PREVIEW_SEED);
copyFileSync(DRIVE_LIB + '/catalogue.json', PREVIEW_CATALOGUE);
check('drive.html written', existsSync(PREVIEW_HTML));
check('drive.tsx copied from drive-lib/harness.tsx', existsSync(PREVIEW_TSX));
check('drive-seed.ts copied from drive-lib/seed.ts', existsSync(PREVIEW_SEED));
check('drive-catalogue.json copied from drive-lib/catalogue.json', existsSync(PREVIEW_CATALOGUE));

let viteProc = null;
let browser = null;

try {
  console.log(`==> starting the client dev server on port ${PORT}`);
  viteProc = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: CLIENT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let viteLog = '';
  viteProc.stdout.on('data', (d) => { viteLog += d.toString(); });
  viteProc.stderr.on('data', (d) => { viteLog += d.toString(); });
  const up = await waitForServer(`${BASE}/drive.html`, 30_000);
  check('client dev server answers /drive.html', up, up ? '' : viteLog.slice(-2000));
  if (!up) throw new Error('dev server did not come up');

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const shot = async (name) => {
    await page.screenshot({ path: SHOTS + name });
    console.log('    wrote ' + SHOTS + name);
  };

  await page.goto(`${BASE}/drive.html?scene=inventory`);
  await page.waitForSelector('.drawing', { timeout: 15_000 });
  const toInventory = async () => {
    await page.getByRole('tab', { name: 'Inventory', exact: true }).click();
    await page.waitForSelector('.inventory-place__rail', { timeout: 15_000 });
    await page.waitForTimeout(400);
  };
  const toCanvas = async () => {
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
    await page.waitForSelector('.drawing', { timeout: 15_000 });
    await page.waitForTimeout(300);
  };
  const hashOf = () => page.evaluate(() => window.location.hash);
  const scrollOf = () => page.locator('.inv-table__scroll').evaluate((el) => el.scrollTop);
  await toInventory();
  await page.waitForSelector('.inv-table__row', { timeout: 15_000 });

  // 1 — a filtered, sorted, scrolled list comes back as it was left.
  const line = await openFilter(page, 'Filter devices');
  await line.fill('name~bulk');
  await page.waitForTimeout(400);
  await page.locator('.inv-table [role=columnheader]').nth(1).click();
  await page.waitForTimeout(300);
  await page.locator('.inv-table__scroll').evaluate((el) => { el.scrollTop = 900; });
  await page.waitForTimeout(300);
  const before = { hash: await hashOf(), top: await scrollOf() };
  await shot('keep-01-list.png');
  await toCanvas();
  await toInventory();
  await page.waitForSelector('.inv-table__row', { timeout: 15_000 });
  await page.waitForTimeout(300);
  const after = { hash: await hashOf(), top: await scrollOf() };
  await shot('keep-01b-list-back.png');
  check('the list comes back with its filter and sort', after.hash === before.hash, `before=${before.hash} after=${after.hash}`);
  check('the filter line still reads it', (await page.getByLabel('Filter devices').count()) > 0 && (await page.getByLabel('Filter devices').inputValue()) === 'name~bulk');
  check('the list comes back at its scroll', Math.abs(after.top - before.top) < 40, `before=${before.top} after=${after.top}`);

  // 2 — an open page comes back open, on the tab it was on, with the list behind it intact.
  await page.locator('.inv-table__row').first().locator('[role=gridcell]').nth(1).click();
  await page.waitForSelector('.inv-page', { timeout: 5_000 });
  const tabs = page.locator('.inv-page [role=tab]');
  if ((await tabs.count()) > 1) await tabs.nth(1).click();
  await page.waitForTimeout(300);
  const openBefore = await hashOf();
  await shot('keep-02-page.png');
  await toCanvas();
  await toInventory();
  await page.waitForSelector('.inv-page', { timeout: 5_000 }).catch(() => {});
  const openAfter = await hashOf();
  await shot('keep-02b-page-back.png');
  check('the open page comes back open, on its tab', openAfter === openBefore, `before=${openBefore} after=${openAfter}`);
  await page.goBack();
  await page.waitForSelector('.inv-table__row', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  check('Back from it is the same filtered list', (await hashOf()) === before.hash, `${await hashOf()}`);

  // 3 — let go of it on the canvas: Inventory still comes back with the page as it was left.
  await page.locator('.inv-table__row').first().locator('[role=gridcell]').nth(1).click();
  await page.waitForSelector('.inv-page', { timeout: 5_000 });
  const firstOpen = await hashOf();
  await toCanvas();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await toInventory();
  await page.waitForSelector('.inv-page', { timeout: 5_000 }).catch(() => {});
  check('with nothing picked on the canvas, the page left open is still open', (await hashOf()) === firstOpen, `before=${firstOpen} after=${await hashOf()}`);
  await page.goBack();
  await page.waitForSelector('.inv-table__row', { timeout: 10_000 }).catch(() => {});

  // 4 — the Sheet: the sheet tab chosen comes back too.
  await toCanvas();
  await page.getByRole('tab', { name: 'Sheet', exact: true }).click();
  await page.waitForSelector('[data-testid="sheet-tab-ports"]', { timeout: 15_000 });
  await page.locator('[data-testid="sheet-tab-ports"]').click();
  await page.waitForTimeout(300);
  await page.locator('.inv-table__scroll').evaluate((el) => { el.scrollTop = 600; });
  await page.waitForTimeout(50);
  const sheetBefore = { hash: await hashOf(), top: await scrollOf() };
  await shot('keep-04-sheet.png');
  await toCanvas();
  await page.getByRole('tab', { name: 'Sheet', exact: true }).click();
  await page.waitForSelector('[data-testid="sheet-tab-ports"]', { timeout: 15_000 });
  await page.waitForTimeout(300);
  await shot('keep-04b-sheet-back.png');
  check('the Sheet comes back on the tab it was left on', (await page.locator('[data-testid="sheet-tab-ports"]').getAttribute('aria-current')) === 'page', await hashOf());
  check('and at its scroll, even left straight after scrolling', sheetBefore.top > 0 && Math.abs((await scrollOf()) - sheetBefore.top) < 40, `before=${sheetBefore.top} after=${await scrollOf()}`);

  // 5 — r127: the Sheet stays a spreadsheet. A click selects a cell, a double-click edits it, and only
  // the row's small open button (or Ctrl Enter) opens its page.
  await page.locator('[data-testid="sheet-tab-devices"]').click();
  await page.waitForSelector('.inv-table__row', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.locator('.inv-table__scroll').evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  // The list is virtualised, so name the row rather than take the first in the DOM.
  const firstName = ((await page.locator('.inv-table__row').first().locator('[role=gridcell]').nth(1).innerText()) || '').replace('↗', '').trim();
  const firstRow = page.locator('.inv-table__row', { has: page.getByLabel(`Select ${firstName}`, { exact: true }) });
  const nameCell = firstRow.locator('[role=gridcell]').nth(1);
  await nameCell.click();
  await page.waitForTimeout(300);
  await shot('sheet-01-click-selects.png');
  check('a click on a Sheet row\'s name selects the cell and opens no page', (await page.locator('.inv-page').count()) === 0 && (await nameCell.getAttribute('aria-selected')) === 'true');
  await firstRow.locator('[role=gridcell]').nth(3).click();
  await page.waitForTimeout(200);
  check('nor does a click in any other cell', (await page.locator('.inv-page').count()) === 0);
  await nameCell.dblclick();
  await page.waitForTimeout(200);
  await shot('sheet-02-dblclick-edits.png');
  check('a double-click on the name edits it in the cell', (await nameCell.locator('input').count()) === 1 && (await page.locator('.inv-page').count()) === 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('Enter on the name edits it too, as a spreadsheet does', (await nameCell.locator('input').count()) === 1);
  await page.keyboard.press('Escape');
  await nameCell.hover();
  await page.waitForTimeout(150);
  await shot('sheet-03-open-button.png');
  await firstRow.locator('.inv-table__open').click();
  await page.waitForSelector('.inv-page', { timeout: 5_000 }).catch(() => {});
  await shot('sheet-04-opened.png');
  check('the row\'s open button is the way to its page', (await page.locator('.inv-page').count()) === 1);

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close();
  browser = null;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (viteProc) {
    viteProc.kill();
    try { execFileSync('fuser', ['-k', `${PORT}/tcp`]); } catch { /* nothing was listening */ }
  }
  for (const f of [PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE]) {
    if (existsSync(f)) rmSync(f);
  }
  check('drive.html removed', !existsSync(PREVIEW_HTML));
  check('drive.tsx removed', !existsSync(PREVIEW_TSX));
  check('drive-seed.ts removed', !existsSync(PREVIEW_SEED));
  check('drive-catalogue.json removed', !existsSync(PREVIEW_CATALOGUE));
}

console.log(fails.length ? '\nFAILURES:\n  ' + fails.join('\n  ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
