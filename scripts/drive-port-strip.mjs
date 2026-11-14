// Drives the switch port strip on the Diagram look (sign-off r109, item 4) through the real App in a real
// browser: a switch's box shows its data ports along its bottom edge, and each cable leaves from its port.
// Scene `strip`: rack A-04 with edge-fw and two switches, rack B-01 with two servers and a NAS.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-port-strip.mjs.
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
const PORT = 5201;
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
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/drive.html?scene=strip`);
  await page.waitForSelector('.react-flow__node-chassis', { timeout: 15_000 }).catch((e) => { console.log('PAGEERR', pageErrors.join(' | ')); throw e; });

  await page.locator('[aria-label="Views"]').getByText('Diagram', { exact: true }).click();
  await page.waitForSelector('.drawing-diagram-box');
  await page.click('button[aria-label="Fit to view"]').then(() => page.waitForTimeout(700));

  const strips = page.getByTestId('diagram-port-strip');
  check('the two switches show a port strip, and nothing else does', (await strips.count()) === 2, String(await strips.count()));
  const cells = await page.getByTestId('diagram-strip-port').count();
  check('the strips hold the switches\' data ports', cells >= 24 + 24, String(cells));
  const cabled = await page.locator('.drawing-port-strip__port--cabled').count();
  check('the seven cabled switch ports are filled: four on core-sw, three on acc-sw1', cabled === 7, String(cabled));

  // Each line from a switch leaves under its cabled port; the one line from the box above (acc-sw1 to
  // core-sw) meets core-sw's top edge straight over its port.
  const ends = await page.evaluate(() => {
    const cellsAll = [...document.querySelectorAll('.drawing-port-strip__port--cabled')].map((c) => c.getBoundingClientRect());
    const boxes = [...document.querySelectorAll('.drawing-diagram-box--strip')].map((b) => b.getBoundingClientRect());
    let under = 0;
    let over = 0;
    for (const g of document.querySelectorAll('.drawing-cable')) {
      const path = g.querySelector('path');
      if (!path) continue;
      const len = path.getTotalLength();
      const ctm = path.getScreenCTM();
      for (const t of [0, len]) {
        const p = path.getPointAtLength(t).matrixTransform(ctm);
        if (cellsAll.some((r) => p.x >= r.left - 1 && p.x <= r.right + 1 && p.y >= r.bottom - 1 && p.y <= r.bottom + 2 * r.height + 8)) under += 1;
        else if (boxes.some((b) => Math.abs(p.y - b.top) < 3) && cellsAll.some((r) => p.x >= r.left - 1 && p.x <= r.right + 1)) over += 1;
      }
    }
    return { under, over };
  });
  check('six switch ends leave the box under their own port', ends.under === 6, JSON.stringify(ends));
  check('the line from the switch above meets the top edge straight over its port', ends.over === 1, JSON.stringify(ends));
  await page.screenshot({ path: SHOTS + 'port-strip-after.png' });
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  if (browser) await browser.close();
  if (viteProc) viteProc.kill('SIGTERM');
  for (const f of [PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE]) rmSync(f, { force: true });
  try { execFileSync('fuser', ['-k', `${PORT}/tcp`], { stdio: 'ignore' }); } catch { /* nothing left */ }
}
console.log(fails.length ? '\nFAILURES:\n  ' + fails.join('\n  ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
