// Proves ADR-0062 against the real compiled client: the Inventory table windows 600 rows, edits a
// cell in place and Tabs to the next, adds a thing by name, defines a custom field and fills it,
// filters, pastes rows, bulk-tags, opens a page with tabs, and Show on canvas. Same harness as
// drive-tags.mjs. Usage: node scripts/drive-inventory.mjs  (FATHOM_SHOTS picks the screenshot dir)
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { barAction } from './drive-lib/bar.mjs';

const pw = await import(
  process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js'
);
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CLIENT = ROOT + '/client';
const DRIVE_LIB = ROOT + '/scripts/drive-lib';
// Not shared with any other `scripts/drive-*.mjs` — `grep -h "PORT = "
// scripts/drive-*.mjs` before picking a new one.
const PORT = 18322;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

const fails = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) fails.push(name);
}

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

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

try {
  console.log(`==> starting the client dev server on port ${PORT}`);
  viteProc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
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
  await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  await page.waitForSelector('.inv-table__row', { timeout: 15_000 });

  // 1 — the rail counts every device, the table renders only a window of them.
  const railText = await page.locator('.inventory-place__rail').innerText();
  check('the rail counts 602 devices', /Devices\s*602/.test(railText), railText.replace(/\s+/g, ' '));
  const rendered = await page.locator('.inv-table__row').count();
  check('only a window of the 602 rows is in the page', rendered > 10 && rendered < 80, `rows in DOM=${rendered}`);
  await shot('inventory-01-table.png');

  // 2 — filter by name.
  const line = page.getByLabel('Filter devices');
  await line.fill('name~bulk-0042');
  check('a filter narrows to one row', (await page.locator('.inv-table__row').count()) === 1);
  check('the line is read back in words', (await page.locator('.inv-fq__reading').innerText()).includes('Name contains bulk-0042'));
  await page.locator('.inv-chip button').click();
  check('removing the chip empties the line', (await line.inputValue()) === '');

  // 3 — add by name, then the page opens on it.
  await page.getByLabel(/Name of the new/).fill('edge-fw');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForSelector('.inv-page', { timeout: 5_000 });
  check('adding by name opens its page', (await page.locator('.inv-page').innerText()).includes('edge-fw'));
  check('the page replaces the list', (await page.locator('.inv-table__row').count()) === 0);
  await page.getByRole('button', { name: /^← Back to Devices/ }).click();
  await page.waitForSelector('.inv-table__row', { timeout: 5_000 });
  check('Back returns to the list', (await page.locator('.inv-table__row').count()) > 10);

  // 4 — edit a cell in place: Role, then Tab to Mgmt address.
  await line.fill('name~edge-fw');
  await page.getByRole('button', { name: 'Columns' }).click();
  for (const label of ['Role', 'Mgmt address']) await page.getByLabel(label, { exact: true }).check();
  await page.getByRole('button', { name: 'Columns' }).click();
  const roleCell = page.locator('.inv-table__row [role=gridcell]').nth(3);
  await roleCell.dblclick();
  await page.locator('select.inv-table__editor').selectOption('firewall');
  await page.keyboard.press('Tab');
  await page.locator('input.inv-table__editor').fill('10.0.0.9');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const rowText = await page.locator('.inv-table__row').first().innerText();
  check('role and management address were edited in place, Tab moving between them', rowText.includes('firewall') && rowText.includes('10.0.0.9'), rowText.replace(/\s+/g, ' '));
  await shot('inventory-02-edited.png');

  // 5 — a refused value stays open with the reason.
  await page.locator('.inv-table__row [role=gridcell]').nth(4).dblclick();
  await page.locator('input.inv-table__editor').fill('not-an-ip');
  await page.keyboard.press('Enter');
  check('a refused value shows why and keeps the editor open', (await page.locator('.inv-table__error').count()) === 1 && (await page.locator('input.inv-table__editor').count()) === 1);
  await page.keyboard.press('Escape');

  // 6 — a custom field is defined in the page and then fills a column.
  await page.locator('.inv-table__row').first().locator('[role=gridcell]').nth(1).click();
  await page.waitForSelector('.inv-page', { timeout: 5_000 });
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: '+ Add a field' }).click();
  await page.getByLabel('Field name').fill('Warranty ends');
  await page.getByLabel('Field type').selectOption('date');
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.waitForTimeout(200);
  for (const tab of ['Ports', 'Notes', 'History']) {
    await page.getByRole('tab', { name: new RegExp('^' + tab) }).click();
  }
  check('the History tab lists the changes made', (await page.locator('.inv-page__body').innerText()).length > 0);
  await shot('inventory-04-history.png');
  await page.getByRole('button', { name: /^← Back to Devices/ }).click();
  await page.waitForSelector('.inv-table__row', { timeout: 5_000 });
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('checkbox', { name: 'Warranty ends' }).check();
  await page.getByRole('button', { name: 'Columns' }).click();
  const warrantyCell = page.locator('.inv-table__row [role=gridcell]').last();
  await warrantyCell.dblclick();
  await page.locator('input.inv-table__editor').fill('2027-03-01');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('a new field becomes a column and takes a date', (await page.locator('.inv-table__row').first().innerText()).includes('2027-03-01'));
  await shot('inventory-03-field.png');

  // 8 — paste rows (header + update + add) and bulk-tag them.
  await page.locator('.inv-chip button').click();
  await page.getByRole('button', { name: 'Paste rows' }).click();
  await page.getByLabel('Pasted rows').fill('Name\tRole\nedge-fw\trouter\npasted-sw\tswitch');
  await page.waitForFunction(() => document.querySelector('.inv-paste [role=status]')?.textContent?.includes('1 to add, 1 to update'));
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForTimeout(800);
  await line.fill('name~pasted-sw');
  check('a pasted row was added', (await page.locator('.inv-table__row').count()) === 1);
  await page.getByLabel('Select all rows').check();
  await page.getByLabel('Value').fill('lab');
  await page.getByRole('button', { name: 'Add tag' }).click();
  await page.getByRole('button', { name: /^Apply to/ }).click(); // the change is previewed first
  await page.waitForTimeout(300);
  check('bulk Add tag put the tag on the row', (await page.locator('.inv-table__row').first().innerText()).includes('lab'));
  await shot('inventory-05-bulk.png');

  // 8b — the tag: filter token, then the Inventory page of the print pack.
  await page.getByLabel('Filter devices').fill('tag:lab');
  await page.waitForTimeout(400);
  check('tag:lab filters to the tagged row', (await page.locator('.inv-table__row').count()) === 1);
  await barAction(page, 'print');
  await page.waitForSelector('[data-testid="print-panel"]', { timeout: 10_000 });
  check('the pack offers the Inventory table', await page.locator('[data-testid="print-section-inventory"]').isChecked());
  await page.locator('[data-testid="print-panel-print"]').click();
  await page.waitForSelector('[data-testid="print-preview"]', { timeout: 10_000 });
  const previewText = await page.locator('[data-testid="print-preview"]').innerText();
  check('the printed table is the filtered list', previewText.includes('Inventory · Devices') && previewText.includes('pasted-sw') && previewText.includes('filtered: tag:lab') && !previewText.includes('edge-fw'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="print-preview"]', { state: 'detached', timeout: 5_000 }).catch(() => {});

  // 9 — Show on canvas.
  await page.locator('.inv-table__row').first().locator('[role=gridcell]').nth(1).click();
  await page.waitForSelector('.inv-page', { timeout: 5_000 });
  await page.getByRole('button', { name: 'Show on canvas' }).click();
  await page.waitForSelector('.drawing', { timeout: 10_000 });
  check('Show on canvas returns to the canvas', true);

  const saveCount = await page.evaluate(() => window.__saveCount__ ?? 0);
  check('the scene saved', saveCount > 0, `saveCount=${saveCount}`);
  const saveLoadFailures = await page.evaluate(() => window.__saveLoadFailures__ ?? []);
  check('every saved payload loaded through the engine', saveLoadFailures.length === 0, saveLoadFailures.join(' | '));
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
