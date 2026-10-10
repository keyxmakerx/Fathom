// Drives the History panel (round 11) through the real `App` with the mocked backend of
// `scripts/drive-lib/harness.tsx` (scene `history`: four versions): open the panel, pick a past
// save (read-only, dashed outline, banner), Back to now, Restore. Screenshots land in FATHOM_SHOTS.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-history.mjs.
// Environment: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT, FATHOM_SHOTS.
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
const PORT = 5341;
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

// ---------------------------------------------------------------------------
const WASM_ARTIFACT = CLIENT + '/public/engine/fathom_wasm.wasm';
if (!existsSync(WASM_ARTIFACT)) {
  console.log('==> building the wasm artefact (missing): bash scripts/build-wasm.sh');
  execFileSync('bash', [ROOT + '/scripts/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
check('the wasm artefact exists', existsSync(WASM_ARTIFACT), WASM_ARTIFACT);

// Never overwrite a file someone already has there.
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
    <title>Fathom — History proof preview (throwaway, not shipped)</title>
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

/** The trail is folded to a strip on the right edge — open it before
 * reading `.racks-trail__row`. A refused undo opens it on its own, but
 * every scene here opens it up front so a screenshot always shows it. */
async function openTheTrail(page) {
  const handle = page.locator('button[aria-label="Open the trail"]');
  if ((await handle.count()) > 0) {
    await handle.click();
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
  await page.goto(`${BASE}/drive.html?scene=history`);
  await page.waitForSelector('[data-testid="shell-history"], [data-testid="shell-more"]', { timeout: 20_000 });
  await page.waitForTimeout(1500);

  await barAction(page, 'history');
  await page.waitForSelector('.history__row', { timeout: 10_000 });
  const summariesDone = () => document.querySelectorAll('.history__what').length > 0 && ![...document.querySelectorAll('.history__what')].some((e) => e.textContent === '…');
  await page.waitForFunction(summariesDone, null, { timeout: 15_000 });
  check('the check reads in words', (await page.locator('[data-testid="history-verify"]').innerText()) .includes('Checked: every save is intact'));
  const whats = await page.locator('.history__what').allTextContents();
  console.log('    summaries: ' + JSON.stringify(whats));
  check('newest first, readable summaries', whats.length === 4 && whats[0].includes('renamed core-01') && whats[3].includes('added core-01'), whats.join(' | '));
  await page.screenshot({ path: SHOTS + 'history-1-panel.png' });

  // Pick the save that added the second device (version 2).
  await page.locator('.history__row').nth(2).click();
  await page.waitForSelector('[data-testid="history-banner"]', { timeout: 10_000 });
  await page.waitForTimeout(800);
  check('a past save shows the banner', (await page.locator('[data-testid="history-banner"]').innerText()).startsWith('Showing the design just after'));
  check('what changed is outlined', (await page.locator('.history-changed').count()) >= 1, String(await page.locator('.history-changed').count()));
  check('the picked row is marked', (await page.locator('.history__row--on').count()) === 1);
  check('Restore is offered on an older save', (await page.getByRole('button', { name: 'Restore this version' }).count()) === 1);
  await page.screenshot({ path: SHOTS + 'history-2-picked.png' });

  await page.getByRole('button', { name: 'Back to now' }).click();
  await page.waitForTimeout(500);
  check('Back to now clears the banner', (await page.locator('[data-testid="history-banner"]').count()) === 0);

  // Restore version 1 (the oldest): one confirm, then a new save.
  await page.locator('.history__row').nth(3).click();
  await page.waitForSelector('[data-testid="history-banner"]');
  await page.getByRole('button', { name: 'Restore this version' }).click();
  await page.waitForSelector('.history__confirm');
  const confirmText = await page.locator('.history__confirm').innerText();
  check('the confirm names what will change', /Compared with now/.test(confirmText), confirmText);
  await page.screenshot({ path: SHOTS + 'history-3-restore-confirm.png' });
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.waitForTimeout(2500);
  const saves = await page.evaluate(() => window.__saveCount__);
  check('restoring made one new save', saves === 1, String(saves));

  await barAction(page, 'history');
  await page.waitForFunction(() => document.querySelectorAll('.history__row').length === 5, null, { timeout: 10_000 });
  await page.waitForFunction(summariesDone, null, { timeout: 15_000 });
  const after = await page.locator('.history__what').allTextContents();
  console.log('    after restore: ' + JSON.stringify(after));
  check('the restore is listed as a new save', after.length === 5 && /Restored the save/.test(after[0]), after[0]);
  await page.screenshot({ path: SHOTS + 'history-4-after-restore.png' });
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
