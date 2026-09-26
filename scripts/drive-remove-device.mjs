// Drives "Remove a device from the drawing" end to end: Delete on a selected, cabled device
// takes it and its cable in one undoable batch, the panel's "Remove device" button reaches
// the same command, and a read-only session cannot do either.
// Scene `trail` (`drive-lib/seed.ts`'s `seedConnectedDevices`): two cabled rack-mounted devices.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-remove-device.mjs.
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
const PORT = 5331;
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
  // Step 3: drive it.
  // -------------------------------------------------------------------------
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  async function openTrail(capability) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=trail${capability ? `&capability=${capability}` : ''}`);
    // ADR-0052 §5: a reader's rail is genuinely absent (`Shell.tsx`'s
    // `rail != null && <Strip .../>` — `RacksPlace.tsx` hands `rail: null`
    // for `canDraw` false), so there is no "Open the rail" handle to click.
    if (capability !== 'read') {
      await page.click('button[aria-label="Open the rail"]');
    }
    await page.waitForSelector('.react-flow__node-chassis', { timeout: 15_000 });
    return { context, page, pageErrors };
  }

  // ---------------------------------------------------------------------
  // Part 1: Delete on a selected, cabled device.
  // ---------------------------------------------------------------------
  {
    const { context, page, pageErrors } = await openTrail();
    check('two chassis placed (core-01, acc-01)', (await page.locator('.react-flow__node-chassis').count()) === 2);

    // core-01 is the cabled device this scene connects first
    // (`seedConnectedDevices`).
    const chassisNodes = page.locator('.react-flow__node-chassis');
    const coreNode = chassisNodes.filter({ hasText: 'core-01' });
    await coreNode.click();
    await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
    check('one cable drawn before removal', (await page.locator('[data-cable-id]').count()) === 1);
    await page.screenshot({ path: SHOTS + 'RD-01-selected.png' });
    console.log('    wrote ' + SHOTS + 'RD-01-selected.png');

    await page.keyboard.press('Delete');
    await page.waitForTimeout(400);
    check('one chassis left after Delete', (await page.locator('.react-flow__node-chassis').count()) === 1);
    check('the remaining chassis is acc-01', (await page.locator('.react-flow__node-chassis').innerText()).includes('acc-01'));
    // The cable (both ends) is gone with it.
    check('no cable drawn after removal', (await page.locator('[data-cable-id]').count()) === 0);
    await page.screenshot({ path: SHOTS + 'RD-02-deleted.png' });
    console.log('    wrote ' + SHOTS + 'RD-02-deleted.png');

    // Ctrl+Z brings back every node, edge and field.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(400);
    check('both chassis are back after undo', (await page.locator('.react-flow__node-chassis').count()) === 2);
    check('the cable is back too', (await page.locator('[data-cable-id]').count()) === 1);
    await page.screenshot({ path: SHOTS + 'RD-03-undone.png' });
    console.log('    wrote ' + SHOTS + 'RD-03-undone.png');

    check('no uncaught page errors (Delete/undo)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------------
  // Part 2: the panel's "Remove device" button.
  // ---------------------------------------------------------------------
  {
    const { context, page, pageErrors } = await openTrail();
    const coreNode = page.locator('.react-flow__node-chassis').filter({ hasText: 'core-01' });
    await coreNode.click();
    await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
    const removeButton = page.locator('.drawing-editor__panel button', { hasText: 'Remove device' });
    check('the panel offers "Remove device"', (await removeButton.count()) === 1);
    await removeButton.scrollIntoViewIfNeeded();
    // The panel with the button, in view.
    await page.locator('.drawing-editor__panel').screenshot({ path: SHOTS + 'RD-04-panel-button.png' });
    console.log('    wrote ' + SHOTS + 'RD-04-panel-button.png');

    await removeButton.click();
    await page.waitForTimeout(400);
    check('one chassis left after the panel button', (await page.locator('.react-flow__node-chassis').count()) === 1);

    check('no uncaught page errors (panel button)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------------
  // Part 3: a read-only session cannot remove.
  // ---------------------------------------------------------------------
  {
    const { context, page, pageErrors } = await openTrail('read');
    const coreNode = page.locator('.react-flow__node-chassis').filter({ hasText: 'core-01' });
    await coreNode.click();
    await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
    const removeButton = page.locator('.drawing-editor__panel button', { hasText: 'Remove device' });
    check('a reader\'s panel offers no "Remove device"', (await removeButton.count()) === 0);

    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    check('Delete removes nothing for a reader', (await page.locator('.react-flow__node-chassis').count()) === 2);
    await page.screenshot({ path: SHOTS + 'RD-05-read-only.png' });
    console.log('    wrote ' + SHOTS + 'RD-05-read-only.png');

    check('no uncaught page errors (read-only)', pageErrors.length === 0, pageErrors.join(' | '));
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
