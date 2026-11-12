// Drives Inventory › Networks › Routes (sign-off r96, round 1) through the real App in a real
// browser, fetch answered by the shared harness, and saves screenshots for the Sign-offs card.
// Scene `networks` (five sketch devices). Adds a default route and a static route by hand, then
// shows a refusal.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-routes.mjs.
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
const PORT = 5199;
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
  viteProc = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: CLIENT, stdio: ['ignore', 'pipe', 'pipe'] });
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
  await page.goto(`${BASE}/drive.html?scene=networks`);
  await page.waitForSelector('.shell-bar__tab', { timeout: 15_000 });
  await page.locator('.shell-bar__tab', { hasText: 'Inventory' }).click();
  await page.waitForSelector('.inventory-place__kind', { timeout: 15_000 });
  await page.locator('.inventory-place__kind', { hasText: 'Networks' }).click();
  await page.waitForSelector('section[aria-label="Routes"]', { timeout: 15_000 });
  const routes = page.locator('section[aria-label="Routes"]');
  await routes.scrollIntoViewIfNeeded();

  check('routes: starts empty', (await routes.innerText()).includes('No routes yet.'));
  await routes.screenshot({ path: SHOTS + 'routes-empty.png' });

  await routes.getByRole('button', { name: 'Add route' }).click();
  const form = routes.locator('form[aria-label="Add a route"]');
  await form.locator('select').first().selectOption({ label: 'sketch-a' });
  await form.locator('input').nth(0).fill('default');
  await form.locator('input').nth(1).fill('10.0.0.1');
  await routes.screenshot({ path: SHOTS + 'routes-form.png' });
  await form.getByRole('button', { name: 'Add route' }).click();
  await page.waitForTimeout(200);

  await form.locator('select').first().selectOption({ label: 'sketch-b' });
  await form.locator('input').nth(0).fill('10.20.0.0/16');
  await form.locator('input').nth(1).fill('10.0.0.254');
  await form.getByRole('button', { name: 'Add route' }).click();
  await page.waitForTimeout(200);

  // A refusal: host bits set.
  await form.locator('select').first().selectOption({ label: 'sketch-b' });
  await form.locator('input').nth(0).fill('10.20.0.1/16');
  await form.locator('input').nth(1).fill('10.0.0.254');
  await form.getByRole('button', { name: 'Add route' }).click();
  await page.waitForTimeout(200);
  const text = await routes.innerText();
  check('routes: two routes listed', text.includes('2 routes'), text);
  check('routes: the bad prefix is refused in words', text.includes('is not a network'), text);
  await routes.screenshot({ path: SHOTS + 'routes-filled.png' });

  await form.getByRole('button', { name: 'Close' }).click();
  await routes.screenshot({ path: SHOTS + 'routes-list.png' });
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  console.log('    wrote ' + SHOTS + 'routes-*.png');
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
