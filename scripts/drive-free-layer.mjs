// Drives ADR-0060 step 7 end to end: free boxes, lines, edge squares, marquee, align, duplicate,
// areas, rack squares and the shelf grips; screenshots land in FATHOM_SHOTS.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-free-layer.mjs.
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
const PORT = 5337;
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

  // Part 1: boxes, lines, squares, marquee, align, duplicate, area, undo.
  {
    const { context, page, pageErrors } = await open('empty');
    await addBoxAt(page, 200, 300, 'Switch');
    check('a box is added from the right-click menu', (await boxes(page).count()) === 1);
    await addBoxAt(page, 520, 300, 'Router');
    check('a second box is added', (await boxes(page).count()) === 2);
    await boxes(page).first().click();
    await page.waitForTimeout(200);
    check('a selected box shows its edge squares', (await page.locator('.free-square--r').count()) === 1);
    await shot(page, 'FL-01-box-selected');

    const sq = await page.locator('.free-square--r').boundingBox();
    const target = await boxes(page).nth(1).boundingBox();
    await page.mouse.move(sq.x + 5, sq.y + 5);
    await page.mouse.down();
    await page.mouse.move(target.x + 30, target.y + 20, { steps: 8 });
    await shot(page, 'FL-02-drawing-line');
    await page.mouse.up();
    await page.waitForTimeout(300);
    check('dragging a square draws a line', (await page.locator('.free-line__ink').count()) === 1);

    await boxes(page).first().click();
    const sq2 = await page.locator('.free-square--b').boundingBox();
    await page.mouse.click(sq2.x + 5, sq2.y + 5);
    await page.waitForTimeout(200);
    await shot(page, 'FL-03-new-box-menu');
    await pickKind(page, 'Server');
    check('clicking a square adds a box joined by a line', (await boxes(page).count()) === 3 && (await page.locator('.free-line__ink').count()) === 2);

    await page.mouse.click(700, 700);
    await page.mouse.move(60, 150);
    await page.mouse.down();
    await page.mouse.move(1000, 650, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    check('a marquee selects the boxes and offers the word menu', (await page.locator('.free-wordmenu').count()) === 1);
    await shot(page, 'FL-04-marquee-wordmenu');
    await page.locator('.free-wordmenu__item', { hasText: 'Align' }).click();
    await page.locator('.drawing-context-menu__item', { hasText: /left/i }).first().click();
    await page.waitForTimeout(300);
    const xs = await Promise.all([0, 1, 2].map(async (i) => Math.round((await boxes(page).nth(i).boundingBox()).x)));
    check('Align left lines the boxes up', new Set(xs).size === 1, xs.join(','));
    await shot(page, 'FL-05-aligned');

    await page.keyboard.press('Control+d');
    await page.waitForTimeout(400);
    check('Ctrl D duplicates the selection', (await boxes(page).count()) === 6);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(400);
    check('one undo takes the whole duplicate back', (await boxes(page).count()) === 3);

    await page.mouse.click(700, 120);
    await page.mouse.click(700, 120, { button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Add an area here' }).click();
    await page.waitForTimeout(300);
    check('an area is added', (await page.locator('.free-area').count()) === 1);
    await shot(page, 'FL-06-area');
    check('no uncaught page errors (free layer)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // Part 2: squares on a rack.
  {
    const { context, page, pageErrors } = await open('canvas');
    const before = await page.locator('.react-flow__node-chassis').count();
    await page.locator('.react-flow__node-chassis').first().click();
    await page.waitForTimeout(300);
    const n = await page.locator('.rack-square').count();
    check('a selected racked device shows squares on its free units', n >= 1, String(n));
    await shot(page, 'FL-07-rack-squares');
    await page.locator('.rack-square').first().click();
    await page.waitForTimeout(200);
    await pickKind(page, 'Switch');
    check('clicking a rack square adds a device', (await page.locator('.react-flow__node-chassis').count()) === before + 1);
    check('no uncaught page errors (rack squares)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // Part 3: shelf grips.
  {
    const { context, page, pageErrors } = await open('shelf');
    await page.locator('.react-flow__node-shelf').first().click({ position: { x: 20, y: 6 } });
    await page.waitForTimeout(300);
    const grip = page.locator('.drawing-shelf__grip--h');
    check('a selected shelf shows its grips', (await grip.count()) === 1 && (await page.locator('.drawing-shelf__grip--w').count()) === 1);
    const heightOf = async () => Number(/height \(u\)\s*(\d+)/i.exec(await page.locator('.drawing-editor__panel').innerText())?.[1]);
    const was = await heightOf();
    const b = await grip.boundingBox();
    await page.mouse.move(b.x + 5, b.y + 5);
    await page.mouse.down();
    await page.mouse.move(b.x + 5, b.y + 5 + 40, { steps: 6 });
    check('dragging the bottom grip shows the new unit dashed', (await page.locator('.drawing-shelf__proposed').count()) === 1);
    await shot(page, 'FL-08-shelf-grow');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(200);
    check('Esc cancels the resize', (await page.locator('.drawing-shelf__proposed').count()) === 0);
    const g2 = await page.locator('.drawing-shelf__grip--h').boundingBox();
    await page.mouse.move(g2.x + 5, g2.y + 5);
    await page.mouse.down();
    await page.mouse.move(g2.x + 5, g2.y + 5 + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const now = await heightOf();
    check('letting go keeps it: the panel shows the new height', now > was, `${was} -> ${now}`);
    await shot(page, 'FL-09-shelf-grown');
    check('no uncaught page errors (shelf)', pageErrors.length === 0, pageErrors.join(' | '));
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
