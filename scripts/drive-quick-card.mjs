// Drives the quick card (Key Maker, 31 October): a click on a racked device puts a small card beside it with
// its kind, name and management address, Copy puts the address on the clipboard, Details shows the panel,
// the card follows a pan, and Escape, an empty-canvas click and a double-click put it away. Screenshots land
// in FATHOM_SHOTS. Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-quick-card.mjs.
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
const PORT = 5341;
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
  const boxes = (page) => page.locator('.react-flow__node-freeBox');
  const pickKind = async (page, label) => {
    await page.locator('.drawing-context-menu__item', { hasText: label }).first().click();
    await page.waitForTimeout(300);
  };
  const addBoxAt = async (page, x, y, kind) => {
    await page.mouse.click(x, y, { button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Add a box here' }).click();
    await pickKind(page, kind);
  };

  {
    const { context, page, pageErrors } = await open('print-loft');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const card = page.locator('[data-testid=quick-card]');
    const sw = page.locator('.react-flow__node-chassis', { hasText: 'sw-core' }).first();
    await sw.waitFor({ timeout: 10_000 });
    await sw.click();
    await page.waitForTimeout(400);
    check('a click on a device shows the quick card', await card.isVisible());
    const text = (await card.textContent()) ?? '';
    check('it names the device and its address', text.includes('sw-core') && text.includes('10.20.0.2'), text);
    check('the right panel opened as before', await page.getByRole('button', { name: /^open inside$/i }).first().isVisible());
    const cardBox = await card.boundingBox();
    const devBox = await sw.boundingBox();
    check('the card sits beside the device, not over it', cardBox != null && devBox != null && (cardBox.x >= devBox.x + devBox.width || cardBox.x + cardBox.width <= devBox.x), JSON.stringify({ cardBox, devBox }));
    check('a dotted line joins them', (await page.locator('.quick-card__leader').count()) === 1);
    await shot(page, 'quick-card-device');

    await card.getByRole('button', { name: 'Copy' }).click();
    await page.waitForTimeout(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    check('Copy puts the address on the clipboard', clip === '10.20.0.2', clip);
    check('Copy says so', ((await card.textContent()) ?? '').includes('Copied'));

    // A pan: the card follows.
    const before = await card.boundingBox();
    const pane = page.locator('.react-flow__pane');
    const pb = await pane.boundingBox();
    await page.mouse.move(pb.x + 30, pb.y + pb.height - 30);
    await page.mouse.down();
    await page.mouse.move(pb.x + 90, pb.y + pb.height - 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await card.boundingBox();
    check('the card follows the device when the canvas pans', before != null && after != null && Math.abs(after.x - before.x - 60) < 4, JSON.stringify({ before, after }));

    await card.getByRole('button', { name: 'Details' }).click();
    await page.waitForTimeout(200);
    check('Details leaves the card up', await card.isVisible());

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('Escape puts the card away', (await card.count()) === 0);

    await sw.click();
    await page.waitForTimeout(300);
    check('a second click brings it back', await card.isVisible());
    await page.mouse.click(pb.x + 20, pb.y + 20);
    await page.waitForTimeout(300);
    check('a click on empty canvas puts it away', (await card.count()) === 0);

    const rack = page.locator('.react-flow__node-rack').first();
    const rb = await rack.boundingBox();
    await page.mouse.click(rb.x + 8, rb.y + rb.height - 8);
    await page.waitForTimeout(300);
    if (await card.isVisible()) {
      check('a rack says it is a rack', ((await card.textContent()) ?? '').includes('Rack'));
      await shot(page, 'quick-card-rack');
    }

    await sw.dblclick();
    await page.waitForTimeout(400);
    check('a double-click opens the device and puts the card away', (await card.count()) === 0);
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  await browser.close();
  browser = null;
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
