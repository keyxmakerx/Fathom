// Proves the look switch (ADR-0061 round 7): Rack and Diagram, a cable to a far
// rack drawn in full while both ends are on screen and as stubs with a tag that pans once one is not, the choice kept per account and design (look.test.ts; the harness mints a new account each load, so no reload check here).
// Run: bash scripts/build-wasm.sh (if stale), then node scripts/drive-look.mjs.
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
const PORT = 5334;
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

  await page.goto(`${BASE}/drive.html?scene=look`);
  await page.waitForSelector('.react-flow__node-chassis', { timeout: 15_000 });
  const camera = () => page.evaluate(() => document.querySelector('.react-flow__viewport').style.transform);
  const lookButton = (name) => page.getByLabel('Look').getByRole('button', { name, exact: true });

  check('starts on Rack', (await lookButton('Rack').getAttribute('aria-pressed')) === 'true');
  check('rack faceplates are drawn', (await page.locator('.react-flow__node-chassis').count()) >= 4);
  const fit = () => page.click('button[aria-label="Fit to view"]').then(() => page.waitForTimeout(700));
  const fullCables = () => page.locator('.drawing-cable:not(.drawing-cable--stub)').count();
  const zoomIn = async (target) => {
    const box = await target.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -2400);
    await page.keyboard.up('Control');
    await page.waitForTimeout(700);
  };
  await fit();
  check('every end on screen: the cable draws in full, no stubs', (await page.locator('.drawing-stub__tag').count()) === 0 && (await fullCables()) >= 1);
  await zoomIn(page.locator('.react-flow__node-chassis', { hasText: 'fw-01' }));
  const rackTags = await page.locator('.drawing-stub__tag').allInnerTexts();
  check('far end off screen: stubs with tags naming each far end', rackTags.some((t) => /sw-09 · in rack R7/.test(t)) && rackTags.some((t) => /fw-01 · in rack A-04/.test(t)), rackTags.join(' | '));
  await page.locator('.drawing-stub__tag', { hasText: 'sw-09' }).hover();
  await page.waitForTimeout(200);
  check('hovering a tag draws the whole cable', (await fullCables()) >= 1);
  const before = await camera();
  await page.locator('.drawing-stub__tag', { hasText: 'sw-09' }).click();
  await page.waitForTimeout(700);
  check('clicking a tag pans to the far end', (await camera()) !== before);

  await lookButton('Diagram').click();
  await page.waitForSelector('.drawing-diagram-box');
  check('diagram: one plain box per device', (await page.locator('.drawing-diagram-box').count()) === 4, String(await page.locator('.drawing-diagram-box').count()));
  check('diagram: no faceplate ports', (await page.locator('.react-flow__node-chassis').count()) === 0);
  const hrefs = await page.locator('.react-flow__edge path[stroke]:not([stroke="transparent"])').evaluateAll((els) => els.map((e) => e.getAttribute('d')));
  check('diagram: lines turn only at right angles', hrefs.length > 0 && hrefs.every((d) => {
    const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    for (let i = 2; i < n.length - 1; i += 2) if (n[i] !== n[i - 2] && n[i + 1] !== n[i - 1]) return false;
    return true;
  }), `${hrefs.length} paths`);
  await fit();
  check('diagram: every end on screen, the cable draws in full', (await page.locator('.drawing-stub__tag').count()) === 0 && (await fullCables()) >= 1);
  await zoomIn(page.locator('.drawing-diagram-box', { hasText: 'fw-01' }));
  const diaTags = await page.locator('.drawing-stub__tag').allInnerTexts();
  check('diagram: far end off screen, stubs too', diaTags.some((t) => /sw-09 · in rack R7/.test(t)), diaTags.join(' | '));
  await fit();
  await page.locator('.drawing-diagram-box', { hasText: 'core-sw-01' }).click();
  await page.waitForSelector('.drawing-editor__panel', { timeout: 5000 });
  check('selecting a box opens its details', (await page.locator('.drawing-editor__panel').count()) === 1);

  await lookButton('Rack').click();
  await page.waitForSelector('.react-flow__node-chassis');
  check('back to Rack', (await page.locator('.drawing-diagram-box').count()) === 0);

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
