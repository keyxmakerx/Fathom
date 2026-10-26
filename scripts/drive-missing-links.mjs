// Missing links, end to end against the real compiled client (round 26 point 6, round 27 points 1-2):
// draw a cable with only one end connected and see it quiet and uncounted (Unknown: it fades out, says
// "Far end unknown", nothing in the bar); mark it Needs finishing and see the count, the slanted amber
// dashes, the circle and the swinging ? (and that reduced motion stops both); pan away and use Go from the
// list in the bar to bring the cable back into view; then plug the second end in and see the count go.
//
// Uses the shared throwaway harness (`scripts/drive-lib/harness.tsx` + `seed.ts` + `catalogue.json`,
// copied into `client/` and removed below), scene `canvas`: three catalogued devices with free ports.
//
// Usage:
//   bash scripts/build-wasm.sh   # once, if the artefact is stale
//   node scripts/drive-missing-links.mjs
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT, FATHOM_SHOTS (where the
// screenshots go; default /mnt/project-files/reviews/missing-links/). Playwright is not a repo
// dependency (ADR-0032 gate zero) — reached by absolute path, like every other `scripts/drive-*`.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// Not shared with any other `scripts/drive-*.mjs` — `grep -h "PORT = " scripts/drive-*.mjs` before picking a new one.
const PORT = 18530;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/missing-links').replace(/\/?$/, '/');
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

// Step 1: copy the shared throwaway harness into `client/`.
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
    <title>Fathom — Missing links drive preview (throwaway, not shipped)</title>
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
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/drive.html?scene=canvas`);
  await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-chassis').length === 3, null, { timeout: 15_000 });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 3; i += 1) {
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);

  const loose = page.locator('[data-testid="loose-cable"]');
  const chip = page.locator('[data-testid="missing-links-chip"]');
  const freeRj45 = (node) => node.locator('button.drawing-chassis__port:not(.drawing-chassis__port--cabled)[title*="RJ45"]');
  const fw = page.locator('.react-flow__node-chassis', { hasText: 'fw-01' });
  const sw = page.locator('.react-flow__node-chassis', { hasText: 'sw-02' });

  check('the scene has no loose end and no Missing links button to start', (await loose.count()) === 0 && (await chip.count()) === 0);

  // ---------------------------------------------------------------------
  // 1 — draw a cable with only one end connected: it starts Unknown, quiet and uncounted.
  // ---------------------------------------------------------------------
  // A port in the bottom row leaves its cable downward, out of the rack into clear canvas (a top-row port
  // leaves upward, over the other devices); the Nth free bottom-row RJ45 port of fw-01.
  const bottomRowPort = async (node, n) => {
    const all = freeRj45(node);
    const boxes = [];
    for (let i = 0; i < (await all.count()); i += 1) boxes.push({ i, box: await all.nth(i).boundingBox() });
    const lowest = Math.max(...boxes.map((b) => b.box.y));
    const row = boxes.filter((b) => Math.abs(b.box.y - lowest) < 2).sort((p, q) => p.box.x - q.box.x);
    return all.nth(row[n].i);
  };
  const port = await bottomRowPort(fw, 1);
  const portId = await port.evaluate((el) => el.getAttribute('data-port-id') ?? el.closest('[data-port-id]')?.getAttribute('data-port-id') ?? '');
  await port.click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Add a cable, far end open' }).click();
  await page.waitForTimeout(600);
  check('a cable with one end connected is drawn', (await loose.count()) === 1);
  check('it starts Unknown', (await loose.first().getAttribute('data-loose-state')) === 'unknown');
  check('it is a node on the canvas, no ordinary two-ended edge', await loose.first().evaluate((el) => el.closest('.react-flow__node-looseCable') != null && el.closest('.react-flow__edge') == null));
  check('the bar shows no Missing links button: Unknown is not counted', (await chip.count()) === 0);
  check('no dashes, no circle, no ? on an Unknown end', (await page.locator('[data-testid="loose-dashes"]').count()) === 0 && (await page.locator('[data-testid="missing-mark"]').count()) === 0);
  check('hovering it says "Far end unknown"', ((await loose.first().locator('title').textContent()) ?? '') === 'Far end unknown');
  const fade = await loose.first().evaluate((svg) => {
    const line = svg.querySelector('.drawing-loose__fade');
    const grad = svg.querySelector('linearGradient');
    return { stroke: line?.getAttribute('stroke') ?? '', stops: [...(grad?.querySelectorAll('stop') ?? [])].map((s) => s.getAttribute('stop-opacity')) };
  });
  check('the line fades out along its last stretch (a linear opacity gradient, full then nothing)', fade.stroke.startsWith('url(#') && fade.stops.join(',') === '1,1,0', JSON.stringify(fade));
  const unknownAnimates = await loose.first().evaluate((svg) => [...svg.querySelectorAll('*')].some((el) => getComputedStyle(el).animationName !== 'none'));
  check('an Unknown end has no motion', !unknownAnimates);
  await page.screenshot({ path: SHOTS + 'missing-links-01-unknown.png' });
  console.log('    wrote ' + SHOTS + 'missing-links-01-unknown.png');

  // ---------------------------------------------------------------------
  // 2 — mark it Needs finishing: counted, dashes crawl, the ? swings.
  // ---------------------------------------------------------------------
  const toggle = page.getByRole('button', { name: 'Needs finishing', exact: true });
  for (let tries = 0; tries < 3 && (await toggle.count()) === 0; tries += 1) {
    await loose.first().locator('line.nodrag').click({ force: true });
    await page.waitForTimeout(600);
    if ((await toggle.count()) === 0) {
      const dbg = await loose.first().evaluate((svg) => {
        const l = svg.querySelector('line.nodrag').getBoundingClientRect();
        const el = document.elementFromPoint(l.x + l.width / 2, l.y + l.height / 2);
        return { box: [l.x, l.y, l.width, l.height], top: el ? el.tagName + '.' + (el.getAttribute('class') ?? '') : null, panel: document.querySelector('.drawing-editor__panel')?.innerText.slice(0, 80) };
      });
      console.log('    selecting the loose end did not open its panel: ' + JSON.stringify(dbg));
      await page.screenshot({ path: SHOTS + 'debug-select.png' });
    }
  }
  check("the cable's panel offers the Needs finishing toggle, off", (await toggle.getAttribute('aria-pressed')) === 'false');
  await toggle.click();
  await page.waitForTimeout(600);
  check('the bar now shows "Missing links · 1"', (await chip.count()) === 1 && /missing links · 1/i.test(await chip.innerText()));
  check('the loose end is Needs finishing', (await loose.first().getAttribute('data-loose-state')) === 'needs-finishing');
  check('it draws slanted amber dashes', (await page.locator('[data-testid="loose-dashes"] polygon').count()) > 8);
  const look = await loose.first().evaluate((svg) => {
    const dash = svg.querySelector('[data-testid="loose-dashes"] polygon');
    const circle = svg.querySelector('circle');
    const glyph = svg.querySelector('.missing-mark__glyph');
    const swing = svg.querySelector('.missing-mark__swing');
    const dashes = svg.querySelector('.drawing-loose__dashes');
    return {
      dashFill: dash ? getComputedStyle(dash).fill : '',
      caution: getComputedStyle(document.documentElement).getPropertyValue('--caution').trim(),
      r: circle?.getAttribute('r'),
      circleStroke: circle ? getComputedStyle(circle).stroke : '',
      glyphText: glyph?.textContent,
      glyphSize: glyph ? getComputedStyle(glyph).fontSize : '',
      glyphWeight: glyph ? getComputedStyle(glyph).fontWeight : '',
      swingAnim: swing ? getComputedStyle(swing).animationName : '',
      swingDur: swing ? getComputedStyle(swing).animationDuration : '',
      dashAnim: dashes ? getComputedStyle(dashes).animationName : '',
      dashDur: dashes ? getComputedStyle(dashes).animationDuration : '',
    };
  });
  check('the circle is r=12 with a caution stroke, holding a bold ?', look.r === '12' && look.glyphText === '?' && Number(look.glyphWeight) >= 700 && look.circleStroke !== 'none', JSON.stringify(look));
  check('the ? is drawn at the one size', look.glyphSize === '15px', look.glyphSize);
  check('the ? swings every 3.2s', look.swingAnim === 'missing-mark-bell' && look.swingDur === '3.2s', look.swingAnim + ' ' + look.swingDur);
  check('the dashes crawl at about 18px a second (8px per 0.444s)', look.dashAnim.startsWith('missing-crawl') && Math.abs(parseFloat(look.dashDur) - 8 / 18) < 0.01, look.dashAnim + ' ' + look.dashDur);
  // The ? swings about its own centre: the glyph rotates, the circle does not.
  const swung = await page.evaluate(async () => {
    const swing = document.querySelector('.missing-mark__swing');
    const circle = document.querySelector('.drawing-loose__circle');
    const seen = new Set();
    const circleSeen = new Set();
    const end = performance.now() + 3400;
    while (performance.now() < end) {
      seen.add(getComputedStyle(swing).transform);
      circleSeen.add(getComputedStyle(circle).transform);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { glyphStates: seen.size, circleStates: circleSeen.size };
  });
  check('over one cycle the ? takes many angles and the circle none', swung.glyphStates > 4 && swung.circleStates === 1, JSON.stringify(swung));
  await page.screenshot({ path: SHOTS + 'missing-links-02-needs-finishing.png' });
  console.log('    wrote ' + SHOTS + 'missing-links-02-needs-finishing.png');

  // Reduced motion stops both animations.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  const still = await loose.first().evaluate((svg) => ({
    swing: getComputedStyle(svg.querySelector('.missing-mark__swing')).animationName,
    dashes: getComputedStyle(svg.querySelector('.drawing-loose__dashes')).animationName,
  }));
  check('under prefers-reduced-motion the ? and the dashes stand still', still.swing === 'none' && still.dashes === 'none', JSON.stringify(still));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(300);

  // ---------------------------------------------------------------------
  // 3 — the list, and Go.
  // ---------------------------------------------------------------------
  await chip.click();
  await page.waitForSelector('[data-testid="missing-links-list"]', { timeout: 5_000 });
  const rows = page.locator('[data-testid="missing-links-row"]');
  check('the list has one row for the cable, worded device port → (no far end)', (await rows.count()) === 1 && /fw-01 \S+ → \(no far end\)/.test(await rows.first().innerText()), await rows.first().innerText());
  check('the list says it was found from the drawing', /Found by Fathom from the drawing/.test(await page.locator('[data-testid="missing-links-list"]').innerText()));
  check('no Unknown section while there is no unknown end', (await page.locator('[data-testid="missing-links-unknown"]').count()) === 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Pan the cable out of view, then Go.
  const inView = () => loose.first().evaluate((svg) => {
    const r = svg.getBoundingClientRect();
    const pane = document.querySelector('.react-flow__pane').getBoundingClientRect();
    return r.right > pane.left && r.left < pane.right && r.bottom > pane.top && r.top < pane.bottom;
  });
  check('the cable starts in view', await inView());
  for (let i = 0; i < 3 && (await inView()); i += 1) {
    await page.mouse.move(900, 450);
    await page.mouse.down();
    await page.mouse.move(150, 450, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  check('panned away, the cable is out of view', !(await inView()));
  await chip.click();
  await page.waitForSelector('[data-testid="missing-links-list"]', { timeout: 5_000 });
  await rows.first().getByRole('button', { name: 'Go' }).click();
  await page.waitForTimeout(1200);
  check('Go brings the cable into view', await inView());
  check('Go selected the cable (its panel is open)', (await page.getByRole('button', { name: 'Needs finishing', exact: true }).getAttribute('aria-pressed')) === 'true');
  check('the list closed after Go', (await page.locator('[data-testid="missing-links-list"]').count()) === 0);
  await page.screenshot({ path: SHOTS + 'missing-links-03-go.png' });
  console.log('    wrote ' + SHOTS + 'missing-links-03-go.png');

  // ---------------------------------------------------------------------
  // 4 — an Unknown one beside it sits in the folded section and is not counted; then finish the first.
  // ---------------------------------------------------------------------
  await (await bottomRowPort(fw, 0)).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Add a cable, far end open' }).click();
  await page.waitForTimeout(600);
  check('a second loose end is Unknown and the count stays 1', (await loose.count()) === 2 && /missing links · 1/i.test(await chip.innerText()));
  await chip.click();
  await page.waitForSelector('[data-testid="missing-links-list"]', { timeout: 5_000 });
  const unknown = page.locator('[data-testid="missing-links-unknown"]');
  check('Unknown (1) is folded below the rows', (await unknown.count()) === 1 && (await unknown.locator('summary').innerText()) === 'Unknown (1)' && (await unknown.getAttribute('open')) === null);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Finish the marked cable: drag from a free port on another device onto the port holding it.
  const marked = page.locator('[data-testid="loose-cable"][data-loose-state="needs-finishing"]');
  const markedId = await marked.getAttribute('data-cable-id');
  // The marked cable sits in the port we cabled first; the drop goes on that port's own handle.
  const dragTo = fw.locator(`[data-port-id="${portId}"] .drawing-chassis__port-handle`);
  const dragFrom = freeRj45(sw).first().locator('.drawing-chassis__port-handle');
  const a = await dragFrom.boundingBox();
  const b = await dragTo.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  check('plugging a free port into it gives the cable its second end: the loose end goes', (await page.locator(`[data-testid="loose-cable"][data-cable-id="${markedId}"]`).count()) === 0);
  check('the count vanishes with it: no Missing links button', (await chip.count()) === 0);
  check('a real two-ended cable is drawn in its place', (await page.locator(`g.drawing-cable[data-cable-id="${markedId}"]`).count()) >= 1);
  check('the other, Unknown, end is still there and still quiet', (await loose.count()) === 1 && (await loose.first().getAttribute('data-loose-state')) === 'unknown');

  // Undo takes the second end back off, and the count returns.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  check('undo puts the loose end and its count back', (await chip.count()) === 1 && /missing links · 1/i.test(await chip.innerText()));

  // Every save the scene made, with the new field in it, loads through the real engine.
  const saves = await page.evaluate(() => ({ count: window.__saveCount__ ?? 0, failures: window.__saveLoadFailures__ ?? [] }));
  check('the edits were saved, and every saved payload loaded through the engine', saves.count > 0 && saves.failures.length === 0, JSON.stringify(saves));

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

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
  check('the throwaway harness files were removed', ![PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE].some((f) => existsSync(f)));
}

console.log(fails.length ? '\nFAILURES:\n  ' + fails.join('\n  ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
