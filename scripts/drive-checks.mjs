// Drives ADR-0061 §5 (Checks) end to end: a second cable onto an already-cabled port is refused with its reason
// and fix (nothing drawn), the panel and its Why? card, badges, Show (fade and camera); screenshots land in
// FATHOM_SHOTS at three window sizes. Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-checks.mjs.
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
const PORT = 5339;
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
  // `at` picks where on a port to press or release: a cable drawn over a port covers its middle, so a
  // second cable lands on the port's left edge, the half a cable leaving rightwards does not cover.
  const cableByDrag = async (page, from, to, { fromAt = 0.5, toAt = 0.5 } = {}) => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    await page.mouse.move(a.x + a.width * fromAt, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * toAt, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  };
  const FORBIDDEN = /permitted|denied|you['’]re wrong/i;

  // The rack canvas: drag from a free port to a cabled one (refused, card at the pointer), then to a free one.
  {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=canvas`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(1200);
    for (let i = 0; i < 3; i += 1) {
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(600);
    const handleOf = (node, sel) => node.locator(`button.drawing-chassis__port${sel}[title*="RJ45"]`).first().locator('.drawing-chassis__port-handle');
    const fw = page.locator('.react-flow__node-chassis', { hasText: 'fw-01' });
    const sw = page.locator('.react-flow__node-chassis', { hasText: 'sw-02' });
    const dragHandles = async (from, to) => {
      const a = await from.boundingBox();
      const b = await to.boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(500);
    };
    const cablesBefore = await page.locator('.react-flow__edge').count();
    await dragHandles(handleOf(fw, ':not(.drawing-chassis__port--cabled)'), handleOf(sw, '.drawing-chassis__port--cabled'));
    check('[rack] a drop on a cabled port raises the card', (await page.locator('[data-testid=checks-refusal]').count()) === 1);
    const card = await page.locator('[data-testid=checks-refusal]').innerText();
    check('[rack] the card has the fact and the fix', /more than one cable/i.test(card) && /Fix:/.test(card), card.replace(/\s+/g, ' '));
    check('[rack] no colour picker, nothing drawn', (await page.locator('.drawing-picker').count()) === 0 && (await page.locator('.react-flow__edge').count()) === cablesBefore);
    await shot(page, 'checks-rack-refusal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('[rack] Esc dismisses the card', (await page.locator('[data-testid=checks-refusal]').count()) === 0);
    await dragHandles(handleOf(fw, ':not(.drawing-chassis__port--cabled)'), handleOf(sw, ':not(.drawing-chassis__port--cabled)'));
    check('[rack] a drop on a free port raises no card and offers the colour picker', (await page.locator('[data-testid=checks-refusal]').count()) === 0 && (await page.locator('.drawing-picker').count()) === 1);
    check('[rack] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  for (const [w, h] of SIZES) {
    const tag = `checks-${w}x${h}`;
    const context = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=canvas`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(1200);

    // The standing run: the bar chip is there, the panel follows the findings.
    check(`[${w}x${h}] the bar carries a Checks chip`, (await page.locator('[data-testid=checks-chip]').count()) === 1);
    check(`[${w}x${h}] the engine ran once the design settled`, (await page.locator('[data-testid=checks-panel]').count()) === 0 || (await page.locator('[data-testid=checks-panel]').innerText()).length > 0);
    await shot(page, `${tag}-01-canvas`);

    // Open a device, add equipment, cable one port, then a second cable onto the same port.
    await page.locator('.react-flow__node-chassis').first().dblclick();
    await page.waitForSelector('[data-testid=jot]', { timeout: 10_000 });
    await page.locator('.shell-strip--rail').click();
    await page.waitForTimeout(300);
    await page.locator('.drawing-palette__item', { hasText: 'Switch' }).first().click();
    await page.waitForTimeout(500);
    await page.locator('.drawing-palette__item', { hasText: 'Router' }).first().click();
    await page.waitForTimeout(500);
    check(`[${w}x${h}] two boxes beside the device`, (await page.locator('[data-testid=jot-box]').count()) === 2);
    const devicePort = page.locator('[data-testid=jot-device] .jot-port[title*="RJ45 · free"]').first();
    await cableByDrag(page, devicePort, page.locator('[data-testid=jot-box]').nth(0).locator('.jot-port').first());
    check(`[${w}x${h}] a free port to a free port draws a cable`, (await page.locator('[data-testid=jot-cable]').count()) === 1);
    check(`[${w}x${h}] a clean cable raises no card`, (await page.locator('[data-testid=checks-refusal]').count()) === 0);
    await page.waitForTimeout(500);

    const cabled = page.locator('[data-testid=jot-device] .jot-port[title*="RJ45 · cabled"]').first();
    await cableByDrag(page, page.locator('[data-testid=jot-box]').nth(1).locator('.jot-port').first(), cabled, { toAt: 0.1 });
    check(`[${w}x${h}] a second cable onto a cabled port is not drawn`, (await page.locator('[data-testid=jot-cable]').count()) === 1);
    await page.waitForSelector('[data-testid=checks-refusal]', { timeout: 5_000 });
    const card = await page.locator('[data-testid=checks-refusal]').innerText();
    check(`[${w}x${h}] the card says it plainly`, card.includes("That isn't how this works"), card.replace(/\s+/g, ' '));
    check(`[${w}x${h}] the card gives the sentence and the fix`, /more than one cable/i.test(card) && /Fix:/.test(card), card.replace(/\s+/g, ' '));
    check(`[${w}x${h}] the card never uses the forbidden words`, !FORBIDDEN.test(card));
    const cardBox = await page.locator('[data-testid=checks-refusal]').boundingBox();
    check(`[${w}x${h}] the card sits inside the window`, cardBox.x >= 0 && cardBox.y >= 0 && cardBox.x + cardBox.width <= w && cardBox.y + cardBox.height <= h);
    await shot(page, `${tag}-02-refusal`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check(`[${w}x${h}] Esc dismisses the card and leaves the device open`, (await page.locator('[data-testid=checks-refusal]').count()) === 0 && (await page.locator('[data-testid=jot]').count()) === 1);

    // Again, this time Why? opens the panel's card.
    await cableByDrag(page, page.locator('[data-testid=jot-box]').nth(1).locator('.jot-port').first(), page.locator('[data-testid=jot-device] .jot-port[title*="RJ45 · cabled"]').first(), { toAt: 0.1 });
    await page.waitForSelector('[data-testid=checks-refusal]', { timeout: 5_000 });
    await page.locator('[data-testid=checks-refusal]').getByRole('button', { name: 'Why?' }).click();
    await page.waitForSelector('[data-testid=checks-why]', { timeout: 5_000 });
    const why = await page.locator('[data-testid=checks-why]').innerText();
    check(`[${w}x${h}] Why? opens the panel's card with the reason, the fix and the basis`, /Fix:/.test(why) && /basis|source/i.test(why), why.replace(/\s+/g, ' ').slice(0, 300));
    check(`[${w}x${h}] the why card does not show the concept id`, !/check\.phy\./.test(why));
    check(`[${w}x${h}] the card is gone once Why? is taken`, (await page.locator('[data-testid=checks-refusal]').count()) === 0);
    await shot(page, `${tag}-03-why`);

    // Back out: the boxes are on the canvas; the switch has one cable, so the panel has an idea.
    await page.locator('[data-testid=checks-why]').getByRole('button', { name: 'Close' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    check(`[${w}x${h}] Esc leads back to the canvas`, (await page.locator('[data-testid=jot]').count()) === 0);
    if ((await page.locator('[data-testid=checks-panel]').count()) === 0) await page.locator('[data-testid=checks-chip]').click();
    await page.waitForSelector('[data-testid=checks-panel]');
    await page.waitForTimeout(600);
    const rows = await page.locator('[data-testid=checks-row]').allInnerTexts();
    check(`[${w}x${h}] the panel lists the single-cable idea`, rows.some((r) => /only one cable/i.test(r)), rows.join(' | ').replace(/\s+/g, ' '));
    check(`[${w}x${h}] rows carry a glyph and a word`, rows.every((r) => /[✕▲○]/.test(r) && /can't work|warning|idea/i.test(r)));
    const chip = await page.locator('[data-testid=checks-chip]').innerText();
    check(`[${w}x${h}] the chip shows the count`, /Checks \d+/.test(chip), chip);
    const badgeCount = await page.locator('[data-testid=checks-badge]').count();
    check(`[${w}x${h}] a badge sits on the device`, badgeCount >= 1, String(badgeCount));
    await shot(page, `${tag}-04-panel-badge`);

    // The panel stays clear of the bar and the canvas controls.
    const panel = await page.locator('[data-testid=checks-panel]').boundingBox();
    const bar = await page.locator('.shell-bar').boundingBox();
    const ctl = await page.locator('.drawing-cables-control').boundingBox();
    check(`[${w}x${h}] the panel is below the bar and inside the window`, panel.y >= bar.y + bar.height && panel.x + panel.width <= w && panel.y + panel.height <= h, JSON.stringify(panel));
    check(`[${w}x${h}] the panel does not cover the cables control`, ctl == null || panel.x >= ctl.x + ctl.width || panel.y >= ctl.y + ctl.height);

    // Show: fade everything else and move the camera.
    const before = await page.locator('.react-flow__viewport').getAttribute('style');
    await page.locator('[data-testid=checks-row]').first().getByRole('button', { name: 'Show' }).click();
    await page.waitForTimeout(900);
    const faded = await page.locator('.react-flow__node.checks-faded').count();
    const unfaded = await page.locator('.react-flow__node:not(.checks-faded)').count();
    check(`[${w}x${h}] Show fades the other nodes`, faded > 0 && unfaded >= 1, `${faded} faded, ${unfaded} full`);
    const opacity = await page.locator('.react-flow__node.checks-faded').first().evaluate((el) => getComputedStyle(el).opacity);
    check(`[${w}x${h}] the fade is the phantom 28%`, Math.abs(Number(opacity) - 0.28) < 0.01, opacity);
    check(`[${w}x${h}] Show moves the camera`, (await page.locator('.react-flow__viewport').getAttribute('style')) !== before);
    await shot(page, `${tag}-05-show`);
    await page.locator('[data-testid=checks-row]').first().getByRole('button', { name: 'Show' }).click();
    await page.waitForTimeout(300);
    check(`[${w}x${h}] Show again clears the fade`, (await page.locator('.checks-faded').count()) === 0);
    await page.locator('[data-testid=checks-row]').first().getByRole('button', { name: 'Show' }).click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check(`[${w}x${h}] Esc clears the fade`, (await page.locator('.checks-faded').count()) === 0);
    await page.locator('[data-testid=checks-row]').first().getByRole('button', { name: 'Show' }).click();
    await page.waitForTimeout(300);
    await page.mouse.click(w / 2 - 100, h - 60);
    await page.waitForTimeout(300);
    check(`[${w}x${h}] a click on empty canvas clears the fade`, (await page.locator('.checks-faded').count()) === 0);

    // Drag the panel by its header; the place is remembered for this browser.
    const head = await page.locator('.checks-panel__head').boundingBox();
    await page.mouse.move(head.x + 40, head.y + 10);
    await page.mouse.down();
    await page.mouse.move(head.x - 60, head.y + 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const moved = await page.locator('[data-testid=checks-panel]').boundingBox();
    check(`[${w}x${h}] the header drags the panel`, Math.abs(moved.x - panel.x) > 20, `${panel.x} -> ${moved.x}`);
    const stored = await page.evaluate(() => localStorage.getItem('fathom.checks.panel'));
    check(`[${w}x${h}] the place is remembered`, stored != null && JSON.parse(stored).x !== 0, String(stored));
    await shot(page, `${tag}-06-dragged`);
    await page.locator('.checks-panel__head').getByRole('button', { name: 'Fold the Checks panel' }).click();
    await page.waitForTimeout(200);
    check(`[${w}x${h}] Fold leaves only the count in the bar`, (await page.locator('[data-testid=checks-panel]').count()) === 0 && (await page.locator('[data-testid=checks-chip]').count()) === 1);

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
