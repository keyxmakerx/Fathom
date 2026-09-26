// GitHub issue #66: "the drawing re-creates every node on each render, so
// nodes blink hidden." Proves the fix end to end in a real browser, against
// the real compiled client (the shared throwaway harness —
// `scripts/drive-lib/harness.tsx` + `seed.ts` + `catalogue.json`, copied
// into `client/` and removed below, see `drive-config-drawer.mjs` for why a
// scripted sign-in isn't available) — sixteen rack-mounted devices, one
// cable between the first two.
//
// React Flow marks a node `visibility: hidden` in its own inline style
// until a `ResizeObserver` has measured it (`@xyflow/react`'s own
// `NodeWrapper`) — dropped, and re-applied, whenever the `Node` object a
// caller hands it changes reference. This installs a `MutationObserver` on
// every `.react-flow__node`'s own `style` attribute AFTER the first draw
// (so the node's own real, one-time initial measurement is never counted),
// then hovers a cable, selects several devices, drags one, and wheel-zooms
// — the four gestures GitHub issue #66's own brief names — and asserts that
// observer counted zero `visibility: hidden` transitions the whole time.
//
// Usage:
//   bash scripts/build-wasm.sh                 # once, if the artefact is stale
//   node scripts/drive-node-identity.mjs
//   FATHOM_DRIVE_CPU_THROTTLE=6 node scripts/drive-node-identity.mjs   # slow only this tab
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT,
// FATHOM_DRIVE_CPU_THROTTLE (`drive-lib/cpuThrottle.mjs`). Playwright is not
// a repo dependency (ADR-0032 gate zero) — reached by absolute path, like
// every other `scripts/drive-*`.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDriveCpuThrottle } from './drive-lib/cpuThrottle.mjs';

