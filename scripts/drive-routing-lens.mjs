// Drives the Routing lens on the canvas (sign-off r101, option A: routed against switched) through the
// real App in a real browser, fetch answered by the shared harness, and saves screenshots.
// Scene `routing`: edge-fw, core-sw (gateway of VLAN 11), acc-sw1, srv-01 (gateway set), nas-01 (none).
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-routing-lens.mjs.
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
const PORT = 5198;
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
  await page.goto(`${BASE}/drive.html?scene=routing`);
  await page.waitForSelector('.react-flow__node-chassis', { timeout: 15_000 }).catch((e) => { console.log('PAGEERR', pageErrors.join(' | ')); throw e; });
  await page.locator('[aria-label="Views"]').getByText('Diagram', { exact: true }).click();
  await page.waitForSelector('.drawing-diagram-box');
  await page.click('button[aria-label="Fit to view"]').then(() => page.waitForTimeout(700));
  check('no lens words before the lens is lit', (await page.getByTestId('routing-lens-word').count()) === 0);
  await page.screenshot({ path: SHOTS + 'routing-lens-off.png' });

  await page.getByRole('button', { name: 'Routing', exact: true }).click();
  await page.waitForTimeout(500);
  const word = async (host) => (await page.locator('.drawing-diagram-box', { hasText: host }).locator('[data-testid="routing-lens-word"]').allInnerTexts()).join(' | ');
  check('edge-fw routes', (await word('edge-fw')).includes('ROUTES · 1 TABLE'), await word('edge-fw'));
  check('core-sw is the gateway of VLAN 11', (await word('core-sw')).includes('GW VLAN 11 · 10.10.11.1'), await word('core-sw'));
  check('acc-sw1 switches only', (await word('acc-sw1')) === 'SWITCHES ONLY', await word('acc-sw1'));
  check('srv-01 names its gateway', (await word('srv-01')) === 'GW 10.10.11.1', await word('srv-01'));
  check('nas-01 has no gateway, in caution', (await word('nas-01')) === 'NO GATEWAY' && (await page.locator('.drawing-diagram-box__lens--caution').count()) === 1, await word('nas-01'));
  const labels = await page.locator('.drawing-layer-label').allInnerTexts();
  check('the routed link carries its prefix', labels.some((t) => t.includes('10.255.255.0/31')), labels.join(' | '));
  check('a switched link carries its VLAN', labels.some((t) => /VLAN 11|TRUNK/.test(t)), labels.join(' | '));
  const dashed = await page.locator('.drawing-cable path[stroke-dasharray]').count();
  check('switched links are dashed', dashed >= 3, String(dashed));
  check('the key says what ink and dashes mean', (await page.getByTestId('routing-lens-key').innerText()).toLowerCase().includes('dashed: switched'));
  await page.screenshot({ path: SHOTS + 'routing-lens-on.png' });

  // The device panel's Routing tab, shown first while the lens is lit.
  await page.locator('.drawing-diagram-box', { hasText: 'core-sw' }).click();
  await page.waitForSelector('[data-testid="routing-tab"]', { timeout: 10_000 }).catch(() => {});
  const tab = page.getByTestId('routing-tab');
  const tabText = (await tab.count()) > 0 ? await tab.innerText() : '';
  check('core-sw\'s panel opens on its Routing tab', tabText !== '', tabText);
  check('the tab lists the VLAN 11 network as connected, by its VLAN', /10\.10\.11\.0\/24\s+connected, VLAN 11\s/.test(tabText), tabText);
  check('the tab lists the default route by hand', /default\s+via 10\.255\.255\.0\s+by hand/.test(tabText), tabText);
  check('the tab says what is not read yet', tabText.includes('OSPF or BGP'), tabText);
  await page.screenshot({ path: SHOTS + 'routing-panel.png' });
  await page.getByTestId('routing-tab-add').click();
  await page.waitForSelector('form[aria-label="Add a route"]');
  check('Add route opens with the device filled in', (await page.locator('form[aria-label="Add a route"] select').count()) === 0);
  await page.screenshot({ path: SHOTS + 'routing-panel-add.png' });

  // A trace on the Diagram look (r101): numbered hops, the rest faded, a stop as a caution box.
  await page.keyboard.press('Escape');
  const traceFrom = async (host, to) => {
    await page.locator('.drawing-diagram-box', { hasText: host }).click();
    await page.getByTestId('device-trace-from').click();
    await page.waitForSelector('[data-testid=trace-panel]', { timeout: 5_000 });
    await page.locator('[data-testid=trace-to]').fill(to);
    await page.waitForTimeout(1200);
  };
  await traceFrom('srv-01', '203.0.113.1');
  const hops = await page.locator('[data-testid=trace-hop]').allInnerTexts();
  const dots = await page.getByTestId('diagram-trace-dot').allInnerTexts();
  check('a trace from srv-01 numbers its hops on the drawing', dots.length >= 4 && dots.some((d) => d.split('·').includes('1')) && dots.includes('8'), dots.join(' | ') + ' // ' + hops.length + ' hops');
  const faded = await page.locator('.react-flow__node.trace-faded').allInnerTexts();
  check('the box the walk never touches is faded', faded.some((t) => t.includes('nas-01')) && !faded.some((t) => t.includes('core-sw')), faded.join(' | '));
  // 203.0.113.1 is past edge-fw, outside the design: the walk stops there, and says so beside edge-fw.
  check('a walk that leaves the design stops at its last box', (await page.locator('.drawing-diagram-box--stop', { hasText: 'edge-fw' }).count()) === 1);
  await page.screenshot({ path: SHOTS + 'routing-trace.png' });
  await page.locator('[data-testid=trace-panel]').getByRole('button', { name: /close/i }).first().click().catch(() => page.keyboard.press('Escape'));
  await page.waitForTimeout(300);
  await traceFrom('nas-01', '203.0.113.1');
  const stop = page.getByTestId('diagram-trace-stop');
  const stopText = (await stop.count()) > 0 ? await stop.innerText() : '';
  check('a walk that stopped short draws a caution box beside the last device', /stopped here/i.test(stopText), stopText);
  check('the stopped box takes the caution edge', (await page.locator('.drawing-diagram-box--stop', { hasText: 'nas-01' }).count()) === 1);
  await page.screenshot({ path: SHOTS + 'routing-trace-stop.png' });

  // The lens off: the tab is gone.
  await page.getByRole('button', { name: 'Cables', exact: true }).click();
  await page.waitForTimeout(300);
  check('with the lens off the Routing tab is not offered', (await page.getByTestId('routing-tab').count()) === 0);
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  console.log('    wrote ' + SHOTS + 'routing-lens-*.png');
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
