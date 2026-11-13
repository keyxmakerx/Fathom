// Drives sign-off r63 and shelf-view end to end: dragging a thing along the shelf, Back, the two ends, running a cable; stepping into a shelf by double-click, by its "+N", by right-click Open
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
  viteProc = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
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
    const text = await room(page).textContent();
    check('double-click steps into the shelf', true);
    for (const name of ['padparadscha', 'morpheus-nas', 'homeassistant', 'pihole-02', 'kvm', 'bnuuy-edge']) check(`the shelf view names ${name} whole`, text.includes(name), text);
    check('every thing on the shelf is drawn as its own box', (await page.locator('.shelf-room__thing[data-occupant-id]').count()) === 6);
    // Sign-off shelf-view, answer C: the same shelf from above, over the front view, each thing in both.
    check('the shelf is drawn from above too', text.includes('FROM ABOVE') && (await page.locator('[data-plan-id]').count()) === 6, text);
    check('a dashed line joins each thing\'s two drawings', (await page.locator('[data-guide-for]').count()) === 6);
    check('a size from the catalogue is drawn solid', (await page.locator('[data-occupant-id] .shelf-room__box:not(.shelf-room__box--guess)').count()) === 1);
    check('the shelf is drawn from the front, to scale', text.includes('FRONT · 450 MM INSIDE'), text);
    check('a cabled port says where it goes', text.includes('to core-sw'), text);
    const crumbs = await pathLabels(page).allInnerTexts();
    check('the path ends rack, then shelf', crumbs.slice(-2).join(' › ') === 'A-04 › Top shelf', crumbs.join(' › '));
    await shot(page, 'r63-1-shelf');

    // Sign-off shelf-view: drag a thing along the shelf. It moves, stays moved, and its cable follows.
    const thing = (name) => page.locator('.shelf-room__thing[data-occupant-id]', { hasText: name });
    const kvmBox = async () => (await thing('kvm').locator('rect').first().boundingBox());
    // Measured from the shelf's tray: the drawing is centred, so it shifts as a whole when its width changes.
    const tray = async () => (await page.locator('.shelf-room__tray').boundingBox()).x;
    const homeBefore = await thing('homeassistant').locator('rect').first().boundingBox();
    const trayBefore = await tray();
    const cableBefore = await page.locator('.shelf-room__cable').nth(2).getAttribute('d');
    const before = await kvmBox();
    await page.mouse.move(before.x + 10, before.y + 10);
    await page.mouse.down();
    await page.mouse.move(before.x + 10 + 80, before.y + 10, { steps: 6 });
    await shot(page, 'shelf-view-dragging');
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await kvmBox();
    check('a dragged thing moves along the shelf', Math.abs(after.x - before.x) > 20, `${before.x} -> ${after.x}`);
    check('placing one thing pins the rest where they were drawn', !(await room(page).textContent()).includes('not placed by hand'));
    const homeAfter = await thing('homeassistant').locator('rect').first().boundingBox();
    const trayAfter = await tray();
    check('nothing else moved', Math.abs(homeAfter.x - trayAfter - (homeBefore.x - trayBefore)) < 1, `${homeBefore.x - trayBefore} -> ${homeAfter.x - trayAfter}`);
    // Drag homeassistant (cabled) and its cable follows.
    await page.mouse.move(homeAfter.x + 10, homeAfter.y + 10);
    await page.mouse.down();
    await page.mouse.move(homeAfter.x + 10 + 40, homeAfter.y + 10, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    check('a moved thing\'s cable follows it', (await page.locator('.shelf-room__cable').nth(2).getAttribute('d')) !== cableBefore);
    // A second drag of a thing already placed by hand is saved too (it once compared the drag with itself).
    const homeMoved = await thing('homeassistant').locator('rect').first().boundingBox();
    check('a second drag of a placed thing stays where it was dropped', Math.abs(homeMoved.x - homeAfter.x) > 3, `${homeAfter.x} -> ${homeMoved.x}`);
    // Pointing at a thing in the front view lights its footprint in the strip and the line between.
    const pihole = await thing('pihole-02').locator('rect').first().boundingBox();
    await page.mouse.move(pihole.x + 8, pihole.y + 8);
    await page.waitForTimeout(150);
    check('pointing at a thing lights it from above too', (await page.locator('.shelf-room__thing--lit[data-plan-id]').count()) === 1 && (await page.locator('.shelf-room__guide--lit[data-guide-for]').filter({ has: page.locator('path') }).evaluateAll((gs) => gs.filter((g) => g.closest('svg') && g.getAttribute('data-guide-for')).map((g) => g.getAttribute('data-guide-for')))).includes(await thing('pihole-02').getAttribute('data-occupant-id')));
    await shot(page, 'shelf-view-linked');
    // In the strip, drag a thing back from the lip: it says how far back, and stays there.
    const plan = page.locator('[data-plan-id]', { hasText: 'pihole-02' });
    const planBox = await plan.locator('rect').first().boundingBox();
    await page.mouse.move(planBox.x + 8, planBox.y + planBox.height - 6);
    await page.mouse.down();
    await page.mouse.move(planBox.x + 8, planBox.y + planBox.height - 6 - 50, { steps: 6 });
    await shot(page, 'shelf-view-depth-drag');
    await page.mouse.up();
    await page.waitForTimeout(400);
    const planAfter = await plan.locator('rect').first().boundingBox();
    check('dragging up in the strip sets a thing further back', planAfter.y < planBox.y - 20, `${planBox.y} -> ${planAfter.y}`);
    check('the front view says how far back it is', /pihole-02[\s\S]*\d+ mm back/.test(await thing('pihole-02').textContent()), await thing('pihole-02').textContent());
    await page.mouse.move(5, 5);
    await shot(page, 'shelf-view-after');
    await page.locator('.shelf-room__tool', { hasText: 'Back' }).click();
    await page.waitForTimeout(300);
    check('Back turns the shelf round', (await room(page).textContent()).includes('BACK · 450 MM INSIDE'));
    await shot(page, 'shelf-view-back');
    // Version 3: the two ends. From the right end the shelf is 300 mm across, front on the left, and a
    // port on a thing's right side shows only there.
    await page.locator('.shelf-room__tool', { hasText: 'Right' }).click();
    await page.waitForTimeout(300);
    check('Right looks at the shelf from its right end', (await room(page).textContent()).includes('RIGHT END · 300 MM DEEP'));
    const sidePort = page.locator('[data-port-id]').filter({ has: page.locator('title', { hasText: 'mgmt' }) });
    check('a port on the right side shows from the right end', (await sidePort.count()) === 1);
    await shot(page, 'shelf-view-right');
    // Run a cable: click the free side port, turn to the front, click a free port there.
    await sidePort.click();
    await page.waitForTimeout(200);
    check('clicking a free port starts a cable from it', (await page.locator('.shelf-room__pending').count()) === 1 && (await page.locator('.shelf-room__port--pending').count()) === 1);
    await page.locator('.shelf-room__tool', { hasText: 'Front' }).click();
    await page.waitForTimeout(300);
    check('the cable being run is still waiting after turning the shelf', (await page.locator('.shelf-room__pending').count()) === 1);
    await shot(page, 'shelf-view-connecting');
    // pihole-02's only port, eth0, is free: the free port drawn inside its box.
    const pb = await thing('pihole-02').locator('rect').first().boundingBox();
    let target = null;
    for (const p of await page.locator('[data-port-id]').all()) {
      const b = await p.boundingBox();
      if (b && b.x >= pb.x && b.x + b.width <= pb.x + pb.width && !((await p.getAttribute('class')) ?? '').includes('cabled')) target = p;
    }
    check('pihole-02 has a free port from the front', target != null);
    if (target != null) await target.click();
    await page.waitForTimeout(500);
    check('clicking the other end runs the cable', (await page.locator('.shelf-room__pending').count()) === 0);
    await page.locator('.shelf-room__tool', { hasText: 'Right' }).click();
    await page.waitForTimeout(300);
    check('from the right end the side port is now cabled, tagged with its far end', ((await sidePort.getAttribute('class')) ?? '').includes('shelf-room__port--cabled') && (await room(page).textContent()).includes('to pihole-02, its front'));
    await shot(page, 'shelf-view-right-cabled');
    await page.locator('.shelf-room__tool', { hasText: 'Left' }).click();
    await page.waitForTimeout(300);
    check('Left looks at the shelf from its left end', (await room(page).textContent()).includes('LEFT END · 300 MM DEEP'));
    await shot(page, 'shelf-view-left');
    await page.locator('.shelf-room__tool', { hasText: 'Front' }).click();
    await page.waitForTimeout(300);

    // A click selects a thing: the panel shows it.
    await page.locator('.shelf-room__thing[data-occupant-id]', { hasText: 'morpheus-nas' }).click();
    await page.waitForTimeout(300);
    check('a click selects a thing on the shelf', (await page.locator('.shelf-room__thing--selected[data-occupant-id]').textContent()).includes('morpheus-nas'));
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
    await page.locator('.shelf-room__thing[data-occupant-id]', { hasText: 'padparadscha' }).dblclick();
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
