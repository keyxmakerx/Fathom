// Drives an unplaced device's editor panel in a real browser: Inventory's "Unplaced" group opens it, a
// field edits, "Remove device" removes it and undo restores it; every save loads through the real engine.
// Scene `unplaced`: one hand-made sketch device, never placed.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-unplaced-device.mjs.
// Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT, FATHOM_SHOTS.
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
const PORT = 5332;
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
    <title>Fathom drive preview (not shipped)</title>
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

/** Clicks a field's idle/selected value twice (`Editor.tsx`'s `EditableValue`
 * own idle -> selected -> editing state machine), types `value` into the
 * `<input>` that appears and commits it with Enter. */
async function editTextField(panel, labelText, value) {
  const label = panel.locator('.drawing-editor__field-label', { hasText: labelText }).first();
  const field = label.locator('xpath=..');
  const idleValue = field.locator('span').first();
  await idleValue.click();
  await idleValue.click();
  const input = field.locator('input');
  await input.fill(value);
  await input.press('Enter');
}

/** Every save this scene's mocked backend has answered so far, checked
 * against the real engine inside the page itself. */
async function saveLoadFailures(page) {
  return page.evaluate(() => window.__saveLoadFailures__);
}
async function saveCount(page) {
  return page.evaluate(() => window.__saveCount__);
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
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Direct entry lands on Racks when there is exactly one organisation and
  // one design (ADR-0046 §3) — this harness's mocked backend always offers
  // exactly that, so this crosses the bar's "Inventory" tab, the same as
  // `drive-networks.mjs`'s own `openNetworksList`.
  await page.goto(`${BASE}/drive.html?scene=unplaced`);
  await page.waitForSelector('.shell-bar__tab', { timeout: 15_000 });
  await page.locator('.shell-bar__tab', { hasText: 'Inventory' }).click();
  await page.waitForSelector('.inventory-place__kind', { timeout: 15_000 });

  // Devices is the default kind — the seeded sketch device sits in its own
  // "Unplaced" group row (`rows.ts`'s `unplacedDeviceRows`/`groupDeviceRows`).
  await page.waitForSelector('.inventory-place__group-row', { timeout: 15_000 });
  const groupLabels = await page.locator('.inventory-place__group-row').allInnerTexts();
  check('the grid shows an "Unplaced" group', groupLabels.some((t) => /unplaced/i.test(t)), groupLabels.join(' | '));

  const row = page.locator('.inventory-place__row', { hasText: 'sketch-01' });
  check('the unplaced device has its own row', (await row.count()) === 1);
  await row.click();

  // The bug this drive proves fixed: `EditorFor`'s device branch used to
  // look only inside `view.racks`, so this panel never appeared at all.
  await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
  const panel = page.locator('.drawing-editor__panel');
  const panelText = await panel.innerText();
  check('the panel opens for the unplaced device', panelText.includes('sketch-01'));
  check('the panel shows "Placed on", not silence', /placed on/i.test(panelText));
  check('the panel offers "Remove device", the same as a placed one', panelText.includes('Remove device'));
  // Placement-only fields (a rack's U-range, "Duplicate") are left out for a
  // device this document has not placed anywhere.
  check('no rack U-range is shown', !/U\d/.test(panelText));
  check('no "Duplicate" control is shown', !panelText.includes('Duplicate'));
  await panel.screenshot({ path: SHOTS + 'UD-01-panel.png' });
  console.log('    wrote ' + SHOTS + 'UD-01-panel.png');

  // Edit a field — the management address, `IpAddr` (`schema/schema.yaml`).
  await editTextField(panel, 'Mgmt address', '10.10.0.5');
  await page.waitForTimeout(300);
  const panelTextAfterEdit = await panel.innerText();
  check('the edited field saved and re-rendered', panelTextAfterEdit.includes('10.10.0.5'));
  await panel.screenshot({ path: SHOTS + 'UD-02-edited.png' });
  console.log('    wrote ' + SHOTS + 'UD-02-edited.png');

  // Remove it — `document/commands.ts`'s `removeChassis`, the same
  // `EditorChange` a placed device's panel raises.
  await panel.locator('button', { hasText: 'Remove device' }).click();
  await page.waitForTimeout(400);
  check('the row is gone after removal', (await page.locator('.inventory-place__row', { hasText: 'sketch-01' }).count()) === 0);
  await page.screenshot({ path: SHOTS + 'UD-03-removed.png' });
  console.log('    wrote ' + SHOTS + 'UD-03-removed.png');

  // Undo — the bar's own chip (Inventory has no canvas to hold a Ctrl+Z
  // listener; `DesignPlace.tsx`'s own doc: "the bar's Undo/Redo, real
  // everywhere `DesignPlace` renders").
  await page.locator('.shell-chip', { hasText: 'Undo' }).click();
  await page.waitForTimeout(400);
  check('the row is back after undo', (await page.locator('.inventory-place__row', { hasText: 'sketch-01' }).count()) === 1);
  await page.screenshot({ path: SHOTS + 'UD-04-undone.png' });
  console.log('    wrote ' + SHOTS + 'UD-04-undone.png');

  // Every save this scene made loaded through the real engine, not just the
  // mocked backend.
  const failures = await saveLoadFailures(page);
  check('every save this scene made loads through the engine', failures.length === 0, failures.join(' | '));
  check('this scene actually saved at least once', (await saveCount(page)) > 0);

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  await context.close();
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
