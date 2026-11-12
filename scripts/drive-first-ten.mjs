// Drives the first ten minutes (r115 thread 4): the sample opens at a zoom its names can be read at; Diagram draws
// every one of the sample's devices, not only the racked ones; nothing stacks on an empty design (the hint clears
// the zoom pill). Screenshots land in FATHOM_SHOTS. Usage: bash scripts/build-wasm.sh (once), then
// node scripts/drive-first-ten.mjs. Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, fails, waitForServer } from './drive-lib/kit.mjs';

const pw = await import(
  process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js'
);
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM
  || '/opt/pw-browsers/chromium';
const CLIENT = ROOT + '/client';
const DRIVE_LIB = ROOT + '/scripts/drive-lib';
const PORT = 5352;
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

// Step 1: copy the shared throwaway harness into `client/`. Refuses to run
// if any of these already exists, so it never overwrites another run's files.
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fathom — proof preview (throwaway, not shipped)</title>
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

  // -------------------------------------------------------------------------
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  async function open(scene, opts = {}) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=${scene}`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(600);
    return { context, page, pageErrors };
  }
  const shot = async (page, name) => {
    await page.screenshot({ path: SHOTS + name + '.png' });
    console.log('    wrote ' + SHOTS + name + '.png');
  };

  const SAMPLE_DEVICES = ['router-1', 'switch-1', 'switch-2', 'nas-1', 'server-1', 'pi-1', 'desktop-1', 'printer-1', 'camera-1', 'camera-2', 'ap-1'];

  // 1. The sample opens readable.
  {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const pct = Number.parseFloat(await page.locator('.shell-pill__value').innerText());
    check('the sample opens at 60% or more, so names can be read', pct >= 60, `${pct}%`);
    await shot(page, 'FT-01-sample-opens');

    // 2. Diagram draws every device.
    await page.locator('[aria-label="Views"]').getByText('Diagram', { exact: true }).click();
    await page.waitForSelector('.react-flow__node-diagramBox', { timeout: 15_000 });
    await page.waitForTimeout(800);
    const text = (await page.locator('.react-flow__node-diagramBox').allInnerTexts()).join(' ');
    for (const host of SAMPLE_DEVICES) check(`Diagram draws ${host}`, text.includes(host));
    check('Diagram draws all 11 devices', (await page.locator('.react-flow__node-diagramBox').count()) === 11, String(await page.locator('.react-flow__node-diagramBox').count()));
    console.log('    viewport ' + await page.locator('.react-flow__viewport').getAttribute('style') + ' pane ' + JSON.stringify(await page.locator('.react-flow__pane').boundingBox()));
    // The "Try a question" card must not sit on any box.
    const card = await page.getByTestId('ready-questions').boundingBox();
    const covered = [];
    for (const box of await page.locator('.react-flow__node-diagramBox').all()) {
      const b = await box.boundingBox();
      if (card != null && b != null && b.x < card.x + card.width && b.x + b.width > card.x && b.y < card.y + card.height && b.y + b.height > card.y) covered.push(await box.innerText());
    }
    check('no device in Diagram is under the Try a question card', covered.length === 0, covered.join(', '));
    await shot(page, 'FT-02-diagram');
    check('no uncaught page errors (sample)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // 3. An empty design: the hint clears the zoom pill.
  {
    const { context, page, pageErrors } = await open('empty');
    await page.waitForSelector('.drawing-empty-hint', { timeout: 15_000 });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    const hint = await page.locator('.drawing-empty-hint').boundingBox();
    const pill = await page.locator('.shell-pill').boundingBox();
    check('the empty-design hint ends above the zoom pill', hint != null && pill != null && hint.y + hint.height <= pill.y, JSON.stringify({ hint, pill }));
    const add = await page.getByTestId('add-equipment').boundingBox();
    check('Add equipment is whole and clear of the zoom pill', add != null && pill != null && add.y + add.height <= pill.y);
    await shot(page, 'FT-03-empty-design');
    check('no uncaught page errors (empty)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

} finally {
  // Cleanup, even on failure — nothing the harness needs may stay in `client/`.
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
