// Proves ADR-0051's hand-drawing speed-ups end to end: a numbered port
// range, "Duplicate", a real cable, and undo — through document/commands.ts
// and handleEdit/applyDocChange, the same path every edit takes.
//
// Uses the shared throwaway harness (`scripts/drive-lib/harness.tsx` +
// `seed.ts` + `catalogue.json`, copied into `client/` and removed below —
// see `drive-config-drawer.mjs` for why a scripted sign-in isn't available).
//
// Usage:
//   bash scripts/build-wasm.sh   # once, if the artefact is stale
//   node scripts/drive-hand-entry.mjs
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
// Playwright is not a repo dependency (ADR-0032 gate zero) — reached by
// absolute path, like every other `scripts/drive-*`.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDriveCpuThrottle } from './drive-lib/cpuThrottle.mjs';

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
const PORT = 5330;
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

// Step 0: the wasm artefact. `Engine.init()` boots it on a chassis
// selection (`RacksPlace.tsx`) even though this drive never pastes.
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

// Step 2: the client dev server, this run's own port — never the shared
// 5173 default, so it never collides with anyone else's `npm run dev`.
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
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await applyDriveCpuThrottle(page);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/drive.html`);
  // The harness installs the session directly (ADR-0046 §3: "exactly one
  // place to go") — no Home click, no sign-in door.
  await page.click('button[aria-label="Open the rail"]');
  await page.waitForSelector('.drawing-palette__item', { timeout: 15_000 });
  await page.waitForSelector('[data-id="rack:pending-rack"]', { timeout: 15_000 });

  // Drop a sketch device (`createSketchDevice`) near the rack's bottom (U1)
  // — `duplicateDevice`'s "next free position" scans up from U1, so the
  // copy lands right next to it, both in view for cabling below.
  const dropped = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.drawing-palette__item'));
    const src = items.find((el) => el.textContent?.includes('sketch-device'));
    const tgt = document.querySelector('[data-id="rack:pending-rack"]');
    if (!src || !tgt) return false;
    const rect = tgt.getBoundingClientRect();
    const dt = new DataTransfer();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height - 30 };
    src.dispatchEvent(new DragEvent('dragstart', opts));
    tgt.dispatchEvent(new DragEvent('dragenter', opts));
    tgt.dispatchEvent(new DragEvent('dragover', opts));
    tgt.dispatchEvent(new DragEvent('drop', opts));
    src.dispatchEvent(new DragEvent('dragend', opts));
    return true;
  });
  check('sketch device dragged onto the rack', dropped);
  await page.waitForTimeout(300);
  check('one chassis placed', (await page.locator('.react-flow__node-chassis').count()) === 1);
  await page.screenshot({ path: SHOTS + 'H-01-dropped.png' });
  console.log('    wrote ' + SHOTS + 'H-01-dropped.png');

  // Select it.
  await page.click('.react-flow__node-chassis');
  await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });

  // Add ports `eth` 0 to 7 in one go (`addSketchPortRange`, the editor's
  // "a range" mode).
  await page.locator('.drawing-editor__panel button', { hasText: '+ add a port' }).click();
  await page.locator('.drawing-editor__panel label', { hasText: 'a range' }).click();
  await page.locator('.drawing-editor__panel').getByPlaceholder('label prefix, e.g. ge-0/0/').fill('eth');
  await page.locator('.drawing-editor__panel').getByPlaceholder('first').fill('0');
  await page.locator('.drawing-editor__panel').getByPlaceholder('last').fill('7');
  await page.locator('.drawing-editor__panel').getByRole('button', { name: 'add', exact: true }).click();
  await page.waitForTimeout(300);
  const panelTextAfterRange = await page.locator('.drawing-editor__panel').innerText();
  check('eth0 typed onto the faceplate', panelTextAfterRange.includes('eth0'));
  check('eth7 typed onto the faceplate', panelTextAfterRange.includes('eth7'));
  // One "remove" button per port — an exact match (a regex anchored both
  // ends) so Duplicate/notes buttons, and the device panel's "Remove
  // device" (a `hasText` STRING match is a case-insensitive substring one,
  // which "Remove device" also satisfies), never count.
  const removeButtonCount = await page.locator('.drawing-editor__panel button', { hasText: /^remove$/ }).count();
  check('8 ports typed in one go', removeButtonCount === 8, `${removeButtonCount} "remove" buttons`);
  // Natural label order (`document/view.ts`'s `naturalLabelCompare`), not
  // mint order.
  const orderedLabels = panelTextAfterRange.match(/eth\d+/g) ?? [];
  const wantOrder = ['eth0', 'eth1', 'eth2', 'eth3', 'eth4', 'eth5', 'eth6', 'eth7'];
  check(
    'the "Ports · typed by hand" list reads eth0…eth7 in order',
    JSON.stringify(orderedLabels) === JSON.stringify(wantOrder),
    orderedLabels.join(', '),
  );
  await page.screenshot({ path: SHOTS + 'H-02-ports.png' });
  console.log('    wrote ' + SHOTS + 'H-02-ports.png');

  // Duplicate the device (`duplicateDevice`).
  await page.locator('.drawing-editor__panel button', { hasText: 'Duplicate' }).click();
  await page.waitForTimeout(400);
  check('a second chassis appeared', (await page.locator('.react-flow__node-chassis').count()) === 2);
  await page.screenshot({ path: SHOTS + 'H-03-duplicate.png' });
  console.log('    wrote ' + SHOTS + 'H-03-duplicate.png');

  // Cable a port on one to the other via drag-to-connect. The bar's own
  // "Zoom in" centres on the pane, not the devices, so this zooms with the
  // wheel (`zoomOnScroll`) at their midpoint instead, so both stay in view.
  const beforeZoomNodes = page.locator('.react-flow__node-chassis');
  const box0 = await beforeZoomNodes.nth(0).boundingBox();
  const box1 = await beforeZoomNodes.nth(1).boundingBox();
  check('both chassis have a bounding box before zooming', box0 != null && box1 != null);
  if (box0 && box1) {
    const midX = (box0.x + box0.width / 2 + box1.x + box1.width / 2) / 2;
    const midY = (box0.y + box0.height / 2 + box1.y + box1.height / 2) / 2;
    await page.mouse.move(midX, midY);
    // Zooms to the faceplate stop itself, not a fixed tick count: a wheel
    // tick's own size varies under throttling, and a fixed count can
    // overshoot past the stop it is aiming for.
    for (let i = 0; i < 15; i += 1) {
      const stop = await page.locator('.drawing').getAttribute('data-camera-stop');
      const zoomVar = await page.locator('.drawing').evaluate((el) => el.style.getPropertyValue('--zoom-pct'));
      console.log('ZOOM_DEBUG', i, stop, zoomVar);
      if (stop === 'faceplate') break;
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(50);
    }
  }
  await page.waitForTimeout(300);
  const finalZoomVar = await page.locator('.drawing').evaluate((el) => el.style.getPropertyValue('--zoom-pct'));
  console.log('ZOOM_DEBUG final', finalZoomVar);
  const reachedFaceplate = (await page.locator('.drawing').getAttribute('data-camera-stop')) === 'faceplate';
  check('zoomed to the faceplate stop', reachedFaceplate);

  const chassisNodes = page.locator('.react-flow__node-chassis');
  const fromPort = chassisNodes.nth(0).locator('[data-port-id]').first();
  const toPort = chassisNodes.nth(1).locator('[data-port-id]').first();
  const fromBox = await fromPort.boundingBox();
  const toBox = await toPort.boundingBox();
  check('found a port on each chassis to cable', fromBox != null && toBox != null);

  if (fromBox && toBox) {
    const fx = fromBox.x + fromBox.width / 2;
    const fy = fromBox.y + fromBox.height / 2;
    const tx = toBox.x + toBox.width / 2;
    const ty = toBox.y + toBox.height / 2;
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move((fx + tx) / 2, (fy + ty) / 2, { steps: 8 });
    await page.mouse.move(tx, ty, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const pickerOpen = (await page.locator('.drawing-picker').count()) > 0;
    check('the sheath colour picker opened on drop', pickerOpen);
    if (pickerOpen) {
      // Enter accepts the preselected sheath.
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }
  }
  // The drop's mouseup also selects the target port — its own panel reads
  // what the document now holds.
  const panelTextAfterConnect = await page.locator('.drawing-editor__panel').innerText();
  check(
    'the target port\'s own panel now shows a live cable, not "Not cabled"',
    panelTextAfterConnect.includes('Select cable') && !panelTextAfterConnect.includes('Not cabled'),
    panelTextAfterConnect.slice(0, 200),
  );
  await page.screenshot({ path: SHOTS + 'H-04-cabled.png' });
  console.log('    wrote ' + SHOTS + 'H-04-cabled.png');

  // Remove the cable: "Select cable" then Delete, through `Drawing`'s
  // `onDisconnect` (`RacksPlace.tsx`) to `document/cables.ts`'s `disconnect`.
  await page.locator('.drawing-editor__panel button', { hasText: 'Select cable' }).click();
  await page.waitForTimeout(200);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  // The cable is gone, so re-select the port to read its panel fresh.
  await toPort.click();
  await page.waitForTimeout(200);
  const panelTextAfterDisconnect = await page.locator('.drawing-editor__panel').innerText();
  check(
    'removing the cable leaves the port reading "Not cabled" again',
    panelTextAfterDisconnect.includes('Not cabled'),
    panelTextAfterDisconnect.slice(0, 200),
  );
  check('both chassis are still there after disconnect', (await page.locator('.react-flow__node-chassis').count()) === 2);
  await page.screenshot({ path: SHOTS + 'H-05-disconnected.png' });
  console.log('    wrote ' + SHOTS + 'H-05-disconnected.png');

  // Undo once — the disconnect comes back off, so the cable returns.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  await toPort.click();
  await page.waitForTimeout(200);
  const panelTextAfterUndo = await page.locator('.drawing-editor__panel').innerText();
  check(
    'undo once brings the cable back — the port reads cabled again',
    panelTextAfterUndo.includes('Select cable') && !panelTextAfterUndo.includes('Not cabled'),
    panelTextAfterUndo.slice(0, 200),
  );
  check('both chassis are still there after undo', (await page.locator('.react-flow__node-chassis').count()) === 2);
  await page.screenshot({ path: SHOTS + 'H-06-undo.png' });
  console.log('    wrote ' + SHOTS + 'H-06-undo.png');

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

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
