// Proves the Show menu (ADR-0061 round 10): ticks for Addresses, VLANs and Tags put words on the Diagram look, never overlapping.
// Run: bash scripts/build-wasm.sh (if stale), then node scripts/drive-show.mjs.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDriveCpuThrottle } from './drive-lib/cpuThrottle.mjs';

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
const PORT = 5336;
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

// Step 0: the wasm artefact. `Engine.init()` boots it on a chassis
// selection (`RacksPlace.tsx`) even though this drive never pastes.
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

// Step 2: the client dev server, this run's own port — never the shared
// 5173 default, so it never collides with `drive-hand-entry.mjs`'s 5330.
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

  // -------------------------------------------------------------------------
  // Step 3: drive it.
  // -------------------------------------------------------------------------
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await applyDriveCpuThrottle(page);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/drive.html?scene=show`);
  await page.waitForSelector('.react-flow__node-chassis', { timeout: 15_000 }).catch((e) => { console.log('PAGEERR', pageErrors.join(' | ')); throw e; });
  await page.getByLabel('Look').getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.waitForSelector('.drawing-diagram-box');
  await page.click('button[aria-label="Fit to view"]').then(() => page.waitForTimeout(700));
  const labels = () => page.locator('.drawing-layer-label').allInnerTexts();
  check('Show starts with nothing ticked that has data: no words on the canvas', (await labels()).length === 0);

  await page.getByTestId('shell-show').click();
  const items = await page.locator('.shell-show__row').allInnerTexts();
  check('menu lists the layers: Checks, Addresses, VLANs, Docs, Maintenance, Tags', items.length === 6 && items.every((t) => /Checks|Addresses|VLANs|Docs|Maintenance|Tags/.test(t)), items.join(' | '));
  await page.screenshot({ path: SHOTS + 'show-menu.png' });
  await page.getByTestId('show-addresses').click();
  await page.getByTestId('show-vlans').click();
  await page.getByTestId('show-tags').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const words = await labels();
  check('an address labels the line', words.some((t) => /10\.0\.20\.1/.test(t)), words.join(' | '));
  check('the VLAN labels the line', words.some((t) => /VLAN 20/.test(t)), words.join(' | '));
  check('the tag is plain text on the device', (await page.locator('.drawing-diagram-box__words', { hasText: 'edge' }).count()) === 1);
  const boxes = await page.locator('.drawing-layer-label').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  const clash = boxes.some((a, i) => boxes.some((b, j) => i < j && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
  check('no two labels overlap', !clash);
  await page.screenshot({ path: SHOTS + 'show-on.png' });

  // (the harness mints a new account each load, so persistence is layers.test.ts's)
  await page.getByTestId('shell-show').click();
  await page.getByTestId('show-tags').click();
  await page.getByTestId('show-addresses').click();
  await page.getByTestId('show-vlans').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('unticking clears the words', (await labels()).length === 0 && (await page.locator('.drawing-diagram-box__words').count()) === 0);

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

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
