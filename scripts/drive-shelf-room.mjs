// Drives sign-off r63 end to end: stepping into a shelf by double-click, by its "+N", by right-click Open
// shelf and by the panel's Open shelf; the path back to the rack; a device opened from the shelf and back.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-shelf-room.mjs. Screenshots land in FATHOM_SHOTS.
// Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, fails, waitForServer } from './drive-lib/kit.mjs';

const pw = await import(
  process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js'
);
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM
  || '/opt/pw-browsers/chromium';
const CLIENT = ROOT + '/client';
const DRIVE_LIB = ROOT + '/scripts/drive-lib';
const PORT = 5361;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

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

  const room = (page) => page.locator('[data-testid=shelf-room]');
  const shelfNode = (page) => page.locator('.react-flow__node-shelf').first();
  const pathLabels = (page) => page.locator('.shell-bar__path-label');
  const leave = async (page) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  };

  {
    const { context, page, pageErrors } = await open('shelf-room');
    await shot(page, 'r63-0-rack');
    check('the full shelf folds the rest into "+N"', (await page.locator('.drawing-shelf__compact-more').count()) === 1);

    // 1. Double-click the tray, away from the names.
    const box = await shelfNode(page).boundingBox();
    await page.mouse.dblclick(box.x + 6, box.y + box.height / 2);
    await page.waitForSelector('[data-testid=shelf-room]', { timeout: 5_000 });
    const text = await room(page).innerText();
    check('double-click steps into the shelf', true);
    for (const name of ['padparadscha', 'morpheus-nas', 'homeassistant', 'pihole-02', 'kvm']) check(`the shelf view names ${name} whole`, text.includes(name), text);
    check('the empty slot is drawn', text.includes('SLOT 4') && (await page.locator('.shelf-room__gap').count()) === 1);
    check('a cabled port says where it goes', text.includes('to core-sw'), text);
    const crumbs = await pathLabels(page).allInnerTexts();
    check('the path ends rack, then shelf', crumbs.slice(-2).join(' › ') === 'A-04 › Top shelf', crumbs.join(' › '));
    await shot(page, 'r63-1-shelf');

    // A click selects a thing: the panel shows it.
    await page.locator('.shelf-room__thing', { hasText: 'morpheus-nas' }).click();
    await page.waitForTimeout(300);
    check('a click selects a thing on the shelf', (await page.locator('.shelf-room__thing--selected').innerText()).includes('morpheus-nas'));
    await shot(page, 'r63-2-selected');
    // A device on a shelf gets a racked device's whole panel: the ⋯ menu, its name to rename, the foot.
    check('a shelf device has the ⋯ menu', (await page.locator('[data-testid=device-more]').count()) === 1);
    check('a shelf device has Open inside on the foot', (await page.locator('[data-testid=device-open-inside]').count()) === 1);
    check('a shelf device has the Notes tab', /notes/i.test(await page.locator('.drawing-editor__panel--device').innerText()));
    await page.locator('[data-testid=device-more] summary').click();
    const panelMenu = await page.locator('.dev-more__menu').innerText();
    check('its ⋯ menu ends with Remove device', panelMenu.includes('Remove device'), panelMenu);
    await page.locator('[data-testid=device-more] summary').click();

    // A double-click on a device opens it, and leaving it comes back to the shelf.
    await page.locator('.shelf-room__thing', { hasText: 'padparadscha' }).dblclick();
    await page.waitForSelector('[data-testid=jot]', { timeout: 5_000 });
    const deep = await pathLabels(page).allInnerTexts();
    check('the device opens with the shelf in its path', deep.slice(-3).join(' › ') === 'A-04 › Top shelf › padparadscha', deep.join(' › '));
    await shot(page, 'r63-3-device');
    await leave(page);
    check('Esc from the device comes back to the shelf', (await page.locator('[data-testid=jot]').count()) === 0 && (await room(page).count()) === 1);
    await leave(page);
    check('Esc from the shelf goes back to the rack', (await room(page).count()) === 0);

    // 2. The "+N".
    await page.locator('.drawing-shelf__compact-more').click();
    await page.waitForSelector('[data-testid=shelf-room]', { timeout: 5_000 });
    check('"+N" steps into the shelf', true);
    // The rack's crumb leads back to the rack.
    await pathLabels(page).nth(-2).click();
    await page.waitForTimeout(300);
    check('the rack in the path leads back out', (await room(page).count()) === 0);

    // 3. Right-click the tray.
    await page.mouse.click(box.x + 6, box.y + box.height / 2, { button: 'right' });
    const items = await page.locator('.drawing-context-menu__item').allInnerTexts();
    check('right-click on a shelf offers Open shelf first', items[0]?.startsWith('Open shelf'), items.join(' | '));
    await shot(page, 'r63-4-menu');
    await page.locator('.drawing-context-menu__item', { hasText: 'Open shelf' }).click();
    await page.waitForSelector('[data-testid=shelf-room]', { timeout: 5_000 });
    check('Open shelf in the menu steps in', true);
    await leave(page);

    // 4. The shelf's panel.
    await page.mouse.click(box.x + 6, box.y + box.height / 2);
    await page.waitForSelector('[data-testid=shelf-open]', { timeout: 5_000 });
    await shot(page, 'r63-5-panel');
    await page.locator('[data-testid=shelf-open]').click();
    await page.waitForSelector('[data-testid=shelf-room]', { timeout: 5_000 });
    check('the panel\'s Open shelf steps in', true);
    await leave(page);

    // 5. Right-click a device drawn on the shelf: the same menu as a racked device's.
    await page.locator('.react-flow__node-shelf [data-device-chassis]').first().click({ button: 'right' });
    const devItems = await page.locator('.drawing-context-menu__item').allInnerTexts();
    for (const want of ['Open inside', 'Fit a card', 'Remove device']) check(`right-click on a shelf device offers ${want}`, devItems.some((i) => i.startsWith(want)), devItems.join(' | '));
    await shot(page, 'r63-6-device-menu');
    await page.keyboard.press('Escape');

    check('no uncaught page errors (shelf room)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

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
}

console.log(fails.length ? '\nFAILURES:\n  ' + fails.join('\n  ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
