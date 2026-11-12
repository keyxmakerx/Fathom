// Drives the Links lens on the canvas (sign-off r109: VLAN colour on access lines, hollow trunks, weight by
// speed, a Networks key) through the real App in a real browser, and saves before and after screenshots.
// Scene `links`: edge-fw, core-sw, acc-sw1, srv-01, nas-01; VLANs 10, 20 and 30; speeds set on interfaces.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-links-lens.mjs.
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
  viteProc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], { cwd: CLIENT, stdio: ['ignore', 'pipe', 'pipe'] });
  let viteLog = '';
  viteProc.stdout.on('data', (d) => { viteLog += d.toString(); });
  viteProc.stderr.on('data', (d) => { viteLog += d.toString(); });
  const up = await waitForServer(`${BASE}/drive.html`, 30_000);
  check('client dev server answers /drive.html', up, up ? '' : viteLog.slice(-2000));
  if (!up) throw new Error('dev server did not come up');

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/drive.html?scene=links`);
  await page.waitForSelector('.react-flow__node-chassis', { timeout: 15_000 }).catch((e) => { console.log('PAGEERR', pageErrors.join(' | ')); throw e; });

  // In the Rack look the Links lens says where it draws, and offers the Diagram look.
  await page.getByRole('button', { name: 'Links', exact: true }).click();
  await page.waitForTimeout(300);
  check('in the Rack look the Links lens points to the Diagram look', (await page.getByTestId('links-lens-rack-note').count()) === 1);
  await page.screenshot({ path: SHOTS + 'links-lens-rack.png' });
  await page.getByRole('button', { name: 'Cables', exact: true }).click();

  await page.locator('[aria-label="Views"]').getByText('Diagram', { exact: true }).click();
  await page.waitForSelector('.drawing-diagram-box');
  await page.click('button[aria-label="Fit to view"]').then(() => page.waitForTimeout(700));
  check('no Networks key before the lens is lit', (await page.getByTestId('links-lens-key').count()) === 0);
  const inkOnly = await page.locator('.drawing-cable path[stroke^="var(--vlan"]').count();
  check('with the Cables lens every line is ink', inkOnly === 0, String(inkOnly));
  await page.screenshot({ path: SHOTS + 'links-lens-off.png' });

  await page.getByRole('button', { name: 'Links', exact: true }).click();
  await page.waitForTimeout(500);
  const coloured = await page.locator('.drawing-cable path[stroke^="var(--vlan"]').count();
  check('access lines take their VLAN colour', coloured >= 3, String(coloured));
  const cores = await page.getByTestId('links-trunk-core').count();
  check('the trunk is drawn hollow', cores === 1, String(cores));
  const key = await page.getByTestId('links-key-row').allInnerTexts();
  check('the Networks key lists VLANs 10, 20 and 30 by name', key.length === 3 && key[0].includes('Users') && key[1].includes('Servers') && key[2].includes('Wi-Fi'), key.join(' | '));
  const widths = await page.locator('.drawing-cable > path:first-child').evaluateAll((ps) => ps.map((p) => p.getAttribute('stroke-width')));
  check('a 10G line is drawn thicker than a 1G line', widths.includes('3.6px') && widths.includes('1.8px'), widths.join(' '));
  check('the boxes are not coloured', (await page.locator('.drawing-diagram-box[style*="vlan"]').count()) === 0);
  await page.screenshot({ path: SHOTS + 'links-lens-on.png' });
  // Speed tags (r109 item 5): where each line meets a box, in every lens.
  const tags = await page.getByTestId('diagram-speed-tag').allTextContents();
  check('each set port speed is tagged where its line meets the box', tags.filter((t) => t === '10G').length === 4 && tags.filter((t) => t === '1G').length === 4, tags.join(' '));
  await page.getByRole('button', { name: 'Cables', exact: true }).click();
  await page.waitForTimeout(300);
  check('the speed tags stay under the Cables lens', (await page.getByTestId('diagram-speed-tag').count()) === 8);
  await page.screenshot({ path: SHOTS + 'speed-tags-cables.png' });

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
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
