// Drives the keyboard shortcuts button (the round "?" beside the account square) through the real App in
// a real browser, fetch answered by the shared harness, and saves screenshots for the Sign-offs card.
// Scene `canvas`. Clicks the button, checks the sheet lists every group, closes it with Esc, then opens
// it again with "?" to prove the key and the button reach the same sheet. Light and dark.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-shortcuts.mjs.
// Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT, FATHOM_SHOTS.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, fails, waitForServer } from './drive-lib/kit.mjs';

const pw = await import(process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js');
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const CLIENT = ROOT + '/client';
const DRIVE_LIB = ROOT + '/scripts/drive-lib';
const PORT = 5211;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

if (!existsSync(CLIENT + '/public/engine/fathom_wasm.wasm')) {
  execFileSync('bash', [ROOT + '/scripts/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
for (const f of [PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE]) {
  if (existsSync(f)) {
    console.error(`refusing to run: ${f} already exists (left from an earlier run?); remove it first`);
    process.exit(2);
  }
}
writeFileSync(PREVIEW_HTML, `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><title>Fathom drive preview (not shipped)</title></head>
<body><div id="root"></div><script type="module" src="/src/drive.tsx"></script></body></html>
`);
copyFileSync(DRIVE_LIB + '/harness.tsx', PREVIEW_TSX);
copyFileSync(DRIVE_LIB + '/seed.ts', PREVIEW_SEED);
copyFileSync(DRIVE_LIB + '/catalogue.json', PREVIEW_CATALOGUE);

let viteProc = null;
let browser = null;
try {
  viteProc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], { cwd: CLIENT, stdio: ['ignore', 'pipe', 'pipe'] });
  let viteLog = '';
  viteProc.stdout.on('data', (d) => { viteLog += d.toString(); });
  viteProc.stderr.on('data', (d) => { viteLog += d.toString(); });
  const up = await waitForServer(`${BASE}/drive.html`, 30_000);
  check('client dev server answers /drive.html', up, up ? '' : viteLog.slice(-2000));
  if (!up) throw new Error('dev server did not come up');

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=canvas`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(800);

    const button = page.getByTestId('shell-shortcuts');
    check(`[${scheme}] the "?" button is in the bar`, (await button.count()) === 1);
    check(`[${scheme}] it sits just before the account square`, await page.evaluate(() => {
      const b = document.querySelector('[data-testid="shell-shortcuts"]');
      const a = document.querySelector('.shell-account');
      return b != null && a != null && b.getBoundingClientRect().right <= a.getBoundingClientRect().left;
    }));
    await page.screenshot({ path: SHOTS + `shortcuts-bar-${scheme}.png`, clip: { x: 900, y: 0, width: 540, height: 60 } });
    await button.hover();
    await page.waitForTimeout(400);

    await button.click();
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await sheet.waitFor({ timeout: 5_000 });
    const text = await sheet.innerText();
    for (const g of ['Canvas', 'Selection', 'Editing', 'Find', 'Lists and panels']) check(`[${scheme}] the sheet shows ${g}`, text.toLowerCase().includes(g.toLowerCase()), text);
    await page.screenshot({ path: SHOTS + `shortcuts-sheet-${scheme}.png` });
    await page.evaluate(() => { const b = document.querySelector('.shortcuts-sheet__body'); const s = document.querySelector('.shortcuts-sheet'); for (const el of [b, s]) if (el) el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(200);
    await page.screenshot({ path: SHOTS + `shortcuts-sheet-end-${scheme}.png` });

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check(`[${scheme}] Esc closes it`, (await sheet.count()) === 0);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('Shift+Slash');
    await page.waitForTimeout(200);
    check(`[${scheme}] "?" opens the same sheet`, (await sheet.count()) === 1);
    check(`[${scheme}] no page errors`, pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }
  console.log('    wrote ' + SHOTS + 'shortcuts-*.png');
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
