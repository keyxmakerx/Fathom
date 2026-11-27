// Drives the sample home lab and the five first steps (r15-start): Home with no design shows the sample card and
// Getting started at 0 of 5; Open sample makes a design of its own and opens it on the canvas; a trace from the
// desktop reaches the NAS through both switches; back on Home the trace step is ticked; Hide moves the list under
// Help. Screenshots land in FATHOM_SHOTS. Usage: bash scripts/build-wasm.sh (once), then
// node scripts/drive-sample.mjs. Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copiesMade, watchCopies } from './drive-lib/copies.mjs';
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
const PORT = 5347;
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

  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.waitForTimeout(500);
    check(`[${scheme}] Home offers the sample home lab`, /Open the sample home lab/.test(await page.locator('.home-sample').innerText()));
    const steps = page.locator('.first-steps');
    check(`[${scheme}] Getting started reads 0 of 5`, /0 of 5/i.test(await steps.innerText()));
    check(`[${scheme}] five steps are listed`, (await page.locator('.first-steps__step').count()) === 5);
    await shot(page, `SN-01-home-${scheme}`);

    if (scheme === 'dark') {
      check(`no uncaught page errors (${scheme})`, pageErrors.length === 0, pageErrors.join(' | '));
      await context.close();
      continue;
    }

    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const names = await page.locator('.react-flow__node').allInnerTexts();
    const all = names.join(' ');
    for (const host of ['router-1', 'switch-1', 'switch-2', 'nas-1', 'desktop-1', 'ap-1']) {
      check(`the sample opens with ${host} on the canvas`, all.includes(host));
    }
    await shot(page, 'SN-02-sample-canvas');

    // The trace starts from a racked device; the canvas offers it on a rack's devices.
    const router = page.locator('.react-flow__node-chassis', { hasText: 'router-1' }).first();
    // dispatched on the node itself: at the sample's zoom a pointer click can land on the rack's free-space layer
    await router.dispatchEvent('contextmenu', { button: 2, clientX: 0, clientY: 0 });
    const item = page.locator('.drawing-context-menu__item', { hasText: 'Trace from here' });
    check('the router offers Trace from here', (await item.count()) === 1);
    if ((await item.count()) === 1) {
      await item.click();
      await page.waitForSelector('[data-testid=trace-panel]', { timeout: 5_000 });
      await page.locator('[data-testid=trace-to]').fill('192.168.10.50');
      await page.waitForTimeout(1200);
      const hops = await page.locator('[data-testid=trace-hop]').allInnerTexts();
      const text = hops.join(' | ').replace(/\s+/g, ' ');
      check('the trace crosses switch-1 and switch-2', /switch-1/.test(text) && /switch-2/.test(text), text.slice(0, 400));
      check('the trace ends at the desktop', /desktop-1/.test(hops.at(-1) ?? ''), hops.at(-1));
      await shot(page, 'SN-03-trace');
    }

    // Cable physics (r129): a rack dropped in a new place sets its cables swinging, and they settle.
    // Broke silently twice: once when long runs drew straight, once when a dropped rack's cables were
    // remade and forgot where they had been. Light pass only; the drag uses the Select tool.
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    const rackNode = page.locator('.react-flow__node-rack').first();
    const rb = await rackNode.boundingBox();
    const cablePaths = () => page.evaluate(() => [...document.querySelectorAll('.react-flow__edge path')].map((p) => p.getAttribute('d')).join('|'));
    if (rb != null) {
      const before = await cablePaths();
      const sx = rb.x + 6;
      const sy = rb.y + rb.height - 8;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      const whileDragging = new Set();
      // Straight down, where there is room. Fitted, the rack stands by the left edge of the drawing, and a drag
      // to the left would run off the window.
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(sx, sy + i * 12);
        await page.waitForTimeout(16);
        whileDragging.add(await cablePaths());
      }
      await page.mouse.up();
      // r129: the rack carries its devices and their cables while it is dragged, not only on the drop.
      check('the cables follow the rack while it is dragged', whileDragging.size >= 3, `${whileDragging.size} distinct frames`);
      const frames = new Set();
      const t0 = Date.now();
      while (Date.now() - t0 < 2200) {
        frames.add(await cablePaths());
        await page.waitForTimeout(40);
      }
      const settledA = await cablePaths();
      await page.waitForTimeout(400);
      check('a dropped rack moves its cables', settledA !== before);
      check('the cables swing after the rack lands', frames.size >= 6, `${frames.size} distinct frames`);
      check('the cables settle', settledA === (await cablePaths()));
      await shot(page, 'SN-03b-rack-moved');
    } else {
      check('the rack is on the canvas to drag', false);
    }

    // Leave the sample at the Rack stop, so the visit below reopens it there. A stop lands on what is selected,
    // so the rack is clicked first: with nothing selected it lands on the middle of the view, which is the wall,
    // and a view with no rack in it is not the one a reopened design returns to.
    const camera = () =>
      page.evaluate(() => {
        const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
        return { x: m.e, y: m.f, zoom: m.a };
      });
    const dropped = await rackNode.boundingBox();
    if (dropped != null) await page.mouse.click(dropped.x + 6, dropped.y + dropped.height - 8);
    await page.locator('.shell-pill__value').click();
    await page.locator('.shell-pill__stop', { hasText: 'Rack' }).click();
    await page.waitForTimeout(1200);
    const leftCamera = await camera();
    const rackAtStop = await rackNode.boundingBox();
    const paneAtStop = await page.locator('.react-flow__pane').boundingBox();
    check(
      'the Rack stop lands on the selected rack',
      rackAtStop != null && paneAtStop != null && rackAtStop.x >= paneAtStop.x && rackAtStop.y >= paneAtStop.y && rackAtStop.x + rackAtStop.width <= paneAtStop.x + paneAtStop.width && rackAtStop.y + rackAtStop.height <= paneAtStop.y + paneAtStop.height,
      JSON.stringify(rackAtStop),
    );

    await page.locator('.shell-bar__brand').first().click();
    await page.waitForSelector('.first-steps, .home__help', { timeout: 10_000 });
    await page.waitForTimeout(500);
    const after = await page.locator('.first-steps').innerText().catch(() => '');
    check('back on Home the trace step is ticked', /1 of 5/i.test(after), after.slice(0, 80));
    check('the sample is listed by name', (await page.getByText('Sample home lab').count()) >= 1);
    await shot(page, 'SN-04-home-after');

    await page.locator('.first-steps__hide').click();
    await page.waitForTimeout(300);
    check('Hide takes the list away', (await page.locator('.first-steps').count()) === 0);
    check('it lives under Help after that', (await page.locator('.home__panel').getByRole('button', { name: 'Getting started' }).count()) === 1);
    await shot(page, 'SN-05-hidden');
    await page.locator('.home__panel').getByRole('button', { name: 'Getting started' }).click();
    check('Getting started comes back from Help', (await page.locator('.first-steps').count()) === 1);

    // A design reopened where it was left: the bar's + and - still move the drawing. They once changed the
    // number and nothing else for the whole visit, because the camera waited on a zoom the bar already showed.
    await page.getByText('Sample home lab', { exact: true }).first().click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const cameraZoom = () => page.evaluate(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a);
    const leftAt = await cameraZoom();
    const reopened = await camera();
    check(
      'the sample reopens where it was left, at the Rack stop',
      Math.abs(leftAt - 1) < 0.01 && Math.abs(reopened.x - leftCamera.x) < 1 && Math.abs(reopened.y - leftCamera.y) < 1,
      `${JSON.stringify(reopened)}, left at ${JSON.stringify(leftCamera)}`,
    );
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForTimeout(900);
    const nearer = await cameraZoom();
    check('reopened, + moves the drawing and not only the number', nearer > leftAt + 0.05, `${leftAt} to ${nearer}`);
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.waitForTimeout(900);
    const back = await cameraZoom();
    check('and - moves it back', Math.abs(back - leftAt) < 0.01, `${nearer} to ${back}`);

    // Hide on the question card lasts the visit. It once came back each time a device was opened and left.
    const questionCard = page.getByTestId('ready-questions');
    check('the reopened sample offers its questions', (await questionCard.count()) === 1);
    if ((await questionCard.count()) === 1) {
      await questionCard.getByRole('button', { name: 'Hide' }).click();
      await page.locator('.react-flow__node-chassis', { hasText: 'router-1' }).first().dispatchEvent('contextmenu', { button: 2, clientX: 0, clientY: 0 });
      await page.locator('.drawing-context-menu__item', { hasText: /^Open$/ }).click();
      await page.waitForSelector('[data-testid=jot]', { timeout: 10_000 });
      await page.getByTestId('jump-back').click();
      await page.waitForSelector('[data-testid=jot]', { state: 'detached', timeout: 10_000 });
      await page.waitForTimeout(400);
      check('a hidden question card stays hidden after a device is opened and left', (await questionCard.count()) === 0);
    }

    // A hint is for a control someone pointed at. When Back leaves the tool row a tool slides under the pointer
    // at rest, and it once explained itself unasked.
    const routerBox = await page.locator('.react-flow__node-chassis', { hasText: 'router-1' }).first().boundingBox();
    if (routerBox != null) await page.mouse.click(routerBox.x + routerBox.width / 2, routerBox.y + routerBox.height / 2);
    await page.waitForTimeout(600);
    const backNow = page.getByTestId('jump-back');
    check('Back is in the tool row while the router is selected', (await backNow.count()) === 1);
    if ((await backNow.count()) === 1) {
      await backNow.click();
      await page.waitForSelector('[data-testid=jump-back]', { state: 'detached', timeout: 5_000 });
      await page.waitForTimeout(1500);
      check('a tool that slides under a pointer at rest shows no hint', (await page.getByTestId('hint').count()) === 0);
    }
    await page.getByTestId('shell-show').hover();
    await page.waitForTimeout(900);
    const hintSays = await page.getByTestId('hint').innerText().catch(() => '');
    check('pointing at Layers shows its hint', /Layers/.test(hintSays), hintSays.slice(0, 80));

    // Search over a device's card. Esc is Search's first and the card's second: it once closed the card hidden
    // behind Search and left Search open. A press on the sheet's foot once took the focus out of the box, and no
    // key answered after it.
    const card = page.getByTestId('quick-card');
    if ((await card.count()) === 0 && routerBox != null) {
      await page.mouse.click(routerBox.x + routerBox.width / 2, routerBox.y + routerBox.height / 2);
      await page.waitForTimeout(600);
    }
    check("the router's card is showing before Search opens", (await card.count()) === 1);
    // A menu from the bar over the card, opened from the keyboard. Esc is the menu's first: it once put away the
    // card behind the menu and left the menu open.
    const barMenu = page.locator('.shell-popover:not([data-ghost])');
    await page.getByRole('button', { name: 'Account menu' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    check('a menu from the bar opens over the card', (await barMenu.count()) === 1 && (await card.count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('one Esc closes the menu', (await barMenu.count()) === 0);
    check('and leaves the card behind it showing', (await card.count()) === 1);
    // Closed, Search leaves the way it came: a still copy of its sheet fades where it hung. The page keeps a note
    // of every copy as it is made, so nothing here depends on catching one in the 120ms it lasts.
    await watchCopies(page);
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette', { timeout: 5_000 });
    await page.keyboard.type('switch');
    await page.waitForTimeout(300);
    await page.locator('.palette__keys').click();
    const focusAt = await page.evaluate(() => document.activeElement?.className ?? '');
    check('a press on the foot of Search leaves the focus in its box', focusAt === 'palette__input', focusAt);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    check('one Esc closes Search', (await page.locator('.palette').count()) === 0);
    check('and leaves the card under it showing', (await card.count()) === 1);
    const copies = (await copiesMade(page)).filter((c) => c.kind === 'float-scrim');
    check('closed, Search leaves one still copy of its sheet', copies.length === 1, JSON.stringify(copies));
    check('the copy cannot be pressed, read or found', copies.length === 1 && copies[0].inert && copies[0].hidden === 'true' && copies[0].words === 0 && copies[0].named === 0, JSON.stringify(copies));
    check('it shows what was typed, and its sheet goes back the way it came', copies[0]?.typed === 'switch' && copies[0]?.boxLeaves === 'float-sheet-out', JSON.stringify(copies));
    check('the copy is gone a moment later', (await page.locator('.float-scrim').count()) === 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check('a second Esc closes the card', (await card.count()) === 0);

    // A dialog arrives as a menu does instead of cutting in: a whole page fades in, a card fades and drops into
    // place, and each rests exactly where its own rule puts it. Under reduced motion neither moves.
    const arriving = async (selector) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el == null) return null;
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const pane = document.querySelector('.shell__drawing')?.getBoundingClientRect();
        // How far its top is below the tool row, where the two share any width: under 0, the row lies over it.
        const tools = [...document.querySelectorAll('.shell-canvas-bar__group')].map((g) => g.getBoundingClientRect()).filter((g) => g.width > 0 && g.left < box.right && g.right > box.left);
        const underTools = tools.length > 0 ? Math.round(box.top - Math.max(...tools.map((g) => g.bottom))) : null;
        return { by: style.animationName, ms: style.animationDuration, opacity: style.opacity, offCentre: pane ? Math.round(box.left + box.width / 2 - (pane.left + pane.width / 2)) : null, underTools };
      }, selector);
    const openLearn = async () => {
      await page.keyboard.press('Control+k');
      await page.waitForSelector('.palette', { timeout: 5_000 });
      await page.keyboard.type('Open Learn');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForSelector('.learn-overlay', { timeout: 5_000 });
      await page.waitForTimeout(400);
    };
    const openPasteCard = async () => {
      const spot = await page.evaluate(() => {
        for (let y = 860; y > 200; y -= 20) {
          for (let x = 1340; x > 300; x -= 20) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
        }
        return null;
      });
      if (spot == null) return false;
      await page.mouse.click(spot.x, spot.y, { button: 'right' });
      await page.locator('.drawing-context-menu__item', { hasText: 'Paste config' }).click();
      await page.waitForSelector('[data-testid=paste-card]', { timeout: 5_000 });
      await page.waitForTimeout(400);
      return true;
    };
    await openLearn();
    const learnIn = await arriving('.learn-overlay');
    check('Learn fades in over the design', learnIn?.by === 'fathom-fade-in' && learnIn.ms === '0.16s' && learnIn.opacity === '1', JSON.stringify(learnIn));
    // A dialog leaves the way it came: closed, a still copy of it fades where it hung, and is gone a moment later.
    const still = (c) => c != null && c.inert && c.hidden === 'true' && c.words === 0 && c.named === 0;
    await copiesMade(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.learn-overlay:not([data-ghost])', { state: 'detached', timeout: 5_000 });
    await page.waitForTimeout(500);
    const learnOut = (await copiesMade(page)).filter((c) => c.kind === 'learn-overlay');
    check('closed, Learn fades out as it came, and nothing in its copy can be pressed, read or found', learnOut.length === 1 && learnOut[0].leaves === 'fathom-fade-out' && still(learnOut[0]), JSON.stringify(learnOut));
    check('the copy of Learn is gone a moment later', (await page.locator('.learn-overlay').count()) === 0);
    const pasted = await openPasteCard();
    const cardIn = await arriving('[data-testid=paste-card]');
    check('the paste card drops into place', pasted && cardIn?.by === 'paste-card-in' && cardIn.ms === '0.16s', JSON.stringify(cardIn));
    check('and rests in the middle of the canvas, fully drawn', cardIn != null && cardIn.opacity === '1' && Math.abs(cardIn.offCentre ?? 99) <= 1, JSON.stringify(cardIn));
    check('and opens under the tool row, not behind it', cardIn?.underTools != null && cardIn.underTools >= 0, `${cardIn?.underTools}px below it`);
    const cardAt = await page.evaluate(() => {
      const b = document.querySelector('[data-testid=paste-card]')?.getBoundingClientRect();
      return b ? { left: Math.round(b.left), top: Math.round(b.top) } : null;
    });
    await copiesMade(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=paste-card]', { state: 'detached', timeout: 5_000 });
    await page.waitForTimeout(500);
    const cardOut = (await copiesMade(page)).filter((c) => c.kind === 'paste-card');
    check('closed, the paste card goes back the way it came', cardOut.length === 1 && cardOut[0].leaves === 'paste-card-out' && still(cardOut[0]), JSON.stringify(cardOut));
    // The shared leaving motion would take away the shift that centres the card, and its copy would start half a card to the right.
    check('and its copy starts where the card hung', cardOut.length === 1 && cardAt != null && Math.abs(cardOut[0].left - cardAt.left) <= 1 && Math.abs(cardOut[0].top - cardAt.top) <= 1, JSON.stringify({ cardAt, cardOut }));
    check('the copy of the paste card is gone a moment later', (await page.locator('.paste-card').count()) === 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openLearn();
    const learnStill = await arriving('.learn-overlay');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.learn-overlay', { state: 'detached', timeout: 5_000 });
    const pastedStill = await openPasteCard();
    const cardStill = await arriving('[data-testid=paste-card]');
    await copiesMade(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=paste-card]', { state: 'detached', timeout: 5_000 });
    await page.waitForTimeout(300);
    check('and under reduced motion a closed dialog leaves no copy', (await copiesMade(page)).length === 0);
    await page.emulateMedia({ reducedMotion: null });
    check('under reduced motion neither moves', learnStill?.by === 'none' && pastedStill && cardStill?.by === 'none' && Math.abs(cardStill.offCentre ?? 99) <= 1, JSON.stringify({ learnStill, cardStill }));

    check(`no uncaught page errors (${scheme})`, pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // On a screen with room for it the sample opens whole. Its wall, ceiling and desk once stood in one column
  // three screens tall, so the whole of it fitted at 32% and the first view was the rack alone. The question
  // card sits over the top left of the drawing: the first view and Fit to view keep what they frame clear of
  // it, of the tool row and of the zoom buttons.
  {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const seen = () =>
      page.evaluate(() => {
        const box = (el) => {
          const b = el.getBoundingClientRect();
          return { x: b.x, y: b.y, right: b.right, bottom: b.bottom };
        };
        const one = (selector) => {
          const el = document.querySelector(selector);
          return el == null ? null : box(el);
        };
        return {
          zoom: new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a,
          pane: one('.react-flow__pane'),
          card: one('[data-testid=ready-questions]'),
          folded: document.querySelector('.trace-questions--folded') != null,
          tools: one('.shell-canvas-bar__group'),
          pill: one('[data-testid=shell-pill]'),
          drawn: [...document.querySelectorAll('.react-flow__node-rack, .react-flow__node-surface, .react-flow__node-tray')].map((el) => ({ name: el.textContent.trim().slice(0, 12), ...box(el) })),
        };
      });
    const under = (cover, drawn) => (cover == null ? ['(not on the page)'] : drawn.filter((d) => d.x < cover.right && d.right > cover.x && d.y < cover.bottom && d.bottom > cover.y).map((d) => d.name));
    const outside = (pane, drawn) => drawn.filter((d) => d.x < pane.x || d.y < pane.y || d.right > pane.right || d.bottom > pane.bottom).map((d) => d.name);
    const named = (drawn, start) => drawn.find((d) => d.name.startsWith(start));

    const first = await seen();
    check('the wide screen draws the rack, its tray and three surfaces', first.drawn.length === 5, first.drawn.map((d) => d.name).join(', '));
    check('on a wide screen the sample opens whole, nothing off the screen', outside(first.pane, first.drawn).length === 0, outside(first.pane, first.drawn).join(', '));
    check('at 60% or more, so its names can be read', first.zoom >= 0.6, String(first.zoom));
    check('with its question card open', first.card != null && !first.folded);
    check('nothing drawn is under the question card', under(first.card, first.drawn).length === 0, under(first.card, first.drawn).join(', '));
    check('nor under the tool row', under(first.tools, first.drawn).length === 0, under(first.tools, first.drawn).join(', '));
    const [rack, wall, ceiling, desk] = ['Rack 1', 'Outside wall', 'Hall ceiling', 'Office desk'].map((start) => named(first.drawn, start));
    check(
      'the wall stands next to the rack, with the ceiling over the desk beside it',
      rack != null && wall != null && ceiling != null && desk != null && Math.abs(wall.y - rack.y) < 1 && wall.x > rack.right && ceiling.x > wall.right && Math.abs(ceiling.x - desk.x) < 1 && Math.abs(ceiling.y - wall.y) < 1 && desk.y > ceiling.bottom && desk.bottom <= wall.bottom + 1,
      JSON.stringify({ rack, wall, ceiling, desk }),
    );
    await shot(page, 'SN-06-wide-open');

    // The whole lab is further out than the wheel goes by itself. A pinch from there starts where the drawing is:
    // it once put the drawing at the wheel's own floor in one step, whichever way the fingers moved.
    const pinch = async (deltaY) => {
      await page.mouse.move(first.pane.x + (first.pane.right - first.pane.x) / 2, first.pane.y + (first.pane.bottom - first.pane.y) / 2);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, deltaY);
      await page.keyboard.up('Control');
      await page.waitForTimeout(500);
      return (await seen()).zoom;
    };
    const pinchedOut = await pinch(20);
    check('a pinch out from the whole view leaves it where it is', Math.abs(pinchedOut - first.zoom) < 0.001, `${first.zoom} to ${pinchedOut}`);
    const pinchedIn = await pinch(-20);
    check('a pinch in from there zooms in a step, not straight to the closet stop', pinchedIn > first.zoom * 1.005 && pinchedIn < first.zoom * 1.06, `${first.zoom} to ${pinchedIn}`);
    const pinchedBack = await pinch(20);
    check('and a pinch back out returns to the whole view', Math.abs(pinchedBack - first.zoom) < 0.002, `${pinchedIn} to ${pinchedBack}`);
    check('the pinches leave the question card open', (await seen()).folded === false);

    await page.getByRole('button', { name: 'Fit to view' }).click();
    await page.waitForTimeout(900);
    const fitted = await seen();
    check('a press on Fit to view folds the question card', fitted.card != null && fitted.folded);
    check('Fit to view frames the sample whole', outside(fitted.pane, fitted.drawn).length === 0, outside(fitted.pane, fitted.drawn).join(', '));
    check('larger than it opened, the folded card taking less room', fitted.zoom > first.zoom, `${first.zoom} to ${fitted.zoom}`);
    const hidden = [...under(fitted.card, fitted.drawn), ...under(fitted.tools, fitted.drawn), ...under(fitted.pill, fitted.drawn)];
    check('with nothing under the folded card, the tool row or the zoom buttons', hidden.length === 0, hidden.join(', '));
    await shot(page, 'SN-07-wide-fit');

    // Out past the whole closet is the site (ADR-0074), drawn over the canvas. The question card is the canvas's:
    // it once stayed on top of the site's own words.
    await page.getByRole('button', { name: 'Zoom out' }).click();
    const wentUp = await page.waitForSelector('.places-map', { timeout: 5_000 }).then(() => true, () => false);
    check('from the whole closet, - goes up to the site', wentUp);
    check('the question card is not over the site', !(await page.getByTestId('ready-questions').isVisible()));
    await shot(page, 'SN-08-wide-site');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForSelector('.places-map', { state: 'detached', timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(600);
    const down = await seen();
    check('+ comes back down to the closet as it was left', (await page.locator('.places-map').count()) === 0 && Math.abs(down.zoom - fitted.zoom) < 0.001, `${fitted.zoom} to ${down.zoom}`);
    check('with its question card back', down.card != null && down.card.right > down.card.x && down.folded);

    check('no uncaught page errors (wide screen)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // A pressed question frames its path. The camera once stayed where it was, so a path that ran off the screen or
  // under the trace's own panel was a list of hops and little to look at. It now moves to the path before the
  // first hop lights and goes back when the trace closes. Each hop has a numbered mark, a cable's on the cable.
  // Found on the way, all on main: a lit cable started drawing itself again at every later hop, a cable off the
  // path stayed at full strength above the devices, and whatever slid under the resting pointer put up its
  // hover card, which then took the Esc meant for the trace.
  {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const camera = () =>
      page.evaluate(() => {
        const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
        return { zoom: m.a, x: m.e, y: m.f };
      });
    const sameView = (a, b) => a != null && b != null && Math.abs(a.zoom - b.zoom) < 0.002 && Math.abs(a.x - b.x) <= 1.5 && Math.abs(a.y - b.y) <= 1.5;
    const questions = page.getByTestId('ready-questions').locator('.trace-suggest button');
    check('the sample offers three questions', (await questions.count()) === 3, String(await questions.count()));

    // Presses question `index` with the pointer left where it was pressed, and says what the page showed: the
    // camera when the first hop lit, how many elements each lit cable was while the trace played, and the path
    // once it has played.
    const ask = async (index) => {
      const button = await questions.nth(index).boundingBox();
      const at = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
      await page.mouse.move(at.x, at.y);
      await page.evaluate(() => {
        const seen = { firstHop: null, elements: {} };
        window.__asked = seen;
        const counted = new WeakSet();
        const started = performance.now();
        const look = () => {
          if (seen.firstHop == null && document.querySelector('.trace-hop--now, .trace-hop--done') != null) {
            const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
            seen.firstHop = { zoom: m.a, x: m.e, y: m.f };
          }
          for (const edge of document.querySelectorAll('.react-flow__edge.trace-play')) {
            const line = edge.querySelector('.drawing-cable path, .drawing-bundle path');
            if (line == null || counted.has(line)) continue;
            counted.add(line);
            const id = edge.getAttribute('data-id');
            seen.elements[id] = (seen.elements[id] ?? 0) + 1;
          }
        };
        // After each frame is drawn, so a cable that is off the page only between two steps of one frame is not
        // counted as gone.
        const frame = () => {
          const after = new MessageChannel();
          after.port1.onmessage = look;
          after.port2.postMessage(0);
          if (performance.now() - started < 8000) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForSelector('[data-testid=trace-hop]', { timeout: 8_000 });
      // Played to its end: no row is waiting, lit or done any more.
      await page.waitForFunction(() => document.querySelectorAll('.trace-hop').length > 0 && document.querySelectorAll('.trace-hop--now, .trace-hop--later, .trace-hop--done').length === 0, null, { timeout: 10_000 });
      // Longer than a rack's hover card waits before it shows.
      await page.waitForTimeout(1200);
      return page.evaluate(({ x, y }) => {
        const box = (el) => {
          const b = el.getBoundingClientRect();
          return { x: b.x, y: b.y, right: b.right, bottom: b.bottom };
        };
        const one = (selector) => {
          const el = document.querySelector(selector);
          return el == null ? null : box(el);
        };
        const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
        const whole = '.drawing-cable:not(.drawing-cable--stub) > path[d], .drawing-bundle:not(.drawing-bundle--stub) > path[d]';
        return {
          camera: { zoom: m.a, x: m.e, y: m.f },
          asked: window.__asked,
          pane: one('.react-flow__pane'),
          tools: one('.shell-canvas-bar__group'),
          pill: one('[data-testid=shell-pill]'),
          map: one('.canvas-minimap'),
          hops: [...document.querySelectorAll('[data-testid=trace-hop]')].filter((h) => h.getAttribute('data-kind') !== 'stop').length,
          marks: [...document.querySelectorAll('[data-testid=trace-dot]')].map((el) => ({ name: el.textContent.trim(), shown: getComputedStyle(el).display !== 'none', ...box(el) })),
          racks: [...document.querySelectorAll('.react-flow__node-rack')].map(box),
          cables: [...document.querySelectorAll('.react-flow__edge.trace-path')].map((edge) => {
            const line = edge.querySelector(whole);
            const p = line == null ? null : line.getPointAtLength(line.getTotalLength() / 2).matrixTransform(line.getScreenCTM());
            return { name: edge.getAttribute('data-id'), middle: p == null ? null : { x: p.x, y: p.y }, ...box(edge) };
          }),
          // A cable off the path that is drawn once more above the devices.
          fadedOnTop: [...document.querySelectorAll('.react-flow__edge.trace-faded[data-id^="cable:"]')].map((e) => e.getAttribute('data-id')).filter((id) => [...document.querySelectorAll('[data-testid=cable-top] use')].some((u) => u.getAttribute('href') === `#cable-v-${id}`)),
          fadedCables: document.querySelectorAll('.react-flow__edge.trace-faded[data-id^="cable:"]').length,
          underPointer: document.elementFromPoint(x, y)?.closest('.react-flow__node')?.className.match(/react-flow__node-(\w+)/)?.[1] ?? null,
          hoverCards: document.querySelectorAll('[data-testid=thing-peek], [data-testid=port-peek]').length,
          panel: document.querySelectorAll('[data-testid=trace-panel]').length,
        };
      }, at);
    };
    const inside = (pane, things) => things.filter((d) => d.x < pane.x || d.y < pane.y || d.right > pane.right || d.bottom > pane.bottom).map((d) => d.name);
    const under = (cover, things) => (cover == null ? [] : things.filter((d) => d.x < cover.right && d.right > cover.x && d.y < cover.bottom && d.bottom > cover.y).map((d) => d.name));
    const middleOf = (d) => ({ x: (d.x + d.right) / 2, y: (d.y + d.bottom) / 2 });
    const inRack = (racks, p) => racks.some((r) => p.x >= r.x && p.x <= r.right && p.y >= r.y && p.y <= r.bottom);

    const opened = await camera();
    // The first question stays inside one corner of the lab (a camera to the NAS); the third crosses all of it.
    for (const [index, name] of [[0, 'the first question'], [2, 'the third question']]) {
      const seen = await ask(index);
      const path = [...seen.marks, ...seen.cables];
      check(`${name}: the camera moves to its path`, !sameView(seen.camera, opened), JSON.stringify(seen.camera));
      check(`${name}: and is there before the first hop lights`, sameView(seen.asked.firstHop, seen.camera), `${JSON.stringify(seen.asked.firstHop)} then ${JSON.stringify(seen.camera)}`);
      const numbered = new Set(seen.marks.flatMap((mk) => mk.name.split('·')));
      check(`${name}: every hop has its mark`, seen.hops > 0 && numbered.size === seen.hops && seen.marks.every((mk) => mk.shown), `${seen.hops} hops, marks ${seen.marks.map((mk) => mk.name).join(' ')}`);
      check(`${name}: the path and its marks are whole on the screen`, path.length > 0 && inside(seen.pane, path).length === 0, inside(seen.pane, path).join(', '));
      const covered = [...under(seen.tools, path), ...under(seen.pill, path), ...under(seen.map, path)];
      check(`${name}: with nothing of it under the tool row, the zoom buttons or the small map`, covered.length === 0, covered.join(', '));
      // A cable that leaves its rack carries its mark on the middle of its line.
      const runs = seen.cables.filter((c) => c.middle != null && !inRack(seen.racks, c.middle));
      const adrift = runs.filter((c) => !seen.marks.some((mk) => Math.hypot(middleOf(mk).x - c.middle.x, middleOf(mk).y - c.middle.y) < 4));
      check(`${name}: a cable's mark is on the cable`, runs.length > 0 && adrift.length === 0, `${runs.length} cables out of a rack, off theirs: ${adrift.map((c) => c.name).join(', ')}`);
      const drawnAgain = Object.entries(seen.asked.elements).filter(([, count]) => count > 1);
      check(`${name}: a lit cable draws itself once`, Object.keys(seen.asked.elements).length > 0 && drawnAgain.length === 0, JSON.stringify(seen.asked.elements));
      check(`${name}: a cable off the path is not drawn again at full strength`, seen.fadedCables > 0 && seen.fadedOnTop.length === 0, `${seen.fadedCables} faded, on top: ${seen.fadedOnTop.join(', ')}`);
      if (index === 2) {
        check('the rack has come to rest under the pointer', seen.underPointer === 'rack', String(seen.underPointer));
        check('and shows no hover card for it', seen.hoverCards === 0, String(seen.hoverCards));
        await shot(page, 'SN-10-question-across');
      } else {
        await shot(page, 'SN-09-question-framed');
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(900);
      check(`${name}: one Esc closes the trace`, (await page.getByTestId('trace-panel').count()) === 0);
      check(`${name}: and the camera goes back to where the question was asked`, sameView(await camera(), opened), `${JSON.stringify(opened)} then ${JSON.stringify(await camera())}`);
      check(`${name}: with the question card back`, await page.getByTestId('ready-questions').isVisible());
    }

    // The rule that keeps a card from a pointer at rest leaves the ordinary pause alone: a pointer moved onto a
    // device shows its card, and Esc puts it away until the pointer has left the device. A nudge does not bring it
    // back, and neither does a move onto another part of the device, which once brought it straight back.
    {
      const hover = page.locator('[data-testid=thing-peek], [data-testid=port-peek]');
      // A spot on a device's row with one part of it, and no port, under the next 8 pixels; a spot on another
      // part of the same device; and a spot on the empty canvas.
      const spots = await page.evaluate(() => {
        const empty = () => {
          for (let y = 860; y > 200; y -= 20) {
            for (let x = 1340; x > 300; x -= 20) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
          }
          return null;
        };
        for (const row of document.querySelectorAll('.react-flow__node-chassis')) {
          const b = row.getBoundingClientRect();
          const y = b.y + b.height / 2;
          const plain = (x) => {
            const el = document.elementFromPoint(x, y);
            return el != null && row.contains(el) && el.closest('[data-port-id]') == null ? el : null;
          };
          for (let x = b.x + 4; x < b.right - 12; x += 4) {
            const el = plain(x);
            if (el == null || ![2, 4, 6, 8].every((d) => document.elementFromPoint(x + d, y) === el)) continue;
            for (let far = x + 12; far < b.right - 2; far += 2) {
              const part = plain(far);
              if (part != null && part !== el) return { on: { x, y }, other: { x: far, y }, off: empty() };
            }
          }
        }
        return null;
      });
      check('a device has two parts clear of its ports to point at', spots != null && spots.off != null);
      const { on, other, off } = spots;
      await page.mouse.move(on.x, on.y, { steps: 6 });
      await page.waitForTimeout(900);
      check('a pointer moved onto a device shows its hover card as before', (await hover.count()) === 1, String(await hover.count()));
      await page.keyboard.press('Escape');
      await page.mouse.move(on.x + 8, on.y, { steps: 4 });
      await page.waitForTimeout(900);
      check('Esc puts it away, and a nudge on the same part of the device does not bring it back', (await hover.count()) === 0, String(await hover.count()));
      await page.mouse.move(other.x, other.y, { steps: 6 });
      await page.waitForTimeout(900);
      check('nor does a move onto another part of the same device', (await hover.count()) === 0, String(await hover.count()));
      await page.mouse.move(off.x, off.y, { steps: 6 });
      await page.waitForTimeout(300);
      await page.mouse.move(on.x, on.y, { steps: 6 });
      await page.waitForTimeout(900);
      check('pointed at again from somewhere else, it shows', (await hover.count()) === 1, String(await hover.count()));
      await page.keyboard.press('Escape');
      await page.mouse.move(off.x, off.y, { steps: 6 });
      await page.waitForTimeout(300);
    }

    // A camera the person has moved since is theirs: closing the trace leaves it alone.
    await ask(0);
    const pane = await page.locator('.react-flow__pane').boundingBox();
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 30);
    await page.keyboard.up('Control');
    await page.waitForTimeout(500);
    const moved = await camera();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    check('a camera moved during the trace stays where it was put when the trace closes', (await page.getByTestId('trace-panel').count()) === 0 && sameView(await camera(), moved) && !sameView(moved, opened), `${JSON.stringify(moved)} then ${JSON.stringify(await camera())}`);

    // A selected cable dims the others, and a dimmed cable is not drawn a second time above the devices, where
    // the copy would be at full strength. After the questions, because a press on the drawing folds their card.
    {
      // A spot on a cable's line outside the racks, with the cable itself the top thing there.
      const picked = await page.evaluate(() => {
        const racks = [...document.querySelectorAll('.react-flow__node-rack')].map((r) => r.getBoundingClientRect());
        for (const edge of document.querySelectorAll('.react-flow__edge[data-id^="cable:"]')) {
          const line = edge.querySelector('.drawing-cable:not(.drawing-cable--stub) > path[d]');
          if (line == null) continue;
          for (const along of [0.5, 0.4, 0.6, 0.3, 0.7]) {
            const p = line.getPointAtLength(line.getTotalLength() * along).matrixTransform(line.getScreenCTM());
            if (racks.some((r) => p.x >= r.x && p.x <= r.right && p.y >= r.y && p.y <= r.bottom)) continue;
            if (edge.contains(document.elementFromPoint(p.x, p.y))) return { x: p.x, y: p.y };
          }
        }
        return null;
      });
      check('a cable runs outside the racks, to press', picked != null);
      await page.mouse.click(picked.x, picked.y);
      await page.waitForSelector('[data-testid=cable-top-lit]', { state: 'attached', timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(300);
      const dim = await page.evaluate(() => {
        const drawn = [...document.querySelectorAll('.react-flow__edge[data-id^="cable:"] .drawing-cable')];
        const dimmed = drawn.filter((g) => Number(getComputedStyle(g).opacity) < 1).map((g) => g.getAttribute('data-cable-id'));
        const copies = new Set([...document.querySelectorAll('[data-testid=cable-top] use')].map((u) => u.getAttribute('href')));
        return { cables: drawn.length, dimmed: dimmed.length, onTop: dimmed.filter((id) => copies.has(`#cable-v-${id}`)), picked: document.querySelectorAll('[data-testid=cable-top-lit]').length };
      });
      check('a selected cable dims the others', dim.dimmed > 0 && dim.dimmed === dim.cables - 1 && dim.picked === 1, JSON.stringify(dim));
      check('and a dimmed cable is not drawn again at full strength', dim.onTop.length === 0, dim.onTop.join(', '));
    }

    // With Details open on a device, its More list is in the page, folded away under the ⋯. That is not an open
    // menu: one Esc puts a hover card away and nothing else. Counted as one, the same Esc went on to close Details.
    {
      const hover = page.locator('[data-testid=thing-peek], [data-testid=port-peek]');
      const named = () => page.evaluate(() => document.querySelector('.dev-panel__name')?.textContent?.trim() ?? null);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const row = await page.locator('.react-flow__node-chassis', { hasText: 'switch-1' }).first().boundingBox();
      await page.mouse.click(row.x + 30, row.y + row.height / 2);
      await page.getByTestId('quick-card').getByRole('button', { name: 'Details' }).click();
      await page.waitForSelector('.dev-panel__name', { timeout: 5_000 });
      await page.waitForTimeout(600);
      const folded = await page.evaluate(() => {
        const list = document.querySelector('details.dev-more [role="menu"]');
        return list != null && list.closest('details').open === false;
      });
      check("Details is open on the switch, its More list folded away in the page", (await named()) === 'switch-1' && folded, `${await named()} ${folded}`);
      // A spot on the router's row clear of its ports.
      const on = await page.evaluate(() => {
        const router = [...document.querySelectorAll('.react-flow__node-chassis')].find((el) => el.textContent.includes('router-1'));
        const b = router.getBoundingClientRect();
        const y = b.y + b.height / 2;
        for (let x = b.x + 4; x < b.right - 12; x += 4) {
          const el = document.elementFromPoint(x, y);
          if (el != null && router.contains(el) && el.closest('[data-port-id]') == null) return { x, y };
        }
        return null;
      });
      await page.mouse.move(on.x, on.y + 40, { steps: 3 });
      await page.mouse.move(on.x, on.y, { steps: 6 });
      await page.waitForTimeout(900);
      check('with Details open, a pointer moved onto another device shows its hover card', (await hover.count()) === 1, String(await hover.count()));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      check('one Esc puts the hover card away', (await hover.count()) === 0, String(await hover.count()));
      check('and leaves Details open on the switch', (await named()) === 'switch-1', String(await named()));

      // The More list is a menu like any other. Esc shuts it and leaves the panel, and a press elsewhere shuts it:
      // Esc once folded the panel around it, and a press elsewhere left it open over the next device picked.
      const more = () => page.evaluate(() => document.querySelector('details.dev-more')?.open ?? null);
      const openMore = async () => {
        await page.locator('details.dev-more > summary').click();
        await page.waitForTimeout(300);
      };
      await page.mouse.move(on.x, on.y + 200, { steps: 3 });
      await openMore();
      const wasOpen = await more();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      check('with the More list open, one Esc shuts the list', wasOpen === true && (await more()) === false, `${wasOpen} then ${await more()}`);
      check('and leaves Details open on the switch, the focus back on the ⋯', (await named()) === 'switch-1' && (await page.evaluate(() => document.activeElement?.classList.contains('dev-more__button') ?? false)), String(await named()));
      // For the keyboard the More list is a menu as the bar's are. Opened from the keyboard it starts on its first
      // row, the arrow keys go through its rows, and it shuts when Tab leaves it. It once did none of the three.
      const moreRows = await page.evaluate(() => [...document.querySelectorAll('details.dev-more [role="menu"] button')].map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));
      const onRow = () =>
        page.evaluate(() => {
          const a = document.activeElement;
          return a != null && a.tagName === 'BUTTON' && a.closest('details.dev-more') != null ? (a.getAttribute('aria-label') ?? a.textContent ?? '').trim() : null;
        });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      check('opened from the keyboard, the More list starts on its first row', (await more()) === true && moreRows.length > 2 && (await onRow()) === moreRows[0], `on ${await onRow()}; ${moreRows.length} rows`);
      const stepped = [];
      for (const key of ['ArrowDown', 'ArrowUp', 'ArrowUp', 'Home']) {
        await page.keyboard.press(key);
        stepped.push(await onRow());
      }
      check('Down and Up step through its rows and go round at the ends, and Home goes to the first', JSON.stringify(stepped) === JSON.stringify([moreRows[1], moreRows[0], moreRows[moreRows.length - 1], moreRows[0]]), stepped.join(', '));
      await page.keyboard.press('End');
      await page.keyboard.press('Tab');
      await page.waitForTimeout(400);
      check('Tab past its last row leaves the list and shuts it, and Details stays on the switch', (await more()) === false && (await onRow()) == null && (await named()) === 'switch-1', `open ${await more()}; on ${await onRow()}; ${await named()}`);
      await openMore();
      await page.mouse.click(on.x, on.y);
      await page.waitForTimeout(700);
      check('a press on another device shuts the list, and Details follows the press', (await more()) === false && (await named()) === 'router-1', `${await more()} ${await named()}`);
    }

    check('no uncaught page errors (a pressed question)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // From the sample's first view the Rack stop lands on the rack. The middle of the whole lab is a wall, and the
  // stop zoomed about the middle: the rack ended in the corner, partly under the tool row.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const seen = () =>
      page.evaluate(() => {
        const box = (selector) => {
          const b = document.querySelector(selector)?.getBoundingClientRect();
          return b == null ? null : { x: b.x, y: b.y, right: b.right, bottom: b.bottom };
        };
        const pane = box('.react-flow__pane');
        const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
        return {
          camera: { zoom: m.a, x: m.e, y: m.f },
          pane,
          rack: box('.react-flow__node-rack'),
          tools: box('.shell-canvas-bar__group'),
          pill: box('[data-testid=shell-pill]'),
          middleOn: document.elementFromPoint((pane.x + pane.right) / 2, (pane.y + pane.bottom) / 2)?.closest('.react-flow__node')?.className.match(/react-flow__node-(\w+)/)?.[1] ?? 'paper',
        };
      });
    const pick = async (name) => {
      await page.locator('.shell-pill__value').click();
      await page.locator('.shell-pill__stop', { hasText: name }).click();
      await page.waitForTimeout(1000);
    };
    const first = await seen();
    check('the sample opens on the whole lab, the middle of the view not on the rack', first.camera.zoom < 0.9 && first.middleOn !== 'rack' && first.middleOn !== 'chassis', `${first.camera.zoom} on ${first.middleOn}`);
    // Under 77.5% a number kept readable is taller than the row it numbers, and each ran into the next: only the
    // even units are numbered there.
    const numbers = () =>
      page.evaluate(() => {
        const zoom = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a;
        const all = [...document.querySelectorAll('.react-flow__node-rack .drawing-rack__u-number')].map((el) => ({ u: Number(el.textContent), shown: getComputedStyle(el).visibility !== 'hidden', y: el.getBoundingClientRect().y, font: parseFloat(getComputedStyle(el).fontSize) * zoom }));
        const shown = all.filter((n) => n.shown);
        return { shown: shown.map((n) => n.u), hidden: all.filter((n) => !n.shown).map((n) => n.u), font: shown[0]?.font ?? 0, pitch: shown.length > 1 ? Math.abs(shown[1].y - shown[0].y) : 0 };
      });
    const far = await numbers();
    check('zoomed out, only the even units of the rack are numbered', far.shown.length > 1 && far.shown.every((u) => u % 2 === 0) && far.hidden.length > 0 && far.hidden.every((u) => u % 2 === 1), `shown ${far.shown.join(' ')}`);
    check('and a number is no taller than the room it has', far.font >= 9 && far.font < far.pitch * 0.75, `${far.font.toFixed(1)}px in ${far.pitch.toFixed(1)}px`);
    await pick('Rack');
    const at = await seen();
    const near = await numbers();
    check('at the Rack stop every unit is numbered again', near.hidden.length === 0 && near.shown.length === far.shown.length + far.hidden.length && near.font < near.pitch * 0.75, `shown ${near.shown.join(' ')}, ${near.font.toFixed(1)}px in ${near.pitch.toFixed(1)}px`);
    check('the Rack stop goes to 100%', Math.abs(at.camera.zoom - 1) < 0.002, String(at.camera.zoom));
    check('and lands on the rack, whole on the screen', at.rack.x >= at.pane.x && at.rack.right <= at.pane.right && at.rack.y >= at.pane.y && at.rack.bottom <= at.pane.bottom, JSON.stringify(at.rack));
    check('in the middle of the width', Math.abs((at.rack.x + at.rack.right) / 2 - (at.pane.x + at.pane.right) / 2) <= 2, `${(at.rack.x + at.rack.right) / 2} in ${at.pane.x} to ${at.pane.right}`);
    check('clear of the tool row and the zoom buttons', at.rack.y >= at.tools.bottom && at.rack.bottom <= at.pill.y, `${at.rack.y} to ${at.rack.bottom}, row to ${at.tools.bottom}, buttons from ${at.pill.y}`);
    await shot(page, 'SN-11-rack-stop');
    // From the Rack stop itself nothing moves: only going in from the closet looks for a rack.
    await pick('Rack');
    const again = await seen();
    check('picked again from there, the camera stays', Math.abs(again.camera.x - at.camera.x) <= 1 && Math.abs(again.camera.y - at.camera.y) <= 1 && Math.abs(again.camera.zoom - at.camera.zoom) < 0.002, JSON.stringify(again.camera));
    // A design left looking at a wall or a desk, with no rack in view, reopens there. The remembered view was once
    // kept only if it showed a rack; any other reopened on the opening view.
    const inView = () =>
      page.evaluate(() => {
        const pane = document.querySelector('.react-flow__pane').getBoundingClientRect();
        const count = (selector) => [...document.querySelectorAll(selector)].filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.x < pane.right && b.right > pane.x && b.y < pane.bottom && b.bottom > pane.y; }).length;
        return { racks: count('.react-flow__node-rack'), surfaces: count('.react-flow__node-surface') };
      });
    await page.mouse.move(at.pane.x + 300, at.pane.y + 300);
    for (let turns = 0; turns < 8 && (await inView()).racks > 0; turns += 1) {
      await page.mouse.wheel(500, 200);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(800);
    const left = await seen();
    const leftOn = await inView();
    check('the wheel takes the view off the rack, onto a wall or a desk', leftOn.racks === 0 && leftOn.surfaces > 0, JSON.stringify(leftOn));
    await page.locator('.shell-bar__brand').first().click();
    await page.waitForSelector('.first-steps, .home__help', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.getByText('Sample home lab', { exact: true }).first().click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const back = await seen();
    check('the sample reopens there, where it was left', Math.abs(back.camera.x - left.camera.x) <= 1.5 && Math.abs(back.camera.y - left.camera.y) <= 1.5 && Math.abs(back.camera.zoom - left.camera.zoom) < 0.002, `${JSON.stringify(left.camera)} then ${JSON.stringify(back.camera)}`);
    await shot(page, 'SN-12-reopened-on-a-desk');

    // A dragged rack keeps its devices and shelves on it. They are nodes of their own, and each one slid to its
    // new place over 150 ms: a step behind the rack in any drag, and about 50px behind it at the pane's edge,
    // where the view pans by itself. Its cables stay on the page too: each device was measured again at every
    // step, and until it had been its cables were not drawn, so they blinked while the rack moved and were gone
    // while it was held at the edge. Back to the rack first, the long way round, since the view is on a desk.
    await pick('Closet');
    await pick('Rack');
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    const grip = await seen();
    const carried = () => page.evaluate(() => ({ ...window.__carried }));
    await page.evaluate(() => {
      const rack = document.querySelector('.react-flow__node-rack');
      const frame = rack.getBoundingClientRect();
      const inRack = [...document.querySelectorAll('.react-flow__node-chassis, .react-flow__node-shelf')].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.x >= frame.x && b.right <= frame.right && b.y >= frame.y && b.bottom <= frame.bottom;
      });
      const gaps = () => {
        const at = rack.getBoundingClientRect();
        return inRack.flatMap((el) => { const b = el.getBoundingClientRect(); return [b.x - at.x, b.y - at.y]; });
      };
      const held = gaps();
      const cables = () => document.querySelectorAll('.react-flow__edge[data-id^="cable:"]').length;
      const tags = () => document.querySelectorAll('.drawing-stub__tag').length;
      window.__carried = { things: inRack.length, frames: 0, worst: 0, cables: cables(), fewest: cables(), tags: tags(), mostTags: tags() };
      const tick = () => {
        const now = gaps();
        window.__carried.frames += 1;
        window.__carried.worst = Math.max(window.__carried.worst, ...now.map((gap, i) => Math.abs(gap - held[i])));
        window.__carried.fewest = Math.min(window.__carried.fewest, cables());
        window.__carried.mostTags = Math.max(window.__carried.mostTags, tags());
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Where the rack stands on the paper, whatever the camera does.
    const place = () =>
      page.evaluate(() => {
        const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
        const r = document.querySelector('.react-flow__node-rack').getBoundingClientRect();
        return `${Math.round((r.x - m.e) / m.a)},${Math.round((r.y - m.f) / m.a)}`;
      });
    const home = await place();
    const gx = grip.rack.x + 6;
    const gy = grip.rack.bottom - 8;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    for (let i = 1; i <= 20; i += 1) {
      await page.mouse.move(gx + i * 10, gy + i);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(300);
    const across = await seen();
    const plain = await carried();
    check('a rack is dragged across the paper, with devices and a shelf in it', across.rack.x - grip.rack.x > 150 && plain.things >= 3 && plain.frames >= 10, `${across.rack.x - grip.rack.x}px, ${plain.things} things, ${plain.frames} frames`);
    check('and they stay on the rack all the way, none a step behind', plain.worst <= 1.5, `${plain.worst.toFixed(1)}px off at the worst`);
    check('with every cable on the page in every frame', plain.cables > 2 && plain.fewest === plain.cables, `${plain.fewest} of ${plain.cables} at the fewest`);
    // To the pane's left edge and held there: the view pans by itself and the rack goes with the pointer.
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(gx + 200 + ((grip.pane.x + 12 - gx - 200) * i) / 10, gy + 20);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(700);
    const edge = await seen();
    const panned = await carried();
    await shot(page, 'SN-13-rack-held-at-the-edge');
    check('held at the edge of the pane, the view pans by itself', edge.camera.x - across.camera.x > 100, `${across.camera.x} then ${edge.camera.x}`);
    check('and the devices are still on the rack, not trailing it', panned.worst <= 1.5 && panned.frames > plain.frames + 10, `${panned.worst.toFixed(1)}px off at the worst, ${panned.frames} frames`);
    check('its cables are still drawn, whole', panned.fewest === panned.cables && panned.mostTags === panned.tags, `${panned.fewest} of ${panned.cables} at the fewest, ${panned.mostTags} cut to a stub`);
    await page.mouse.up();
    await page.waitForTimeout(800);

    // Undo after several drags goes back one drag at a time, and Redo comes forward again. An undo was itself
    // the next thing Undo took, so the rack went back and forth between its last two places and never further.
    const dragBy = async (dx, dy) => {
      const from = (await seen()).rack;
      const [x, y] = [from.x + 6, from.bottom - 8];
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      await page.waitForTimeout(700);
      return place();
    };
    const press = async (keys) => {
      await page.keyboard.press(keys);
      await page.waitForTimeout(700);
      return place();
    };
    const dropped = [await place(), await dragBy(120, 40), await dragBy(90, -60)];
    check('the rack is dragged to three places', new Set([home, ...dropped]).size === 4, [home, ...dropped].join(' | '));
    const undone = [await press('Control+z'), await press('Control+z'), await press('Control+z')];
    check('Undo three times goes back through them to where it stood', undone.join(' | ') === [dropped[1], dropped[0], home].join(' | '), `${undone.join(' | ')}, wanted ${[dropped[1], dropped[0], home].join(' | ')}`);
    const redone = [await press('Control+Shift+z'), await press('Control+Shift+z')];
    check('and Redo twice comes forward through them', redone.join(' | ') === [dropped[0], dropped[1]].join(' | '), `${redone.join(' | ')}, wanted ${[dropped[0], dropped[1]].join(' | ')}`);

    // A rack over a wall is whole. A rack moved by hand can stand anywhere, and the walls do not move for it. On
    // one level with the rack's frame, the wall hid the frame and left the rack's devices in front of the wall.
    // Back where it stood beside the wall first, and the whole lab in view.
    await press('Control+z');
    await press('Control+z');
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await page.waitForTimeout(1200);
    const onTop = () =>
      page.evaluate(() => {
        const rack = document.querySelector('.react-flow__node-rack');
        const wall = [...document.querySelectorAll('.react-flow__node-surface')].find((n) => n.textContent.includes('Outside wall'));
        const frame = rack.querySelector('.drawing-rack__frame').getBoundingClientRect();
        const w = wall.getBoundingClientRect();
        const seen = { rack: 0, held: 0, wall: 0 };
        for (let x = Math.max(frame.x, w.x) + 3; x < Math.min(frame.right, w.right) - 3; x += 5) {
          for (let y = Math.max(frame.y, w.y) + 3; y < Math.min(frame.bottom, w.bottom) - 3; y += 5) {
            const top = document.elementFromPoint(x, y);
            if (top == null) continue;
            if (rack.contains(top)) seen.rack += 1;
            else if (top.closest('.react-flow__node-chassis, .react-flow__node-shelf') != null) seen.held += 1;
            else if (wall.contains(top)) seen.wall += 1;
          }
        }
        return { ...seen, shared: Math.round(Math.min(frame.right, w.right) - Math.max(frame.x, w.x)) };
      });
    const before = await place();
    const boxes = await page.evaluate(() => {
      const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, bottom: b.bottom }; };
      return { rack: box(document.querySelector('.react-flow__node-rack')), wall: box([...document.querySelectorAll('.react-flow__node-surface')].find((n) => n.textContent.includes('Outside wall'))) };
    });
    await dragBy(boxes.wall.x - boxes.rack.x - boxes.rack.width / 2, 20);
    const over = await onTop();
    await shot(page, 'SN-14-rack-let-go-on-a-wall');
    check('a rack let go half over a wall stands there', over.shared > 20 && (await place()) !== before, `${over.shared}px of its frame over the wall`);
    check('whole: its frame and what it holds in front of the wall, none of the wall in front of it', over.wall === 0 && over.rack > 0 && over.held > 0, JSON.stringify(over));
    await press('Control+z');
    check('and Undo takes it back off the wall', (await place()) === before, `${await place()}, wanted ${before}`);

    check('no uncaught page errors (the Rack stop)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // Enter on what the keyboard is on selects it, as a press on it does, and Details shows it: a device, a cable, a
  // wall, a shelf and the rack. Space is left alone: on the drawing it is held to pan. A band of several cables
  // selects nothing. What is read out for each says the key, in place of React Flow's own words. Each says its own
  // name first (`thingSays.ts`): React Flow gave a device, a rack, a shelf and a wall no name, called a cable "Edge
  // from" and two ids, and called each a "node" or an "edge".
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    // What each thing that takes the keyboard gives a screen reader: its name, its kind, and whether Enter is offered.
    const stopsSay = (within) =>
      page.evaluate(
        (within) =>
          [...document.querySelectorAll(`${within} .react-flow__node[tabindex="0"], ${within} .react-flow__edge[tabindex="0"]`)].map((el) => ({
            name: el.getAttribute('aria-label') ?? '',
            as: el.getAttribute('aria-roledescription') ?? '',
            enter: el.getAttribute('aria-describedby') != null,
          })),
        within,
      );
    const unnamed = (stops) => stops.filter((s) => s.name.trim() === '' || /Edge from|[0-9A-HJKMNP-TV-Z]{26}/.test(s.name) || /^(node|edge)?$/.test(s.as));
    const stops = await stopsSay('.shell__drawing');
    const names = stops.map((s) => s.name);
    check('everything on the drawing that takes the keyboard has a name and a kind of its own, and none is an id', stops.length > 0 && unnamed(stops).length === 0, `${stops.length} stops; wrong: ${JSON.stringify(unnamed(stops).slice(0, 2))}`);
    for (const want of [
      'router-1, router, Rack 1 U10',
      'Rack 1, 12U, 3U used',
      'Shelf, Rack 1 U6, holds nas-1, server-1 and pi-1',
      'Outside wall, holds camera-1 and camera-2',
      'Office run, switch-1 port 7 to switch-2 port 1',
      'router-1 port 9 to ISP modem, outside this room',
      '2 cables, router-1 to switch-1',
    ])
      check(`one says "${want}"`, names.includes(want), names.filter((n) => n.startsWith(want.slice(0, 5))).join(' | '));
    check('and the browser gives the device that name', (await page.getByRole('group', { name: 'router-1, router, Rack 1 U10', exact: true }).count()) === 1);
    const noEnter = stops.filter((s) => !s.enter).map((s) => s.as).sort();
    check('Enter is offered on all but the band of cables', JSON.stringify(noEnter) === JSON.stringify(['cables']), JSON.stringify(noEnter));
    // The row's label and the cables that leave the room open nothing and say nothing a rack does not: Tab passes them (r159).
    const kinds = stops.map((s) => s.as);
    check('the row label and the cables that leave the room take no Tab stop', !kinds.includes('row') && !kinds.includes('cables that leave this room'), JSON.stringify([...new Set(kinds)]));
    // What Details shows of the selection, its words run together; null with nothing selected.
    const details = () =>
      page.evaluate(() => {
        const panel = document.querySelector('.drawing-editor__title')?.closest('.shell-editor');
        return panel == null ? null : (panel.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      });
    const enterOn = async (selector) => {
      for (let i = 0; i < 3 && (await details()) != null; i += 1) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
      }
      await page.locator(selector).first().focus();
      const said = await page.evaluate(() => document.getElementById(document.activeElement?.getAttribute('aria-describedby') ?? '')?.textContent ?? null);
      await page.keyboard.press('Space');
      await page.waitForTimeout(300);
      const afterSpace = await details();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      return { said, afterSpace, afterEnter: await details(), card: await page.getByTestId('quick-card').count() };
    };
    for (const [what, selector, shows] of [
      ['a device', '.react-flow__node-chassis', /router-1/],
      ['a cable', '.react-flow__edge-cable', /end a .+ end b /i],
      ['a wall', '.react-flow__node-surface', /^Outside wall/],
      ['a shelf', '.react-flow__node-shelf', /^Shelf/],
      ['the rack', '.react-flow__node-rack', /^Rack 1/],
    ]) {
      const got = await enterOn(selector);
      check(
        `Enter on ${what} the keyboard is on selects it and opens Details on it; Space does not, and the words read out say the key`,
        got.afterSpace == null && shows.test(got.afterEnter ?? '') && got.card === 0 && got.said === 'Press Enter to select it.',
        JSON.stringify(got).slice(0, 200),
      );
    }
    const band = await enterOn('.react-flow__edge-bundle');
    check('Enter on a band of several cables selects nothing, and nothing read out says it would', band.afterSpace == null && band.afterEnter == null && band.said == null, JSON.stringify(band));

    // The Diagram look: a box is its device and a line its cable. Escape lets go of a selection there as it does
    // on the Canvas, and as the shortcuts sheet says: it once did nothing in this look.
    await page.keyboard.press('Escape');
    await page.locator('.shell-bar').getByText('Diagram', { exact: true }).first().click();
    await page.waitForSelector('.drawing--diagram .react-flow__node', { timeout: 10_000 });
    await page.waitForTimeout(1200);
    const inDiagram = await stopsSay('.drawing--diagram');
    check('in the Diagram look every box and line has a name and a kind of its own', inDiagram.length > 0 && unnamed(inDiagram).length === 0, `${inDiagram.length} stops; wrong: ${JSON.stringify(unnamed(inDiagram).slice(0, 2))}`);
    check('a box says its device and where it is, a line its two ends', inDiagram.some((s) => s.name === 'router-1, router, Rack 1' && s.as === 'device') && inDiagram.some((s) => s.name === 'Office run, switch-1 port 7 to switch-2 port 1' && s.as === 'cable'), inDiagram.slice(0, 3).map((s) => s.name).join(' | '));
    const boxSays = ((await page.locator('.drawing--diagram .react-flow__node').first().innerText()) ?? '').replace(/\s+/g, ' ').trim();
    const box = await enterOn('.drawing--diagram .react-flow__node');
    const boxName = (box.afterEnter ?? '').match(/[a-z]+-\d+/i)?.[0] ?? '';
    check('in the Diagram look, Enter on a box selects its device', box.afterSpace == null && boxName !== '' && boxSays.includes(boxName), `the box: ${boxSays.slice(0, 40)}; Details: ${(box.afterEnter ?? '').slice(0, 60)}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const onBox = await page.evaluate(() => document.activeElement?.classList.contains('react-flow__node') ?? false);
    check('Escape there clears the selection, and the keyboard stays on the box', (await details()) == null && onBox, `Details: ${((await details()) ?? 'nothing').slice(0, 40)}; on the box: ${onBox}`);
    const line = await enterOn('.drawing--diagram .react-flow__edge');
    check('and Enter on a line selects its cable; Space does not', line.afterSpace == null && /end a .+ end b /i.test(line.afterEnter ?? ''), `after Space: ${(line.afterSpace ?? 'nothing').slice(0, 40)}; after Enter: ${(line.afterEnter ?? '').slice(0, 60)}`);

    check('no uncaught page errors (Enter on what the keyboard is on)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // The ports of a thing on a wall say what they are: each button's tip, and its name for a screen reader, are a
  // rack port's words. The label alone once named it ("1"), and it had no tip. The tip follows the picture: as the
  // sample opens the ports are too small to be drawn, and a tip there would speak for nothing on the screen. Not
  // drawn, they are out of reach as well: they once took a Tab stop each, and a press where one was selected it
  // and took the camera to the Faceplate stop.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const portsOf = (selector) =>
      page.evaluate(
        (sel) =>
          [...document.querySelectorAll(sel)].map((b) => ({
            tip: b.getAttribute('title'),
            name: b.querySelector('svg[role="img"]')?.getAttribute('aria-label') ?? null,
            cabled: [...b.classList].some((c) => c.endsWith('__port--cabled')),
          })),
        selector,
      );
    const wrongOf = (ports) => ports.filter((p) => p.tip == null || p.name !== p.tip || !/^Port \S.* · \S+ · (cabled|free)$/.test(p.tip) || !p.tip.endsWith(p.cabled ? ' · cabled' : ' · free'));
    const rowShown = () => page.evaluate(() => Number(getComputedStyle(document.querySelector('.drawing-surface__port-row')).opacity));
    const asItOpens = await portsOf('button.drawing-surface__port');
    check(
      'as the sample opens a wall port is not drawn: it has its name, and no tip',
      (await rowShown()) === 0 && asItOpens.length > 0 && asItOpens.every((p) => p.tip == null && /^Port \S.* · \S+ · (cabled|free)$/.test(p.name ?? '')),
      `${asItOpens.length} ports; the first: tip ${asItOpens[0]?.tip}, name ${asItOpens[0]?.name}`,
    );
    // How many wall ports the keyboard can be put on, and how many are the top thing at their own middle.
    const reach = () =>
      page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button.drawing-surface__port')];
        const takes = buttons.filter((b) => {
          b.focus();
          const took = document.activeElement === b;
          b.blur();
          return took;
        }).length;
        const onTop = buttons.filter((b) => {
          const r = b.getBoundingClientRect();
          return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button.drawing-surface__port') === b;
        }).length;
        return { ports: buttons.length, takes, onTop };
      });
    const outOfReach = await reach();
    check('not drawn, no wall port takes the keyboard or a press', outOfReach.ports > 0 && outOfReach.takes === 0 && outOfReach.onTop === 0, JSON.stringify(outOfReach));
    // A press where a port of the desk's switch is, with nothing drawn there, is a press on the switch.
    const spot = await page.evaluate(() => {
      const box = [...document.querySelectorAll('.drawing-surface__fixture')].find((f) => (f.textContent ?? '').includes('switch-2'));
      for (const b of box?.querySelectorAll('button.drawing-surface__port') ?? []) {
        const r = b.getBoundingClientRect();
        const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        const top = document.elementFromPoint(at.x, at.y);
        if (top != null && box.contains(top)) return at;
      }
      return null;
    });
    const zoomOf = () => page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? '');
    const zoomAsItOpens = await zoomOf();
    if (spot != null) await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(900);
    const pressedCard = (await page.getByTestId('quick-card').textContent().catch(() => '')) ?? '';
    check(
      'a press where an undrawn port is selects the device it is on, and the camera stays',
      spot != null && pressedCard.includes('switch-2') && !pressedCard.startsWith('Port') && (await zoomOf()) === zoomAsItOpens,
      `card: ${pressedCard.slice(0, 40)}; zoom ${zoomAsItOpens} to ${await zoomOf()}`,
    );
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.locator('.shell-pill__value').click();
    await page.locator('.shell-pill__stop', { hasText: 'Faceplate' }).click();
    await page.waitForTimeout(1200);
    check('at the Faceplate stop the ports of a thing on a wall are drawn', (await rowShown()) === 1);
    const inReach = await reach();
    check('drawn, every wall port takes the keyboard again', inReach.ports > 0 && inReach.takes === inReach.ports, JSON.stringify(inReach));
    const onWalls = await portsOf('button.drawing-surface__port');
    const wrongOnWalls = wrongOf(onWalls);
    check(
      'every port of a thing on a wall has a tip, and a name the same, that say the port, its connector and cabled or free',
      onWalls.length > 0 && wrongOnWalls.length === 0,
      `${onWalls.length} ports, ${onWalls.filter((p) => p.cabled).length} cabled; the first: ${onWalls[0]?.tip}; wrong: ${JSON.stringify(wrongOnWalls.slice(0, 3))}`,
    );
    const first = onWalls[0]?.tip ?? '';
    check('and the browser gives a button that name', first !== '' && (await page.getByRole('button', { name: first, exact: true }).count()) > 0, first);
    check('no uncaught page errors (the ports on a wall)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // A device on a wall, a desk or a ceiling answers as one in a rack does. A press on it gets its card: it once got
  // none, since the wall kept the press to itself. Selected, it has the four corner ticks: it once had no mark. A
  // pick in Search brings it into view: the camera once went to the Faceplate stop about the middle of the view,
  // which left the device off the screen, and one on a shelf the same.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const card = page.getByTestId('quick-card');
    const zoomOf = () => page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? '');
    const onWall = (name) => page.locator('.drawing-surface__fixture', { hasText: name }).first();
    const marked = (name) => onWall(name).evaluate((el) => el.classList.contains('drawing-surface__fixture--selected') && getComputedStyle(el.parentElement, '::after').content !== 'none');
    const zoomAsItOpens = await zoomOf();
    const cam = await onWall('camera-1').boundingBox();
    await page.mouse.click(cam.x + cam.width / 2, cam.y + 6);
    await page.waitForTimeout(700);
    const says = (await card.textContent().catch(() => '')) ?? '';
    check('a press on a device on a wall shows its card', (await card.count()) === 1 && says.includes('camera-1'), says.slice(0, 80));
    check("the card says where it is and how many of its ports are cabled, as a rack device's does", /Where\s*Outside wall/.test(says) && /Ports\s*1 of 1 cabled/.test(says), says);
    check('the card offers the double-click that opens it, as a rack device\'s does', /Double-click to open inside/.test(says), says);
    check('the device is marked as the selected one', await marked('camera-1'));
    check('and the camera stays where it was', (await zoomOf()) === zoomAsItOpens, `${zoomAsItOpens} to ${await zoomOf()}`);
    const ap = await onWall('ap-1').boundingBox();
    await page.mouse.click(ap.x + ap.width / 2, ap.y + 6);
    await page.waitForTimeout(700);
    const next = (await card.textContent().catch(() => '')) ?? '';
    check('a press on another moves the card and the mark to it', (await card.count()) === 1 && next.includes('ap-1') && (await marked('ap-1')) && !(await marked('camera-1')), next.slice(0, 60));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check('Esc twice puts the card away and clears the mark', (await card.count()) === 0 && !(await marked('ap-1')));

    // Where a device is after a pick in Search: its middle inside the drawing, with nothing over it.
    const whereIs = (name) =>
      page.evaluate((name) => {
        const el = [...document.querySelectorAll('.shell__drawing [data-device-chassis]')].find((n) => (n.textContent ?? '').includes(name));
        const pane = document.querySelector('.shell__drawing .react-flow')?.getBoundingClientRect();
        if (el == null || pane == null) return null;
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        const top = document.elementFromPoint(x, y);
        return { inView: x > pane.left && x < pane.right && y > pane.top && y < pane.bottom, onTop: top != null && el.contains(top), at: [Math.round(x), Math.round(y)] };
      }, name);
    const pick = async (name) => {
      await page.keyboard.press('Control+k');
      await page.waitForSelector('.palette input', { timeout: 5_000 });
      await page.keyboard.type(name);
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2600);
    };
    await pick('switch-2');
    const desk = await whereIs('switch-2');
    check('a pick in Search brings a device on a desk into view, at the Faceplate stop', desk != null && desk.inView && desk.onTop && (await zoomOf()) === '2', `${JSON.stringify(desk)} at zoom ${await zoomOf()}`);
    check('and marks it', await marked('switch-2'));
    await shot(page, 'SN-15-search-brings-a-desk-device-into-view');
    await pick('camera-2');
    const wall = await whereIs('camera-2');
    check('one on a wall the same, from wherever the camera was left', wall != null && wall.inView && wall.onTop && (await marked('camera-2')), JSON.stringify(wall));
    await pick('nas-1');
    const shelf = await whereIs('nas-1');
    check('and one on a shelf', shelf != null && shelf.inView && shelf.onTop, JSON.stringify(shelf));
    check('no uncaught page errors (a device on a wall)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // A port answers when it is drawn, and only then, and a device opens on a double-click wherever it sits. As the
  // sample opens a rack device's ports are too small to be drawn, yet each took the pointer: a press on a switch
  // was a port's as often as the switch's, and a drag from one drew a cable out of a port nobody could see. Drawn,
  // a pressed port got no card, since the port kept its press to itself. A shelf and a device on it got none
  // either; a press on the device took the camera to the Faceplate stop, and the second press of a double-click
  // then missed it. A double-click on a device on a wall doubled the zoom.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const card = page.getByTestId('quick-card');
    const says = async () => ((await card.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    const zoomOf = () => page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? '');
    const opened = () => page.locator('[data-testid=jot]').count();
    const putAway = async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    };
    // A person's double-click: two presses some way apart, not the instant pair dblclick() sends.
    const doublePress = async (at) => {
      await page.mouse.move(at.x, at.y);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await page.waitForTimeout(220);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await page.waitForTimeout(1400);
    };
    const middleOf = (selector, name) =>
      page.evaluate(
        ({ selector, name }) => {
          const el = [...document.querySelectorAll(selector)].find((n) => (n.textContent ?? '').trim().startsWith(name));
          if (el == null) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        },
        { selector, name },
      );
    const zoomAsItOpens = await zoomOf();

    // Far out, where the ports of the big switch lie.
    const far = await page.evaluate(() => {
      const plate = [...document.querySelectorAll('.react-flow__node-chassis')].find((n) => (n.textContent ?? '').includes('switch-1'));
      const ports = [...(plate?.querySelectorAll('[data-port-id]') ?? [])];
      const middle = (p) => {
        const r = p.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      };
      const onTop = ports.filter((p) => {
        const at = middle(p);
        const top = document.elementFromPoint(at.x, at.y);
        return top != null && p.contains(top);
      }).length;
      const free = ports.find((p) => p.querySelector('.react-flow__handle.connectionindicator') != null);
      const layer = plate?.querySelector('.drawing-chassis__ports');
      return { ports: ports.length, onTop, layer: layer != null ? getComputedStyle(layer).visibility : null, at: free != null ? middle(free) : null };
    });
    check('as the sample opens no port of a rack device is drawn, and none takes the pointer', far.ports > 0 && far.onTop === 0 && far.layer === 'hidden', JSON.stringify(far));
    if (far.at != null) {
      await page.mouse.click(far.at.x, far.at.y);
      await page.waitForTimeout(800);
      const pressed = await says();
      check(
        'a press where one lies is a press on the device, and the camera stays',
        pressed.includes('switch-1') && !pressed.startsWith('Port') && (await zoomOf()) === zoomAsItOpens,
        `card: ${pressed.slice(0, 40)}; zoom ${zoomAsItOpens} to ${await zoomOf()}`,
      );
      await putAway();
      await page.mouse.move(far.at.x, far.at.y);
      await page.mouse.down();
      await page.mouse.move(far.at.x, far.at.y + 10, { steps: 3 });
      await page.mouse.move(far.at.x, far.at.y + 40, { steps: 6 });
      const drawing = await page.locator('.react-flow__connection').count();
      await page.mouse.move(far.at.x, far.at.y, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(700);
      check('and a drag from there draws no cable', drawing === 0, String(drawing));
      await putAway();
    } else {
      check('the big switch has a free port to press on', false);
    }

    // The shelf and a device on it, as the sample opens.
    const shelfName = await middleOf('.drawing-shelf__label', 'Shelf');
    if (shelfName != null) await page.mouse.click(shelfName.x, shelfName.y);
    await page.waitForTimeout(800);
    const shelfSays = await says();
    check('a press on a shelf shows its card: where it is and what is on it', shelfSays.startsWith('Shelf') && /Where\s*Rack 1/.test(shelfSays) && /On it\s*nas-1/.test(shelfSays), shelfSays.slice(0, 90));
    await putAway();
    const chips = '.drawing-shelf__compact-occupant, .drawing-shelf__occupant';
    const nas = await middleOf(chips, 'nas-1');
    if (nas != null) await page.mouse.click(nas.x, nas.y);
    await page.waitForTimeout(900);
    const nasSays = await says();
    check('a press on a device on the shelf shows its card', nasSays.includes('nas-1') && /Where\s*Rack 1 · Shelf/.test(nasSays) && /Double-click to open inside/.test(nasSays), nasSays.slice(0, 110));
    check('and the camera stays where it was', (await zoomOf()) === zoomAsItOpens, `${zoomAsItOpens} to ${await zoomOf()}`);
    const clear = await page.evaluate(() => {
      const shelf = document.querySelector('.react-flow__node-shelf')?.getBoundingClientRect();
      const c = document.querySelector('[data-testid="quick-card"]')?.getBoundingClientRect();
      return shelf != null && c != null ? { shelf: [Math.round(shelf.left), Math.round(shelf.right)], card: [Math.round(c.left), Math.round(c.right)] } : null;
    });
    check('the card hangs off the end of the shelf, clear of the things beside the one pressed', clear != null && (clear.card[0] >= clear.shelf[1] || clear.card[1] <= clear.shelf[0]), JSON.stringify(clear));
    await putAway();
    const nasAgain = await middleOf(chips, 'nas-1');
    if (nasAgain != null) await doublePress(nasAgain);
    check('a double-click opens the device on the shelf', (await opened()) === 1 && (await card.count()) === 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    check('and Esc comes back to the room as it was left', (await opened()) === 0 && (await zoomOf()) === zoomAsItOpens, `${zoomAsItOpens} to ${await zoomOf()}`);
    await putAway();

    // A device on a wall.
    const cam = await middleOf('.drawing-surface__fixture', 'camera-1');
    if (cam != null) await doublePress(cam);
    check('a double-click opens a device on a wall', (await opened()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    check('and leaves the zoom of the room alone', (await opened()) === 0 && (await zoomOf()) === zoomAsItOpens, `${zoomAsItOpens} to ${await zoomOf()}`);
    await putAway();

    // Close in, where the ports are drawn. A pick in Search opens Details, and the panel then answers a press in
    // place of the card: fold it first.
    const closeIn = async (name) => {
      await page.keyboard.press('Control+k');
      await page.waitForSelector('.palette input', { timeout: 5_000 });
      await page.keyboard.type(name);
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2600);
      const tab = page.getByTestId('dock-details');
      if ((await tab.getAttribute('aria-expanded')) === 'true') await tab.click();
      await page.waitForTimeout(700);
    };
    // The card of a pressed port: what it says, where it hangs and where its dotted line starts.
    const pressPort = async (name) => {
      const at = await page.evaluate((name) => {
        const device = [...document.querySelectorAll('.react-flow__node-chassis, .drawing-surface__fixture')].find((n) => (n.textContent ?? '').includes(name));
        const port = device?.querySelector('button[data-port-id][class*="__port--cabled"]');
        if (device == null || port == null) return null;
        const d = device.getBoundingClientRect();
        const p = port.getBoundingClientRect();
        // A wall is drawn behind the cables, so a cable takes a press where its line lies over a port: press the
        // port clear of it.
        const spots = [[0.5, 0.5], [0.75, 0.75], [0.25, 0.75], [0.75, 0.25], [0.25, 0.25]].map(([fx, fy]) => ({ x: p.x + p.width * fx, y: p.y + p.height * fy }));
        const clear = spots.find((spot) => port.contains(document.elementFromPoint(spot.x, spot.y)));
        return clear != null ? { ...clear, port: [p.left, p.right], device: [d.left, d.right], tip: port.getAttribute('title') } : null;
      }, name);
      if (at == null) return null;
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(900);
      const hung = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="quick-card"]')?.getBoundingClientRect();
        const dot = document.querySelector('.quick-card__dot');
        return c != null && dot != null ? { card: [c.left, c.right], dot: Number(dot.getAttribute('cx')) } : null;
      });
      return { ...at, says: await says(), hung };
    };
    const clearOf = (p) => p?.hung != null && (p.hung.card[0] >= p.device[1] || p.hung.card[1] <= p.device[0]);
    const fromPort = (p) => p?.hung != null && p.hung.dot >= p.port[0] - 1 && p.hung.dot <= p.port[1] + 1;
    await closeIn('switch-1');
    const inRack = await pressPort('switch-1');
    check("close in, a press on a rack port shows the port's card: where it goes, its VLAN and its cable", inRack != null && inRack.says.startsWith('Port') && /To\s*\S/.test(inRack.says) && /VLAN/.test(inRack.says) && /Cable/.test(inRack.says), `${inRack?.tip}: ${inRack?.says.slice(0, 80)}`);
    check('the card hangs off the end of the device, clear of the ports beside the one pressed', clearOf(inRack), JSON.stringify(inRack?.hung ?? null) + JSON.stringify(inRack?.device ?? null));
    check('and its dotted line starts at the port', fromPort(inRack), JSON.stringify(inRack?.hung ?? null) + JSON.stringify(inRack?.port ?? null));
    check('the camera stays at the Faceplate stop', (await zoomOf()) === '2', await zoomOf());
    await shot(page, 'SN-16-a-pressed-port-has-its-card');
    await putAway();
    await closeIn('switch-2');
    const onDesk = await pressPort('switch-2');
    check("a press on a port of a thing on a desk, clear of its cable, shows the port's card the same", onDesk != null && onDesk.says.startsWith('Port') && /To\s*\S/.test(onDesk.says) && clearOf(onDesk) && fromPort(onDesk), `${onDesk?.tip}: ${onDesk?.says.slice(0, 60)} ${JSON.stringify(onDesk?.hung ?? null)}`);
    await putAway();
    check('no uncaught page errors (ports, a shelf and a double-click)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // The arrow keys go through the rows of an open menu, as Tab does. From the button that opened it Down goes in at
  // the top and Up at the bottom; in the rows they step and go round, and Home and End go to the ends. A row's own
  // key still works, a field keeps its arrows, and Escape closes the menu with the keyboard back on its button.
  // A menu opened from the keyboard starts on its first row, and one opened with a press leaves the keyboard on
  // its button. Tab out of a menu closes it. A greyed row is reached, so the reason written in it is read.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const menu = page.locator('.shell-popover[role=menu]:not([data-ghost])');
    // What the keyboard is on: its test id, or its words.
    const on = () =>
      page.evaluate(() => {
        const a = document.activeElement;
        return a == null || a === document.body ? 'nothing' : (a.getAttribute('data-testid') ?? (a.textContent ?? '').trim().slice(0, 24));
      });
    const openFromKeys = async (testId) => {
      await page.getByTestId(testId).focus();
      await page.keyboard.press('Enter');
      await menu.waitFor({ timeout: 5_000 });
      return menu.evaluate((m) => [...m.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled)')].map((b) => b.getAttribute('data-testid') ?? (b.textContent ?? '').trim().slice(0, 24)));
    };
    const pressAll = async (keys) => {
      const went = [];
      for (const key of keys) {
        await page.keyboard.press(key);
        went.push(await on());
      }
      return went;
    };

    const layers = await openFromKeys('shell-show');
    const last = layers.length - 1;
    const opened = await on();
    check('a menu opened from the keyboard starts with the keyboard on its first row', layers.length > 2 && opened === layers[0], `on ${opened}; ${layers.length} rows`);
    const went = await pressAll(['ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'End', 'Home']);
    const wanted = [layers[1], layers[0], layers[last], layers[0], layers[last], layers[0]];
    check(
      'in the open Layers menu Down and Up step through the rows and go round at the ends, and End and Home go to the last and the first',
      JSON.stringify(went) === JSON.stringify(wanted),
      `went ${went.join(', ')}`,
    );
    const ticked = () => page.evaluate(() => document.activeElement?.getAttribute('aria-checked') ?? null);
    const tickBefore = await ticked();
    await page.keyboard.press('Space');
    const tickAfter = await ticked();
    const stillOpen = (await menu.count()) === 1 && (await on()) === layers[0];
    await page.keyboard.press('Space');
    check('Space on the row the keyboard is on still ticks it, and the menu stays open with the keyboard on the row', tickBefore != null && tickAfter != null && tickAfter !== tickBefore && stillOpen && (await ticked()) === tickBefore, `${tickBefore} to ${tickAfter}, open: ${stillOpen}`);
    await page.keyboard.press('ArrowUp');
    const fromLast = await on();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Escape closes the menu and puts the keyboard back on its button', fromLast === layers[last] && (await menu.count()) === 0 && (await on()) === 'shell-show', `${fromLast}; menus ${await menu.count()}; on ${await on()}`);

    // Tab out of an open menu closes it: it once stayed open over the page. Back to the button is not out.
    await openFromKeys('shell-show');
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(300);
    check('Shift and Tab from the first row goes back to the button, and the menu stays open', (await on()) === 'shell-show' && (await menu.count()) === 1, `on ${await on()}; menus ${await menu.count()}`);
    await page.keyboard.press('ArrowUp');
    const atLast = await on();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);
    const leftFor = await on();
    check('Tab past the last row leaves the menu and closes it', atLast === layers[last] && leftFor !== 'shell-show' && !layers.includes(leftFor) && (await menu.count()) === 0, `from ${atLast} to ${leftFor}; menus ${await menu.count()}`);

    // A greyed row takes the keyboard, so its reason is read; Enter on it does nothing and the menu stays.
    const doing = await openFromKeys('shell-doing');
    const greyed = await menu.evaluate((m) => [...m.querySelectorAll('[aria-disabled="true"]')].map((b) => b.getAttribute('data-testid')));
    const through = await pressAll(doing.map(() => 'ArrowDown'));
    check('the arrow keys reach a greyed row', greyed.length > 0 && greyed.every((row) => through.includes(row)), `greyed: ${greyed.join(', ')}; went ${through.join(', ')}`);
    if (greyed.length > 0) await page.getByTestId(greyed[0]).focus();
    const greyName = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    check('Enter on it does nothing: the menu stays open with the keyboard on the row', (await menu.count()) === 1 && (await on()) === greyed[0], `menus ${await menu.count()}; on ${await on()}`);
    check('the browser gives it as a menu item that is off, named by its words and its reason apart', /\S, \S/.test(greyName) && (await page.getByRole('menuitem', { name: greyName, exact: true, disabled: true }).count()) === 1, greyName);
    // A greyed row is faded, and its focus ring would fade with it: with the keyboard on it the row is drawn whole.
    const drawn = await menu.evaluate((m) => [...m.querySelectorAll('[aria-disabled="true"]')].map((b) => ({ on: b === document.activeElement, opacity: getComputedStyle(b).opacity })));
    check('with the keyboard on it a greyed row is drawn whole, and a greyed row without it is faded', drawn.some((d) => d.on) && drawn.every((d) => d.opacity === (d.on ? '1' : '0.45')), JSON.stringify(drawn));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Look sets some of its choices side by side: Right and Left step as Down and Up do. On the button that opened
    // the menu they are not the menu's, nor are Home and End: only Down and Up go in. Opened with a press, the
    // menu leaves the keyboard on its button.
    await page.getByTestId('shell-look').click();
    await menu.waitFor({ timeout: 5_000 });
    const look = await menu.evaluate((m) => [...m.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled)')].map((b) => b.getAttribute('data-testid') ?? (b.textContent ?? '').trim().slice(0, 24)));
    check('a menu opened with a press leaves the keyboard on its button', (await on()) === 'shell-look', await on());
    const stayed = await pressAll(['ArrowRight', 'ArrowLeft', 'Home', 'End']);
    const sideways = await pressAll(['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowLeft']);
    check(
      'on the button that opened a menu only Down and Up go in; in the rows Right and Left step as Down and Up do',
      look.length > 3 && stayed.every((at) => at === 'shell-look') && JSON.stringify(sideways) === JSON.stringify([look[look.length - 1], look[0], look[1], look[2], look[1]]),
      `on the button: ${stayed.join(', ')}; then ${sideways.join(', ')}`,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // A field in a menu keeps its arrow keys. With nothing saved the Views menu's first row is its field, so the
    // menu opens in it, and there the arrows move in the words.
    await openFromKeys('shell-views');
    const inField = await page.evaluate(() => document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text');
    await page.keyboard.type('ab');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('c');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    const typed = await page.evaluate(() => (document.activeElement instanceof HTMLInputElement ? document.activeElement.value : null));
    check('a field in a menu keeps its arrow keys: the menu opens in it, and there Left moves in the words', inField && typed === 'acb', `in the field: ${inField}; typed: ${typed}`);
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');

    check('no uncaught page errors (the arrow keys in a menu)', pageErrors.length === 0, pageErrors.join(' | '));
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
