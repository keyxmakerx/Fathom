// Swap a device's model and keep its ports, end to end against the real compiled client (sign-off
// r28-swap): select sw-02 (a 24-port switch with three copper cables and an SFP+ link), open
// "Swap model…", pick the 48-port model, read the preview, swap, and see every cable still drawn
// with no loose end, the panel naming the new model; then one undo puts the old model back.
//
// Uses the shared throwaway harness (`scripts/drive-lib/harness.tsx` + `seed.ts` + `catalogue.json`,
// copied into `client/` and removed below), scene `canvas`.
//
// Usage:
//   bash scripts/build-wasm.sh   # once, if the artefact is stale
//   node scripts/drive-swap-model.mjs
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT, FATHOM_SHOTS (where the
// screenshots go; default /mnt/project-files/reviews/swap-model/). Playwright is not a repo
// dependency (ADR-0032 gate zero) — reached by absolute path, like every other `scripts/drive-*`.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
// Not shared with any other `scripts/drive-*.mjs` — `grep -h "PORT = " scripts/drive-*.mjs` before picking a new one.
const PORT = 18531;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/swap-model').replace(/\/?$/, '/');
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

// Step 1: copy the shared throwaway harness into `client/`.
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
    <title>Fathom — Swap model drive preview (throwaway, not shipped)</title>
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

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/drive.html?scene=canvas`);
  await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-chassis').length === 3, null, { timeout: 15_000 });
  await page.waitForTimeout(1200);

  const loose = page.locator('[data-testid="loose-cable"]');
  const cables = page.locator('g.drawing-cable');
  const sw = page.locator('.react-flow__node-chassis', { hasText: 'sw-02' });
  const panel = page.locator('.drawing-editor__panel');
  const cablesBefore = await cables.count();
  check('the scene draws its cables and no loose end', cablesBefore > 0 && (await loose.count()) === 0, `cables ${cablesBefore}`);

  // Select sw-02 by its name, not a port.
  const callout = async () => {
    await sw.getByText('sw-02', { exact: true }).first().click();
    await page.waitForTimeout(600);
    return page.getByText(/\d+ of \d+ ports cabled/).first().innerText();
  };
  const cabledBefore = await callout();
  check('sw-02 starts with 4 of its 26 ports cabled', cabledBefore === '4 of 26 ports cabled', cabledBefore);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.waitForTimeout(600);
  check("sw-02's panel is open", (await panel.count()) > 0 && /sw-02/.test(await panel.first().innerText()));
  const swap = page.getByRole('button', { name: 'Swap model…' });
  check('the Details tab offers "Swap model…"', (await swap.count()) === 1);
  await swap.click();
  await page.waitForTimeout(300);
  const select = page.getByLabel('New model');
  const options = await select.locator('option').allTextContents();
  const target = options.find((o) => /USW-48-PoE/.test(o));
  check('the 48-port model is offered, and not the model it already is', target != null && !options.some((o) => /USW-24-PoE/.test(o)), options.join(' | '));
  await select.selectOption({ label: target });
  await page.waitForTimeout(500);
  const plan = (await page.locator('.drawing-editor__swap-plan').innerText()).trim();
  console.log('    preview:\n' + plan.split('\n').map((l) => '      ' + l).join('\n'));
  check('the preview says the cabled ports carry over with their cables', /carry over, 4 with their cables/.test(plan), plan.split('\n')[0]);
  // This catalogue numbers the SFP+ cages 1 and 2 beside copper 1 and 2: the uplink pairs by name and connector.
  check('the preview leaves no loose end and renames nothing', !/Not on the new model/.test(plan) && !/Renamed/.test(plan));
  await page.screenshot({ path: SHOTS + 'swap-model-01-preview.png' });
  console.log('    wrote ' + SHOTS + 'swap-model-01-preview.png');

  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.waitForTimeout(1200);
  const after = await panel.first().innerText();
  check('the panel names the new model', /USW-48-PoE/.test(after) && !/USW-24-PoE/.test(after), after.slice(0, 160).replace(/\n/g, ' / '));
  await page.screenshot({ path: SHOTS + 'swap-model-02-after.png' });
  console.log('    wrote ' + SHOTS + 'swap-model-02-after.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const cabledAfter = await callout();
  check('the same 4 ports are cabled, now of the 48-port model’s 52', cabledAfter === '4 of 52 ports cabled', cabledAfter);
  check('every cable is still drawn', (await cables.count()) === cablesBefore, `${cablesBefore} -> ${await cables.count()}`);
  check('and no cable was left with a loose end', (await loose.count()) === 0);
  await page.screenshot({ path: SHOTS + 'swap-model-03-callout.png' });
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(1200);
  const cabledUndone = await callout();
  check('one undo puts the 24-port model back, cables and all', cabledUndone === '4 of 26 ports cabled' && (await page.getByText(/USW-24-PoE/).count()) > 0, cabledUndone);
  check('with every cable still drawn', (await cables.count()) === cablesBefore);
  await page.screenshot({ path: SHOTS + 'swap-model-04-undone.png' });
  console.log('    wrote ' + SHOTS + 'swap-model-04-undone.png');

  // Every save the scene made, with the new field in it, loads through the real engine.
  const saves = await page.evaluate(() => ({ count: window.__saveCount__ ?? 0, failures: window.__saveLoadFailures__ ?? [] }));
  check('the edits were saved, and every saved payload loaded through the engine', saves.count > 0 && saves.failures.length === 0, JSON.stringify(saves));

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
  check('the throwaway harness files were removed', ![PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE].some((f) => existsSync(f)));
}

console.log(fails.length ? '\nFAILURES:\n  ' + fails.join('\n  ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
