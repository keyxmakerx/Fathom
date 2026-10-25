// Drives ADR-0068 §2 and §3 end to end: the Back button's tree (where you are inside the design, a name and a
// kind word per line, "you are here", Esc and an outside click fold it, a click on the empty canvas only
// folds it and leaves the selection, no Forward button) and the Equipment tab (opens by itself on an empty
// design until it is closed once on that design, and stays shut when the design is opened again; an Add
// equipment button on the empty canvas). Screenshots
// land in FATHOM_SHOTS.

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
const PORT = 5343;
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

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  async function open(scene) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=${scene}`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(1500);
    return { context, page, pageErrors };
  }
  const shot = async (page, name) => {
    await page.screenshot({ path: SHOTS + name + '.png' });
    console.log('    wrote ' + SHOTS + name + '.png');
  };
  const eq = (page) => page.locator('[data-testid="dock-equipment"]');

  // Part 1 (ADR-0068 section 3): an empty design.
  {
    const { context, page, pageErrors } = await open('empty');
    check('Equipment opens by itself on an empty design', (await eq(page).getAttribute('aria-expanded')) === 'true');
    check('the palette is showing', (await page.locator('.drawing-palette__search').count()) === 1);
    const hint = await page.locator('.drawing-empty-hint p').innerText();
    check('the empty hint names the right edge, as the dock has it', hint.includes('Equipment tab on the right edge') && !/left/i.test(hint), hint);
    const dockBox = await eq(page).boundingBox();
    check('and the Equipment tab really is on the right', dockBox != null && dockBox.x > 1400 - 80, JSON.stringify(dockBox));
    check('the empty canvas has an Add equipment button', (await page.locator('[data-testid="add-equipment"]').count()) === 1);
    await shot(page, 'empty-design-equipment-open');

    // A person who closes it is left alone.
    await eq(page).click();
    await page.waitForTimeout(500);
    check('closing Equipment keeps it closed', (await eq(page).getAttribute('aria-expanded')) === 'false');
    await page.waitForTimeout(1500);
    check('and it does not open again by itself', (await eq(page).getAttribute('aria-expanded')) === 'false');
    await shot(page, 'empty-design-equipment-closed');
    // Opened again (the same browser, the same design), it stays shut: it was closed once.
    await page.reload();
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(1500);
    check('opening the design again leaves Equipment shut', (await eq(page).getAttribute('aria-expanded')) === 'false');
    check('and the empty design still offers the Add equipment button', (await page.locator('[data-testid="add-equipment"]').count()) === 1);
    await page.locator('[data-testid="add-equipment"]').click();
    await page.waitForTimeout(500);
    check('Add equipment opens it', (await eq(page).getAttribute('aria-expanded')) === 'true' && (await page.locator('.drawing-palette__search').count()) === 1);
    check('no uncaught page errors (empty)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // Part 2: a design with devices does not open Equipment by itself, and the Back tree works.
  {
    const { context, page, pageErrors } = await open('canvas');
    check('Equipment stays shut on a design with devices', (await eq(page).getAttribute('aria-expanded')) === 'false');
    check('no Add equipment button where the canvas is not empty', (await page.locator('[data-testid="add-equipment"]').count()) === 0);
    check('nothing selected: no fold-out arrow yet', (await page.locator('[data-testid="jump-tree-toggle"]').count()) === 0);

    await page.locator('.react-flow__node-chassis').first().click();
    await page.waitForTimeout(700);
    const toggle = page.locator('[data-testid="jump-tree-toggle"]');
    check('selecting a device shows the arrow', (await toggle.count()) === 1);
    check('the arrow starts folded', (await toggle.getAttribute('aria-expanded')) === 'false');
    await toggle.click();
    await page.waitForTimeout(400);
    const lines = page.locator('[data-testid="jump-tree-line"]');
    const texts = await lines.allInnerTexts();
    console.log('    tree: ' + texts.map((t) => t.replace(/\n/g, ' ')).join(' | '));
    check('it unfolds', (await toggle.getAttribute('aria-expanded')) === 'true' && texts.length >= 3);
    check('the first line is the design', /DESIGN/.test(texts[0] ?? ''));
    check('then the rack', /RACK/.test(texts[1] ?? ''));
    check('and the device is last, marked you are here', /DEVICE/.test(texts.at(-1) ?? '') && /you are here/i.test(texts.at(-1) ?? ''));
    check('exactly one line is current', (await page.locator('[data-testid="jump-tree"] [aria-current="location"]').count()) === 1);
    check('focus starts on the current line', await page.evaluate(() => document.activeElement?.getAttribute('aria-current') === 'location'));
    await shot(page, 'back-tree-device-in-rack');
    await page.keyboard.press('ArrowUp');
    check('ArrowUp moves up a line', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'jump-tree-line' && document.activeElement?.getAttribute('aria-current') !== 'location'));

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Esc folds it', (await page.locator('[data-testid="jump-tree"]').count()) === 0 && (await toggle.getAttribute('aria-expanded')) === 'false');
    await toggle.click();
    await page.waitForTimeout(300);
    await page.mouse.click(760, 18);
    await page.waitForTimeout(300);
    check('a click outside folds it', (await page.locator('[data-testid="jump-tree"]').count()) === 0 && (await toggle.count()) === 1);

    // A click on the empty canvas while it is open only folds it: the selection stays; the next such click clears it.
    const emptySpot = await page.evaluate(() => {
      for (let y = 120; y < 860; y += 20) {
        for (let x = 40; x < 1000; x += 20) {
          const t = document.elementFromPoint(x, y);
          if (t?.closest('.react-flow__pane') && !t.closest('.react-flow__node, .react-flow__edge, .jump-trail')) return { x, y };
        }
      }
      return null;
    });
    check('there is empty canvas to click', emptySpot != null);
    await toggle.click();
    await page.waitForTimeout(300);
    check('the tree is open before the empty-canvas click', (await page.locator('[data-testid="jump-tree"]').count()) === 1);
    await page.mouse.click(emptySpot.x, emptySpot.y);
    await page.waitForTimeout(400);
    check('one click on empty canvas folds the tree', (await page.locator('[data-testid="jump-tree"]').count()) === 0);
    check('and leaves the selection as it was', (await toggle.count()) === 1);
    await page.mouse.click(emptySpot.x, emptySpot.y);
    await page.waitForTimeout(400);
    check('the next click on empty canvas clears the selection as usual', (await page.locator('[data-testid="jump-tree-toggle"]').count()) === 0);
    await page.locator('.react-flow__node-chassis').first().click();
    await page.waitForTimeout(700);

    // Choosing the rack line goes there: the device is no longer the selection, the rack is.
    await toggle.click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="jump-tree-line"]').nth(1).click();
    await page.waitForTimeout(800);
    const after = await page.locator('[data-testid="jump-tree-line"]').count();
    check('choosing the rack line folds the tree', after === 0);
    await toggle.click();
    await page.waitForTimeout(300);
    const t2 = await page.locator('[data-testid="jump-tree-line"]').allInnerTexts();
    check('and the rack is now the line you are at', t2.length === 2 && /RACK/.test(t2.at(-1) ?? '') && /you are here/i.test(t2.at(-1) ?? ''), t2.join(' | '));
    check('and Back now names where it came from', (await page.locator('[data-testid="jump-back"]').count()) === 1);
    check('there is no Forward button, even now', (await page.locator('[data-testid="jump-forward"]').count()) === 0);
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="jump-back"]').click();
    await page.waitForTimeout(900);
    check('Alt+Right still goes forward', await (async () => {
      await page.mouse.move(700, 500);
      await page.keyboard.press('Alt+ArrowRight');
      await page.waitForTimeout(900);
      const t = await page.locator('[data-testid="jump-back"]').count();
      return t === 1;
    })());
    check('no uncaught page errors (canvas)', pageErrors.length === 0, pageErrors.join(' | '));
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
