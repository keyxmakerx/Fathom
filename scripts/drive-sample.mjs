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
    // Closed, Search leaves the way it came: a still copy of its sheet fades where it hung. The page keeps a note
    // of every copy as it is made, so nothing here depends on catching one in the 120ms it lasts.
    await page.evaluate(() => {
      window.__copies = [];
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement) || !node.hasAttribute('data-ghost')) continue;
            const texts = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            let words = 0;
            for (let t = texts.nextNode(); t != null; t = texts.nextNode()) if (t.data.trim() !== '') words += 1;
            const sheet = node.querySelector('.float-sheet');
            window.__copies.push({
              kind: node.classList.item(0),
              inert: node.inert,
              hidden: node.getAttribute('aria-hidden'),
              words,
              named: node.querySelectorAll('[role], [aria-label], [data-testid], [tabindex], :not(svg *)[id]').length,
              typed: node.querySelector('input')?.value ?? null,
              sheetLeaves: sheet ? getComputedStyle(sheet).animationName : null,
            });
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
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
    const copies = (await page.evaluate(() => window.__copies)).filter((c) => c.kind === 'float-scrim');
    check('closed, Search leaves one still copy of its sheet', copies.length === 1, JSON.stringify(copies));
    check('the copy cannot be pressed, read or found', copies.length === 1 && copies[0].inert && copies[0].hidden === 'true' && copies[0].words === 0 && copies[0].named === 0, JSON.stringify(copies));
    check('it shows what was typed, and its sheet goes back the way it came', copies[0]?.typed === 'switch' && copies[0]?.sheetLeaves === 'float-sheet-out', JSON.stringify(copies));
    check('the copy is gone a moment later', (await page.locator('.float-scrim').count()) === 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check('a second Esc closes the card', (await card.count()) === 0);

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
    // device shows its card, Esc puts it away, and a nudge that stays on the same part of the device does not
    // bring it back (onto another part of it, it comes back, as it did before the rule).
    {
      const hover = page.locator('[data-testid=thing-peek], [data-testid=port-peek]');
      // A spot on a device's row with one part of it, and no port, under the next 8 pixels.
      const on = await page.evaluate(() => {
        for (const row of document.querySelectorAll('.react-flow__node-chassis')) {
          const b = row.getBoundingClientRect();
          const y = b.y + b.height / 2;
          for (let x = b.x + 4; x < b.right - 12; x += 4) {
            const el = document.elementFromPoint(x, y);
            const plain = el != null && row.contains(el) && el.closest('[data-port-id]') == null;
            if (plain && [2, 4, 6, 8].every((d) => document.elementFromPoint(x + d, y) === el)) return { x, y };
          }
        }
        return null;
      });
      check('a device has a spot clear of its ports to point at', on != null);
      await page.mouse.move(on.x, on.y, { steps: 6 });
      await page.waitForTimeout(900);
      check('a pointer moved onto a device shows its hover card as before', (await hover.count()) === 1, String(await hover.count()));
      await page.keyboard.press('Escape');
      await page.mouse.move(on.x + 8, on.y, { steps: 4 });
      await page.waitForTimeout(900);
      check('Esc puts it away, and a nudge on the same part of the device does not bring it back', (await hover.count()) === 0, String(await hover.count()));
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
    // the copy would be at full strength. Last, because a press on the drawing folds the question card.
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

    check('no uncaught page errors (the Rack stop)', pageErrors.length === 0, pageErrors.join(' | '));
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
