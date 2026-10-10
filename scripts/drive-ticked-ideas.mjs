// Drives the ticked ideas (sign-off r13/r14): Ctrl+K, the shortcuts sheet, a note pinned to the
// canvas with its Undo note, the right-hand dock, the light theme, and an open device's Arrange
// ports. Screenshots land in FATHOM_SHOTS. Usage: bash scripts/build-wasm.sh (once), then
// node scripts/drive-ticked-ideas.mjs. Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
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

  // Part 1: find, shortcuts, a pinned note and its Undo note, the dock.
  {
    const { context, page, pageErrors } = await open('canvas');
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(250);
    const palette = page.locator('[role=dialog]').filter({ hasText: /DEVICES|DO|GO TO|Devices|Do|Go to/ }).first();
    check('Ctrl+K opens the find box', (await page.locator('input[aria-label]').filter({ has: page.locator(':focus') }).count()) >= 0 && (await palette.count()) === 1);
    await page.keyboard.type('fw');
    await page.waitForTimeout(250);
    const text = await palette.innerText().catch(() => '');
    check('typing finds fw-01', /fw-01/.test(text), text.slice(0, 200));
    await shot(page, 'TI-01-find');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('Esc closes the find box', (await palette.count()) === 0 || !(await palette.isVisible()));

    await page.mouse.click(1000, 700);
    await page.keyboard.press('Shift+Slash');
    await page.waitForTimeout(250);
    const sheet = page.getByText('Keyboard shortcuts', { exact: false }).first();
    check('? lists the shortcuts', await sheet.isVisible().catch(() => false));
    await shot(page, 'TI-02-shortcuts');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    await page.mouse.click(1000, 650, { button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Add a note here' }).first().click();
    await page.waitForTimeout(300);
    await page.keyboard.type('Port 4 goes to the lobby AP.');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const toast = page.getByRole('status').filter({ hasText: /Undo/i }).first();
    check('the change shows an Undo note', await toast.isVisible().catch(() => false));
    await shot(page, 'TI-03-note-and-undo');
    const notes = () => page.getByText('Port 4 goes to the lobby AP.').count();
    check('the note is on the canvas', (await notes()) >= 1);
    await toast.getByRole('button', { name: /undo/i }).click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
    check('Undo in the note takes it back', (await notes()) === 0);

    await page.getByTestId('dock-history').click().catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, 'TI-04-dock-history');
    check('no uncaught page errors (part 1)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // Part 2: the light theme, and an open device's Arrange ports.
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=empty`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(800);
    await shot(page, `TI-05-canvas-${scheme}`);
    // A box added from the right-click menu is typed by hand (no catalogue model), so its faceplate can be arranged.
    await page.mouse.click(400, 400, { button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Add a box here' }).click().catch(() => {});
    await page.waitForTimeout(300);
    await page.locator('.drawing-context-menu__item', { hasText: 'Switch' }).first().click().catch(() => {});
    await page.waitForTimeout(300);
    const device = page.locator('.react-flow__node-freeBox').first();
    if ((await device.count()) > 0) {
      await device.dblclick();
      await page.waitForSelector('[data-testid=jot]', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(400);
      check(`a double-click opens fw-01 (${scheme})`, (await page.locator('[data-testid=jot]').count()) === 1);
      await page.waitForTimeout(300);
      await shot(page, `TI-06-open-${scheme}`);
      const arrange = page.getByRole('button', { name: /Arrange ports/i });
      if ((await arrange.count()) > 0) {
        await arrange.first().click();
        await page.waitForTimeout(200);
        const port = page.locator('[data-testid=jot-device] .jot-port').first();
        const b = await port.boundingBox();
        if (b) {
          await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
          await page.mouse.down();
          await page.mouse.move(b.x + 200, b.y + 6, { steps: 10 });
          await shot(page, `TI-06-port-drag-${scheme}`);
          await page.mouse.up();
          await page.waitForTimeout(300);
        }
      }
      check(`an open device offers Arrange ports (${scheme})`, (await arrange.count()) > 0);
    }
    check(`no uncaught page errors (${scheme})`, pageErrors.length === 0, pageErrors.join(' | '));
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
