// Drives the wonky shelf cable (r132): in the rack, a cable from a thing folded into a shelf's "+N" to a
// two-row switch below. Screenshots the rack close up in light and dark. Usage: bash scripts/build-wasm.sh
// (once), then node scripts/drive-shelf-cable.mjs. Screenshots land in FATHOM_SHOTS.
// Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
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
const PORT = 5362;
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

  // -------------------------------------------------------------------------
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  async function open(scene, opts = {}) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: opts.scheme ?? 'light' });
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

  // The same rule between two switches in one rack (the canvas scene): ports in different rows drop
  // into each other rather than looping out of their rows.
  {
    const { context, page } = await open('canvas');
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await page.waitForTimeout(500);
    for (let i = 0; i < 3; i += 1) {
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await page.waitForTimeout(250);
    }
    const rack = await page.locator('.react-flow__node-rack').first().boundingBox();
    await page.mouse.move(40, 450);
    await page.mouse.down();
    await page.mouse.move(40 + (700 - (rack.x + rack.width / 2)), 450 + (450 - (rack.y + rack.height * 0.6)), { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector('.drawing-cable path', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(900);
    await shot(page, 'shelf-cable-switches');
    await context.close();
  }

  for (const scheme of ['light', 'dark']) {
    const { context, page, pageErrors } = await open('shelf-cable', { scheme });
    const shelf = page.locator('.react-flow__node-shelf').first();
    check('the full shelf folds the rest into "+N"', (await page.locator('.drawing-shelf__compact-more').count()) === 1);
    // Close up on the shelf and the switch below it: fit, zoom in, then drag the pane so the shelf sits
    // in the middle of the window.
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await page.waitForTimeout(500);
    for (let i = 0; i < 5; i += 1) {
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await page.waitForTimeout(250);
    }
    const b = await shelf.boundingBox();
    await page.getByRole('button', { name: 'Hand', exact: false }).first().click().catch(() => {});
    await page.mouse.move(40, 450);
    await page.mouse.down();
    await page.mouse.move(40 + (700 - (b.x + b.width / 2)), 450 + (330 - b.y), { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector('.drawing-cable path', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(900);
    await shot(page, `shelf-cable-${scheme}`);
    const d = await page.evaluate(() => [...document.querySelectorAll('.drawing-cable path')].map((p) => p.getAttribute('d')).filter(Boolean));
    check('the cables draw', d.length > 0, String(d.length));
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (viteProc) {
    viteProc.kill();
    try { execFileSync('fuser', ['-k', `${PORT}/tcp`]); } catch { /* nothing was listening */ }
  }
  for (const f of [PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE]) {
    if (existsSync(f)) rmSync(f);
  }
}

console.log(fails.length ? '\nFAILURES:\n  ' + fails.join('\n  ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
