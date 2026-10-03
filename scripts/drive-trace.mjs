// Drives ADR-0061 item 9 (path trace): right-click a device, trace to an address with and without a flow, the hops,
// the firewall's policies in order, the numbered circles and the fade; screenshots land in FATHOM_SHOTS at three
// window sizes. Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-checks.mjs.
// Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const SIZES = [[1280, 720], [1920, 1080], [1024, 700]];
  const VERDICT = /\b(permitted|denied|allowed|blocked|reachable|unreachable)\b/i;

  for (const [w, h] of SIZES) {
    const tag = `trace-${w}x${h}`;
    const context = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=trace`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(1500);
    await shot(page, `${tag}-01-canvas`);

    // Right-click the firewall: the item is there.
    const fw = page.locator('.react-flow__node-chassis', { hasText: 'fw-01' });
    await fw.click({ button: 'right', position: { x: 20, y: 10 } });
    const item = page.locator('.drawing-context-menu__item', { hasText: 'Trace a path from here' });
    check(`[${w}x${h}] the device menu offers Trace a path from here`, (await item.count()) === 1);
    await item.click();
    await page.waitForSelector('[data-testid=trace-panel]', { timeout: 5_000 });
    check(`[${w}x${h}] the panel opens with the box to type in`, await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'trace-to'));

    // An address the design reaches by a static route, no flow given.
    await page.locator('[data-testid=trace-to]').fill('198.51.100.77');
    await page.waitForTimeout(800);
    const reading = await page.locator('[data-testid=trace-reading]').innerText();
    check(`[${w}x${h}] "Reading as" names what was typed`, /address/i.test(reading), reading);
    let hops = await page.locator('[data-testid=trace-hop]').allInnerTexts();
    check(`[${w}x${h}] the hops are listed`, hops.length >= 2, hops.join(' | ').replace(/\s+/g, ' '));
    check(`[${w}x${h}] the route is named`, hops.some((t) => /static route 198\.51\.100\.0\/24/.test(t)));
    await shot(page, `${tag}-02-address`);

    // With a flow: every policy listed, one could affect, the SMB one is named but not judged.
    await page.locator('[data-testid=trace-flow]').fill('TCP 445');
    await page.waitForTimeout(800);
    const policies = await page.locator('[data-testid=trace-policy]').allInnerTexts();
    const text = await page.locator('[data-testid=trace-panel]').innerText();
    check(`[${w}x${h}] a firewall hop lists its policies in order`, policies.length >= 2 && /block-smb/.test(policies[0]) && /allow-web/.test(policies[1]), policies.join(' | ').replace(/\s+/g, ' '));
    check(`[${w}x${h}] a row that could affect the flow says so`, (await page.locator('.trace-policy--affect').count()) >= 1 && /could affect/.test(text));
    check(`[${w}x${h}] the panel never uses a verdict word`, !VERDICT.test(text), (text.match(VERDICT) ?? [])[0]);
    const heavy = await page.locator('.trace-policy--affect').first().evaluate((el) => getComputedStyle(el).borderLeftWidth);
    const light = await page.locator('.trace-policy:not(.trace-policy--affect)').first().evaluate((el) => getComputedStyle(el).borderLeftWidth).catch(() => '0px');
    check(`[${w}x${h}] a could-affect row has the heavier rule`, parseFloat(heavy) > parseFloat(light), `${heavy} vs ${light}`);
    await shot(page, `${tag}-03-flow`);

    // The canvas: numbered circles, the rest dimmed.
    const dots = await page.locator('[data-testid=trace-dot]').count();
    check(`[${w}x${h}] numbered circles are drawn on the canvas`, dots >= 1, String(dots));
    check(`[${w}x${h}] the others are dimmed`, (await page.locator('.react-flow__node.trace-faded').count()) >= 1 || (await page.locator('.react-flow__node').count()) === (await page.locator('.react-flow__node.trace-path').count()));

    // Why? on a hop.
    await page.locator('[data-testid=trace-hop]').nth(1).getByRole('button', { name: /^Why: / }).first().click();
    await page.waitForSelector('[data-testid=trace-why]', { timeout: 3_000 });
    const why = await page.locator('[data-testid=trace-why]').first().innerText();
    check(`[${w}x${h}] Why? opens a card with the reason`, why.length > 20 && !VERDICT.test(why), why.replace(/\s+/g, ' ').slice(0, 200));
    await shot(page, `${tag}-04-why`);

    // Only what could affect this.
    await page.locator('[data-testid=trace-only]').check();
    await page.waitForTimeout(300);
    const only = await page.locator('[data-testid=trace-panel]').innerText();
    check(`[${w}x${h}] the filter keeps the rows that could affect the flow`, /could affect/.test(only));
    await shot(page, `${tag}-05-only`);

    // A destination the design does not hold stops with could-not-establish.
    await page.locator('[data-testid=trace-to]').fill('192.0.2.200');
    await page.waitForTimeout(800);
    const stop = await page.locator('[data-testid=trace-panel]').innerText();
    check(`[${w}x${h}] a missing route says could not be established`, /could not be established|could not establish/i.test(stop), stop.replace(/\s+/g, ' ').slice(0, 300));
    check(`[${w}x${h}] ... and still no verdict word`, !VERDICT.test(stop));
    await shot(page, `${tag}-06-stop`);

    // Close clears the canvas.
    await page.locator('[data-testid=trace-panel]').getByRole('button', { name: 'Close the trace' }).click();
    await page.waitForTimeout(400);
    check(`[${w}x${h}] Close removes the panel, the circles and the fade`, (await page.locator('[data-testid=trace-panel]').count()) === 0 && (await page.locator('.trace-faded').count()) === 0 && (await page.locator('[data-testid=trace-dot]').count()) === 0);
    check(`[${w}x${h}] no uncaught page errors`, pageErrors.length === 0, pageErrors.join(' | '));
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
