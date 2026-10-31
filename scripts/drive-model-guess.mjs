// Proves the catalogue-model guess for a box typed by hand (2026-10-31, the owner's "sweetch"): the panel says it looks
// like the DCS-7050S-52 its note names, "See what changes" opens the swap preview on it, and the swap keeps Et49's cable
// on port 49. Screenshots of the 52-port box after, for how a dense faceplate reads.
//
// Usage:
//   bash scripts/build-wasm.sh   # once, if the artefact is stale
//   node scripts/drive-model-guess.mjs
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDriveCpuThrottle } from './drive-lib/cpuThrottle.mjs';
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
const PORT = 5347;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

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
// 5173 default, so it never collides with anyone else's `npm run dev`.
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
  // Step 3: drive it.
  // -------------------------------------------------------------------------
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await applyDriveCpuThrottle(page);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/drive.html?scene=sweetch`);
  await page.waitForSelector('.react-flow__node-chassis', { timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: SHOTS + 'G-01-rack-typed.png' });

  const zoomIn = async (times, shot) => {
    for (let i = 0; i < times; i += 1) await page.getByRole('button', { name: /zoom in/i }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    const n = page.locator('.react-flow__node-chassis', { hasText: 'sweetch' }).first();
    await n.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: SHOTS + shot });
  };
  await zoomIn(4, 'G-01b-typed-zoomed.png');
  // Select sweetch: the chassis whose text says so.
  const sweetch = page.locator('.react-flow__node-chassis', { hasText: 'sweetch' }).first();
  await sweetch.click({ position: { x: 4, y: 4 } });
  if (!(await page.locator('.drawing-editor__panel').isVisible())) await page.getByTestId('dock-details').click();
  await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
  const panel = page.locator('.drawing-editor__panel');
  if ((await panel.getByRole('tab', { name: 'Details' }).count()) > 0) await panel.getByRole('tab', { name: 'Details' }).click();
  const guess = panel.getByTestId('model-guess');
  await guess.waitFor({ timeout: 10_000 }).catch(() => {});
  const guessText = (await guess.count()) > 0 ? await guess.innerText() : '';
  check('the panel says it looks like the Arista DCS-7050S-52', guessText.includes('Arista DCS-7050S-52'), guessText);
  check('and says why: its notes name it', guessText.includes('Its notes name the DCS-7050S-52.'), guessText);
  check('and that all 13 ports carry over', guessText.includes('All 13 typed ports carry over'), guessText);
  await panel.screenshot({ path: SHOTS + 'G-02-guess.png' });

  await guess.getByRole('button', { name: 'See what changes' }).click();
  await page.waitForTimeout(300);
  const planText = await panel.locator('.drawing-editor__swap-plan').innerText().catch(() => '');
  check('the swap preview opens on the guessed model', (await panel.getByLabel('New model').inputValue()) === 'arista|DCS-7050S-52');
  check('the preview drops no port', !/goes|dropped|removed/i.test(planText), planText);
  await panel.screenshot({ path: SHOTS + 'G-03-preview.png' });

  await panel.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.waitForTimeout(600);
  const after = await panel.innerText();
  check('the guess is gone once it has a model', (await panel.getByTestId('model-guess').count()) === 0);
  check('Et49 is now port 49 with its cable', /Connections · 1/i.test(after), after.slice(0, 400));
  await page.screenshot({ path: SHOTS + 'G-04-swapped.png' });
  const node = page.locator('.react-flow__node-chassis', { hasText: 'sweetch' }).first();
  await node.screenshot({ path: SHOTS + 'G-05-faceplate.png' });
  const box = await node.boundingBox();
  check('the 52-port box is drawn', box != null && box.width > 0, JSON.stringify(box));
  await panel.screenshot({ path: SHOTS + 'G-06-panel-after.png' });
  await zoomIn(3, 'G-07-swapped-zoomed.png');

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