const pw = await import(process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js');
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CLIENT = ROOT + '/client';
const DRIVE_LIB = ROOT + '/scripts/drive-lib';
// Not shared with any other `scripts/drive-*.mjs` — `grep -h "PORT = "
// scripts/drive-*.mjs` before picking a new one, per this drive's own brief.
const PORT = 18777;
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

const DEVICE_COUNT = 16;

// ---------------------------------------------------------------------------
// Step 0: the wasm artefact — same check every drawing drive makes; never
// built here silently.
// ---------------------------------------------------------------------------
const WASM_ARTIFACT = CLIENT + '/public/engine/fathom_wasm.wasm';
if (!existsSync(WASM_ARTIFACT)) {
  console.log('==> building the wasm artefact (missing): bash scripts/build-wasm.sh');
  execFileSync('bash', [ROOT + '/scripts/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
check('the wasm artefact exists', existsSync(WASM_ARTIFACT), WASM_ARTIFACT);

// ---------------------------------------------------------------------------
// Step 1: copy the shared throwaway harness into `client/`.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Step 2: the client dev server, this run's own port.
// ---------------------------------------------------------------------------
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyDriveCpuThrottle(page);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/drive.html?scene=node-identity`);
  await page.waitForSelector('.drawing', { timeout: 15_000 });
  await page.waitForFunction(
    (n) => document.querySelectorAll('.react-flow__node-chassis').length === n,
    DEVICE_COUNT,
    { timeout: 15_000 },
  );
  check(`the scene placed all ${DEVICE_COUNT} devices`, true);

  // Let the very first draw's own real measurement settle (every node is
  // genuinely unmeasured for one frame on mount — that is not this bug)
  // before the observer starts counting.
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    window.__hiddenTransitions__ = 0;
    window.__hiddenIds__ = new Set();
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const el = m.target;
        if (!(el instanceof HTMLElement) || !el.classList.contains('react-flow__node')) continue;
        if (el.style.visibility === 'hidden') {
          window.__hiddenTransitions__ += 1;
          window.__hiddenIds__.add(el.getAttribute('data-id'));
        }
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['style'], subtree: true });
    window.__stopNodeIdentityObserver__ = () => observer.disconnect();
  });

  // -------------------------------------------------------------------
  // 1. Hover — the cable between dev-01 and dev-02 (s6f #2, approach #1's
  //    own rejection note: "cable hover still changed every node").
  // -------------------------------------------------------------------
  const cableEdge = page.locator('.react-flow__edge').first();
  await cableEdge.waitFor({ state: 'visible', timeout: 10_000 });
  const edgeBox = await cableEdge.boundingBox();
  if (edgeBox) {
    await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2);
    await page.waitForTimeout(200);
  }
  await page.mouse.move(50, 50); // off the cable, its own leave
  await page.waitForTimeout(200);
  check('1. hovered the cable between dev-01 and dev-02', edgeBox != null);

  // -------------------------------------------------------------------
  // 2. Selection — click several different devices in turn.
  // -------------------------------------------------------------------
  const chassisNodes = page.locator('.react-flow__node-chassis');
  for (const i of [0, 5, 10, 3, 15]) {
    await chassisNodes.nth(i).click();
    await page.waitForTimeout(150);
  }
  check('2. selected five different devices in turn', true);

  // -------------------------------------------------------------------
  // 3. Drag — dev-16 (unrelated to the cabled pair or anything selected
  //    last), jiggled a few pixels and released back in the same slot
  //    (`geometry.ts`'s own `snapDropToU` rounds a few px either way back
  //    to the SAME `positionU` it started at). A gesture that ends with no
  //    real edit at all — this proves the DRAG itself never disturbs a
  //    node's own reference; a drop that genuinely relocates a device is a
  //    real, one-time content change for that one device, a different
  //    question from this drive's own ("nothing about this render should
  //    disturb a node NOTHING changed for").
  // -------------------------------------------------------------------
  const dragged = chassisNodes.nth(15);
  const dragBox = await dragged.boundingBox();
  check('3. found a device to drag', dragBox != null);
  if (dragBox) {
    const fx = dragBox.x + dragBox.width / 2;
    const fy = dragBox.y + dragBox.height / 2;
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy - 3, { steps: 4 });
    await page.mouse.move(fx, fy + 3, { steps: 4 });
    await page.mouse.move(fx, fy, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }

  // -------------------------------------------------------------------
  // 3b. A drag that actually relocates a device: the device must follow
  //     the pointer live (checked mid-drag, before release) and settle at
  //     the new slot after drop — not stay put, not merely jump there on
  //     release.
  // -------------------------------------------------------------------
  const dev1 = chassisNodes.nth(0);
  const dev1Before = await dev1.boundingBox();
  check('3b. found dev-01 to relocate', dev1Before != null);
  if (dev1Before) {
    const fx = dev1Before.x + dev1Before.width / 2;
    const fy = dev1Before.y + dev1Before.height / 2;
    const tx = fx;
    const ty = fy + 300; // well past U 16 (every occupied slot), lands on free rack space
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 150, { steps: 8 });
    const midDrag = await dev1.boundingBox();
    await page.mouse.move(tx, ty, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const dev1After = await dev1.boundingBox();
    const midMoved = midDrag != null && Math.abs(midDrag.y - dev1Before.y) > 50;
    check('3b. followed the pointer mid-drag (not a jiggle)', midMoved, midDrag ? `moved ${Math.abs(midDrag.y - dev1Before.y)}px` : 'no box');
    const settledMoved = dev1After != null && Math.abs(dev1After.y - dev1Before.y) > 50;
    check('3b. settled at the new slot after drop', settledMoved, dev1After ? `moved ${Math.abs(dev1After.y - dev1Before.y)}px` : 'no box');
  }

  // -------------------------------------------------------------------
  // 4. Wheel-zoom — in, then out, at the pane's own centre.
  // -------------------------------------------------------------------
  const paneBox = await page.locator('.react-flow__pane').boundingBox();
  check('4. found the pane to zoom', paneBox != null);
  if (paneBox) {
    const cx = paneBox.x + paneBox.width / 2;
    const cy = paneBox.y + paneBox.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, -240); // zoom in
      await page.waitForTimeout(40);
    }
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, 240); // zoom back out
      await page.waitForTimeout(40);
    }
  }
  await page.waitForTimeout(300);

  const hiddenCount = await page.evaluate(() => {
    window.__stopNodeIdentityObserver__?.();
    return window.__hiddenTransitions__;
  });
  const hiddenIds = await page.evaluate(() => Array.from(window.__hiddenIds__ ?? []));
  check(
    'no `.react-flow__node` turned hidden after the first draw (hover, select, drag, wheel-zoom)',
    hiddenCount === 0,
    hiddenCount === 0 ? '' : `${hiddenCount} transitions on ${JSON.stringify(hiddenIds)}`,
  );

  check('no uncaught page error the whole run', pageErrors.length === 0, pageErrors.join(' | '));

  await page.screenshot({ path: SHOTS + 'node-identity.png' });
  console.log('    wrote ' + SHOTS + 'node-identity.png');
} finally {
  if (browser) await browser.close();
  if (viteProc) viteProc.kill('SIGTERM');
  for (const f of [PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE]) {
    rmSync(f, { force: true });
  }
}

console.log(fails.length === 0 ? '\nALL CHECKS PASSED' : `\n${fails.length} CHECK(S) FAILED:\n- ${fails.join('\n- ')}`);
process.exit(fails.length === 0 ? 0 : 1);
