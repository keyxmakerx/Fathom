// Proves ADR-0051's surfaces end to end: a closet's desk, floor and wall
// each carrying a sketch device, cabled to a rack-mounted catalogue switch.
// Run: bash scripts/build-wasm.sh (if stale), then node scripts/drive-freestanding.mjs.
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
// 5173 default, so it never collides with `drive-hand-entry.mjs`'s 5330.
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
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await applyDriveCpuThrottle(page);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/drive.html?scene=freestanding`);
  // The harness installs the session directly (ADR-0046 §3) — no Home click,
  // no sign-in door; the drawing renders regardless of the rail's open/closed state.
  await page.waitForSelector('.react-flow__node-rack', { timeout: 15_000 });
  await page.waitForSelector('.react-flow__node-surface', { timeout: 15_000 });

  // The camera's transform, and where `el`'s centre sits as a fraction of the pane.
  const cameraOf = (p) => p.evaluate(() => document.querySelector('.react-flow__viewport').style.transform);
  const zoomOf = async (p) => Number(/scale\(([^)]+)\)/.exec(await cameraOf(p))?.[1]);
  const paneFraction = (el, closest) => el.evaluate((node, closest) => {
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    const b = (closest ? node.closest(closest) : node).getBoundingClientRect();
    return { x: +((b.x + b.width / 2 - pane.x) / pane.width).toFixed(3), y: +((b.y + b.height / 2 - pane.y) / pane.height).toFixed(3) };
  }, closest);
  // Whether `el`'s box (or its closest `closest` ancestor's) covers the pane's centre.
  const coversCentre = (el, closest) => el.evaluate((node, closest) => {
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    const b = (closest ? node.closest(closest) : node).getBoundingClientRect();
    const cx = pane.x + pane.width / 2;
    const cy = pane.y + pane.height / 2;
    return b.left <= cx && cx <= b.right && b.top <= cy && cy <= b.bottom;
  }, closest);

  const surfaceCount = await page.locator('.react-flow__node-surface').count();
  check('all three surfaces render (desk, floor, wall)', surfaceCount === 3, `${surfaceCount} surface nodes`);

  const labels = await page.locator('.drawing-surface__fixture-label').allInnerTexts();
  check('fw-01 is drawn on a surface', labels.includes('fw-01'), labels.join(', '));
  check('ups-01 is drawn on a surface', labels.includes('ups-01'), labels.join(', '));
  check('ont-01 is drawn on a surface', labels.includes('ont-01'), labels.join(', '));

  const formLabels = await page.locator('.drawing-surface__form').allInnerTexts();
  check('a DESK surface is drawn', formLabels.includes('DESK'), formLabels.join(', '));
  check('a FLOOR band is drawn', formLabels.includes('FLOOR'), formLabels.join(', '));
  check('a WALL surface is drawn', formLabels.includes('WALL'), formLabels.join(', '));

  // -------------------------------------------------------------------------
  // The C14/C13 power ports and the SC port must be in the DOM, not silently dropped.
  // -------------------------------------------------------------------------
  const fwBoxLocator = page.locator('.react-flow__node-surface .drawing-surface__fixture', { hasText: 'fw-01' });
  const fwPortCount0 = await fwBoxLocator.locator('.drawing-surface__port').count();
  check('fw-01 shows all 5 ports (4 RJ45 + 1 C14), the C14 counted', fwPortCount0 === 5, `${fwPortCount0} port glyphs`);
  const fwC14Count = await fwBoxLocator.locator('.port--c14').count();
  check('fw-01\'s C14 draws with the C14 glyph', fwC14Count === 1, `${fwC14Count} c14 glyphs`);

  const upsBoxLocator = page.locator('.react-flow__node-surface .drawing-surface__fixture--upright', { hasText: 'ups-01' });
  const upsPortCount = await upsBoxLocator.locator('.drawing-surface__port').count();
  check('ups-01 shows all 3 ports (2 C13 + 1 C14), the C14 counted', upsPortCount === 3, `${upsPortCount} port glyphs`);

  const ontBoxLocator = page.locator('.react-flow__node-surface .drawing-surface__fixture', { hasText: 'ont-01' });
  const ontPortCount = await ontBoxLocator.locator('.drawing-surface__port').count();
  check('ont-01 shows both ports (RJ45 + SC), the SC counted', ontPortCount === 2, `${ontPortCount} port glyphs`);
  const ontScGlyph = await ontBoxLocator.locator('.port--lc').count();
  check('ont-01\'s SC draws with the LC glyph (docs/UI-SPEC.md "Owed to the boards")', ontScGlyph === 1, `${ontScGlyph} lc glyphs`);

  // -------------------------------------------------------------------------
  // The "typed" mark must stay inside its own fixture box, not run past the
  // right edge.
  // -------------------------------------------------------------------------
  const fwOuterBox = await fwBoxLocator.boundingBox();
  const typedBox = await fwBoxLocator.locator('.drawing-surface__typed').boundingBox();
  check('the "typed" mark has a bounding box', typedBox != null);
  if (fwOuterBox && typedBox) {
    const inside =
      typedBox.x >= fwOuterBox.x - 0.5
      && typedBox.y >= fwOuterBox.y - 0.5
      && typedBox.x + typedBox.width <= fwOuterBox.x + fwOuterBox.width + 0.5
      && typedBox.y + typedBox.height <= fwOuterBox.y + fwOuterBox.height + 0.5;
    check(
      'the "typed" mark\'s box sits inside fw-01\'s own device box',
      inside,
      `typed ${JSON.stringify(typedBox)} vs box ${JSON.stringify(fwOuterBox)}`,
    );
  }

  // -------------------------------------------------------------------------
  // F-01 — the whole closet: rack plus surfaces, via the bar's own "Fit to
  // view", which frames every surface alongside every rack.
  // -------------------------------------------------------------------------
  const fitButton = page.locator('button[aria-label="Fit to view"]');
  check('"Fit to view" exists on the bar', (await fitButton.count()) > 0);
  await page.waitForTimeout(500); // let every surface's own layout settle before the first fit
  const cameraBeforeFit = await cameraOf(page);
  await fitButton.click();
  await page.waitForTimeout(400);
  await fitButton.click(); // a second press re-fits against final, settled measurements
  await page.waitForTimeout(400);
  const viewportSize = page.viewportSize();
  const surfaceBoxesAfterFit = await page.locator('.react-flow__node-surface').all();
  let allSurfacesFramed = surfaceBoxesAfterFit.length > 0;
  for (const surface of surfaceBoxesAfterFit) {
    const box = await surface.boundingBox();
    if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewportSize.width || box.y + box.height > viewportSize.height) {
      allSurfacesFramed = false;
    }
  }
  const cameraAfterFit = await cameraOf(page);
  check('"Fit to view" moved the camera', cameraAfterFit !== cameraBeforeFit, `${cameraBeforeFit} -> ${cameraAfterFit}`);
  check('after "Fit to view" every surface sits inside the viewport', allSurfacesFramed);
  const rackBoxAfterFit = await page.locator('.react-flow__node-rack').boundingBox();
  const rackFramed =
    rackBoxAfterFit != null
    && rackBoxAfterFit.x >= 0
    && rackBoxAfterFit.y >= 0
    && rackBoxAfterFit.x + rackBoxAfterFit.width <= viewportSize.width
    && rackBoxAfterFit.y + rackBoxAfterFit.height <= viewportSize.height;
  check('after "Fit to view" the rack also sits inside the viewport', rackFramed);
  await page.screenshot({ path: SHOTS + 'F-01-closet.png' });
  console.log('    wrote ' + SHOTS + 'F-01-closet.png');

  // -------------------------------------------------------------------------
  // F-02 — zoomed to the desk surface, fw-01's ports visible. No camera
  // "faceplate stop" exists for a surface fixture, so this zooms in manually.
  // -------------------------------------------------------------------------
  for (let i = 0; i < 30; i += 1) {
    await page.locator('button[aria-label="Zoom out"]').click();
    await page.waitForTimeout(30);
  }
  for (let i = 0; i < 9; i += 1) {
    await page.locator('button[aria-label="Zoom in"]').click();
    await page.waitForTimeout(30);
  }
  const fwBox = page.locator('.react-flow__node-surface .drawing-surface__fixture', { hasText: 'fw-01' });
  const fwBoundingBox = await fwBox.boundingBox();
  check('fw-01\'s own fixture box has a bounding box', fwBoundingBox != null);
  if (fwBoundingBox) {
    const midX = fwBoundingBox.x + fwBoundingBox.width / 2;
    const midY = fwBoundingBox.y + fwBoundingBox.height / 2;
    await page.mouse.move(midX, midY);
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.down('Control'); await page.mouse.wheel(0, -240); await page.keyboard.up('Control'); // wheel pans, Ctrl+wheel zooms
      await page.waitForTimeout(50);
    }
  }
  await page.waitForTimeout(300);
  const fwPorts = fwBox.locator('.drawing-surface__port');
  const fwPortCount = await fwPorts.count();
  check('fw-01 shows all 5 port glyphs on its plate, C14 included', fwPortCount === 5, `${fwPortCount} port glyphs`);
  await page.screenshot({ path: SHOTS + 'F-02-desk.png' });
  console.log('    wrote ' + SHOTS + 'F-02-desk.png');

  // -------------------------------------------------------------------------
  // F-03 — a cable selected, both ends visible. Zooms to 100% first, then
  // clicks fw-01's first cabled port and "Select cable" off the port panel.
  // -------------------------------------------------------------------------
  for (let i = 0; i < 20; i += 1) {
    await page.locator('button[aria-label="Zoom out"]').click();
    await page.waitForTimeout(30);
  }
  for (let i = 0; i < 9; i += 1) {
    await page.locator('button[aria-label="Zoom in"]').click();
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(300);
  const cabledPort = page.locator('.react-flow__node-surface .drawing-surface__port--cabled').first();
  const cabledPortCount = await page.locator('.react-flow__node-surface .drawing-surface__port--cabled').count();
  check('at least one cabled port shows on a surface fixture', cabledPortCount > 0, `${cabledPortCount} cabled port glyphs`);
  const zoomBeforePortFocus = await zoomOf(page);
  await cabledPort.click();
  await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
  // Selecting a port glides the camera to its owning box at the faceplate stop.
  await page.waitForTimeout(800);
  const portOwner = await paneFraction(cabledPort, '.react-flow__node');
  const ownerCovers = await coversCentre(cabledPort, '.react-flow__node');
  const zoomAfterPortFocus = await zoomOf(page);
  check('selecting a port brings its owning box to the pane centre at the faceplate stop', zoomBeforePortFocus !== 2 && ownerCovers && zoomAfterPortFocus === 2, `from zoom ${zoomBeforePortFocus}: box centre ${JSON.stringify(portOwner)}, zoom ${zoomAfterPortFocus}`);
  const selectCableButton = page.locator('.drawing-editor__panel button', { hasText: 'Select cable' });
  const hasSelectCable = (await selectCableButton.count()) > 0;
  check('the port panel offers "Select cable"', hasSelectCable);
  if (hasSelectCable) {
    await selectCableButton.click();
    await page.waitForTimeout(300);
  }
  const cablePanelText = await page.locator('.drawing-editor__panel').innerText();
  check('the cable panel opened (title, not a port panel)', cablePanelText.length > 0, cablePanelText.slice(0, 200));
  await page.screenshot({ path: SHOTS + 'F-03-cabled.png' });
  console.log('    wrote ' + SHOTS + 'F-03-cabled.png');

  // F-04 — a box on a shelf opens at the faceplate stop by the same camera.
  const shelfPage = await context.newPage();
  await applyDriveCpuThrottle(shelfPage);
  shelfPage.on('pageerror', (e) => pageErrors.push(e.message));
  await shelfPage.goto(`${BASE}/drive.html?scene=shelf`);
  const occupant = shelfPage.locator('.drawing-shelf__compact-occupant', { hasText: 'box-01' });
  await occupant.waitFor({ timeout: 15_000 });
  await shelfPage.waitForTimeout(800);
  const zoomBeforeOpen = await zoomOf(shelfPage);
  await occupant.click();
  await shelfPage.waitForTimeout(800);
  const shelfNode = await paneFraction(shelfPage.locator('.react-flow__node-shelf'));
  const shelfCovers = await coversCentre(shelfPage.locator('.react-flow__node-shelf'));
  const zoomAfterOpen = await zoomOf(shelfPage);
  check('opening a box on a shelf glides to the faceplate stop, the shelf at the pane centre', zoomBeforeOpen !== 2 && shelfCovers && zoomAfterOpen === 2, `from zoom ${zoomBeforeOpen}: box centre ${JSON.stringify(shelfNode)}, zoom ${zoomAfterOpen}`);
  await shelfPage.screenshot({ path: SHOTS + 'F-04-shelf.png' });
  console.log('    wrote ' + SHOTS + 'F-04-shelf.png');
  await shelfPage.close();

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
