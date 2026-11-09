// Proves sign-offs r111 against the real compiled client: Inventory › Tags lists every tag with how
// many things carry it, an empty tag last and marked Not used; Delete asks once, naming the count,
// and takes the tag off everything; the empty tag is no longer offered when typing a tag. Same
// harness as drive-inventory.mjs. Usage: node scripts/drive-delete-tag.mjs  (FATHOM_SHOTS picks the
// screenshot dir)
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
const PORT = 18377;
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
    <title>Fathom — r111 proof preview (throwaway, not shipped)</title>
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const shot = async (name) => {
    await page.screenshot({ path: SHOTS + name });
    console.log('    wrote ' + SHOTS + name);
  };

  await page.goto(`${BASE}/drive.html?scene=inventory`);
  await page.waitForSelector('.drawing', { timeout: 15_000 });
  await page.getByRole('tab', { name: 'Inventory', exact: true }).click();
  await page.waitForSelector('.inv-table__row', { timeout: 15_000 });

  // Tag a few devices through the bulk toolbar, as a person would.
  const line = await openFilter(page, 'Filter devices');
  const bulkTag = async (filter, name, mode = 'Add tag') => {
    await line.fill(filter);
    await page.waitForTimeout(300);
    await page.getByLabel('Select all rows').check();
    await page.getByLabel('Value').fill(name);
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.getByRole('button', { name: /^Apply to/ }).click();
    await page.waitForTimeout(300);
    const all = page.getByLabel('Select all rows');
    if (await all.isChecked()) await all.uncheck();
  };
  await bulkTag('name~bulk-000', 'cameras');
  await bulkTag('name~bulk-001', 'lobby');
  await bulkTag('name~bulk-002', 'old lab');
  await bulkTag('name~bulk-002', 'old lab', 'Remove tag');
  await line.fill('');

  // 1 — the Tags list.
  await page.locator('.inventory-place__rail').getByRole('button', { name: /^Tags/ }).click();
  await page.waitForSelector('.tags-panel__table', { timeout: 5_000 });
  const names = await page.locator('.tags-panel__chip').allTextContents();
  check('Tags lists used tags by name, then the empty one', names.join('|') === 'cameras|core|lobby|old lab', names.join('|'));
  const panelText = await page.locator('.tags-panel').innerText();
  check('an empty tag reads Not used', panelText.includes('Not used'), panelText);
  check('the rail counts 4 tags', /Tags\s*4/.test(await page.locator('.inventory-place__rail').innerText()));
  await shot('r111-tags-list.png');

  // 2 — Delete asks once, saying how many things lose it.
  await page.getByRole('button', { name: 'Delete tag cameras' }).click();
  const confirm = await page.locator('.tags-panel__confirm').innerText();
  check('the confirm names the tag and the count', /Delete “cameras” from \d+ things\?/.test(confirm), confirm);
  await shot('r111-tags-confirm.png');
  await page.getByRole('button', { name: 'Delete tag', exact: true }).click();
  await page.waitForTimeout(300);
  const after = await page.locator('.tags-panel__chip').allTextContents();
  check('cameras is gone from the list', !after.includes('cameras'), after.join('|'));
  check('the notice says Undo puts it back', (await page.locator('.tags-panel__notice').innerText()).includes('Undo puts it back'));
  await shot('r111-tags-deleted.png');

  // 3 — the devices no longer carry it.
  await page.locator('.inventory-place__rail').getByRole('button', { name: /^Devices/ }).click();
  await page.waitForSelector('.inv-table__row', { timeout: 5_000 });
  await (await openFilter(page, 'Filter devices')).fill('name~bulk-000');
  await page.waitForTimeout(300);
  const rowsText = await page.locator('.inv-table').innerText();
  check('no device row still shows cameras', !rowsText.includes('cameras'));

  // 4 — an empty tag is not offered when typing a tag on a page.
  await page.locator('.inv-table__row').first().locator('[role=gridcell]').nth(1).click();
  await page.waitForSelector('.inv-page', { timeout: 5_000 });
  const tagInput = page.locator('.inv-page .tag-chips__input').first();
  if ((await tagInput.count()) > 0) {
    await tagInput.fill('old');
    await page.waitForTimeout(200);
    const offered = await page.locator('.inv-page .tag-chips__suggestion').allTextContents();
    check('the empty "old lab" is not suggested', !offered.some((t) => t.includes('old lab')), offered.join('|'));
    await shot('r111-tags-suggest.png');
    await tagInput.fill('');
  } else {
    check('the device page shows the tag box', false, 'no .tag-chips__input on the page');
  }

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
