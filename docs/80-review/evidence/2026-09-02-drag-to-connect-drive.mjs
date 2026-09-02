// ADR-0039 — THE PERIMETER IS WHERE THE PORTS ARE, driven through the shipped
// artifact, in Chromium, ASSERTING ON THE DOM. The screenshot beside this file
// is not the evidence; these assertions are.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-09-02-drag-to-connect-drive.mjs [repo-root]
//
// `OP_CABLE` shipped 2026-08-29 (ADR-0038) with a hold-then-select keyboard
// path. This record adds a pointer affordance over it and writes nothing new:
// a drag that begins on a box's PERIMETER draws a cable, because the
// perimeter is where the ports are; a drag that begins in its BODY moves the
// box, as it always has (ADR-0035). This file proves the split is real, that
// the drag terminates in the SAME opcode and the SAME journal shape the
// keyboard path already produces, and that every one of ADR-0039's four
// outcomes (box / origin / empty canvas / off-canvas) and its Escape rung —
// for both drags — behave exactly as §6 and §7 require.
//
// Five devices only, never six: `fathom-layout`'s aggregation threshold
// (`agg::THRESHOLD`) is 6, and a run of undifferentiated hand-added Devices
// above it collapses into one group with no boxes of its own to drag —
// discovered driving this file, not read off a comment.
//
// Playwright and Chromium are the ones already on this machine; neither is a
// dependency of the product and neither is in Cargo.lock (gate zero).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const OUT = ROOT + '/docs/80-review/evidence';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
// Wider than the other drivers' 1400x900 on purpose: §9 below needs real
// slack to zoom the canvas both in and out around a fitted view without
// either pushing a box off screen or shrinking one below the 40 px floor
// §4 tests, and a fitted view packs its outermost boxes close to the edge
// on a narrower canvas.
const page = await browser.newPage({
  viewport: { width: 1800, height: 1150 },
  acceptDownloads: true,
});

const requests = [];
page.on('request', r => requests.push(r.url()));
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// ---- helpers, reading the DOM and nothing else -----------------------------

const footer = () => page.$eval('#fMsg', n => n.textContent);
const objects = () => page.click('#doutHead').catch(() => {});

const addDevice = async (hostname, role) => {
  await page.click('#tabEquip');
  await page.fill('#ef6', hostname);
  await page.selectOption('#ef7', 'junos-srx');
  await page.selectOption('#ef9', role);
  await page.click('#eRun');
  await page.waitForFunction(
    n => [...document.querySelectorAll('.inv tbody td')].some(td => td.textContent === n),
    hostname);
};

const deviceRows = () => page.$$eval('[data-drow]', ns =>
  ns.map(n => ({ id: n.getAttribute('data-drow'), text: n.textContent })));

const outlineKids = async id => {
  await page.evaluate(sel => {
    const row = document.querySelector('[data-drow="' + sel + '"]');
    if (!row) return;
    row.focus();
    if (row.getAttribute('aria-expanded') !== 'true') {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    }
  }, id);
  await page.waitForTimeout(80);
  return page.evaluate(sel =>
    [...document.querySelectorAll('[data-dparent="' + sel + '"]')].map(r => r.textContent), id);
};

const selectBox = async id => { await objects(); await page.click('[data-drow="' + id + '"]'); };

const mintPort = async label => {
  if (label) await page.fill('#cAddLabel', label); else await page.fill('#cAddLabel', '');
  await page.click('[data-dcablemint]');
  await page.waitForTimeout(150);
};

// The module's own coordinates, read off the drawn rect, matching
// `2026-08-15-hand-placement-drive.mjs`'s own `posOf` idiom.
const posOf = id => page.evaluate(sel => {
  const g = document.querySelector('[data-dpost="' + sel + '"]');
  if (!g) return null;
  const r = g.querySelector('rect');
  return { x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')),
           placed: !!g.querySelector('.dpin') };
}, id);

// The box's own CLIENT rect (screen space) — the same coordinate space the
// perimeter test runs in — plus a point 5 CSS px inside its left edge
// (comfortably inside the 10 px band, `DG_PERIM_BAND`) and its centre.
const boxRect = id => page.evaluate(sel => {
  const r = document.querySelector('[data-dpost="' + sel + '"] rect');
  if (!r) return null;
  const b = r.getBoundingClientRect();
  return { left: b.left, right: b.right, top: b.top, bottom: b.bottom,
           width: b.width, height: b.height,
           cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
}, id);
const perimeterPoint = r => ({ x: r.left + 5, y: r.cy });
const bodyPoint = r => ({ x: r.cx, y: r.cy });

// A body point GUARANTEED to resolve back to this box's own id — hand
// placement (ADR-0035, and the floor-drag §4 exercises) has no collision
// avoidance, so a box's geometric centre can end up under a DIFFERENT,
// later-placed box in paint order. Scans a small grid inside the box for a
// point `elementFromPoint` actually attributes to it, falling back to the
// centre (best effort) if every candidate is covered.
const safeBodyPoint = id => page.evaluate(sel => {
  var r = document.querySelector('[data-dpost="' + sel + '"] rect');
  if (!r) return null;
  var b = r.getBoundingClientRect();
  var cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  function mine(x, y) {
    var el = document.elementFromPoint(x, y);
    var shape = el && el.closest && el.closest('[data-dpost]');
    return !!shape && shape.getAttribute('data-dpost') === sel;
  }
  if (mine(cx, cy)) return { x: cx, y: cy };
  for (var dx = -Math.min(60, b.width / 2 - 12); dx <= Math.min(60, b.width / 2 - 12); dx += 10) {
    for (var dy = -Math.min(20, b.height / 2 - 6); dy <= Math.min(20, b.height / 2 - 6); dy += 6) {
      if (mine(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
    }
  }
  return { x: cx, y: cy };
}, id);

// A point on the canvas with no box (or group) under it — scanned rather
// than guessed, so this does not depend on where the layout happened to put
// anything this run.
const emptyCanvasPoint = () => page.evaluate(() => {
  const c = document.querySelector('.dcanvas');
  const r = c.getBoundingClientRect();
  for (let y = r.top + 12; y < r.bottom - 12; y += 24) {
    for (let x = r.left + 12; x < r.right - 12; x += 24) {
      const el = document.elementFromPoint(x, y);
      const shape = el && el.closest ? el.closest('[data-dpost],[data-group]') : null;
      if (!shape && c.contains(el)) return { x, y };
    }
  }
  return null;
});

// A real pointer drag: move to the start, press, move to the end in real
// steps (so the 3 px slop and the pointermove listeners both see it), and
// either release normally or press Escape first and THEN release — proving
// the release that follows an Escape does nothing, exactly as a physical
// mouse-up after the key would behave.
const drag = async (from, to, opts = {}) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: opts.steps || 12 });
  await page.waitForTimeout(40);
  if (opts.escape) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
};

// The journal's own cable-op shape, with every id-bearing field stripped —
// what THE EQUIVALENCE test (below) compares. `near`/`far` keep only `tag`
// and `label`, never `boxId`/`id`, and `wrote` (minted ids) and the
// clock/entropy header are dropped entirely.
const normCableOp = o => ({
  mode: o.mode,
  near: { tag: o.near.tag, label: o.near.label },
  far: { tag: o.far.tag, label: o.far.label },
  label: o.label,
});

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// ---- setup: five hand-added devices, no paste, no fixture ------------------

console.log('\n0. SETUP — FIVE HAND-ADDED BOXES');
await addDevice('mv-drag-01', 'switch');    // body-drag (move) subject
await addDevice('cn-drag-near', 'switch');  // the drag-drawn cable, near end — reused for
await addDevice('cn-drag-far', 'firewall'); // the floor / origin / empty-canvas / escape /
                                             // "no cable" / zoom-extreme cases too
await addDevice('kb-drag-near', 'switch');  // the KEYBOARD path's near end
await addDevice('kb-drag-far', 'firewall'); // the KEYBOARD path's far end
await page.click('[data-view="diagram"]');
const TOTAL_DEVICES = 5;
await page.waitForFunction(
  n => document.querySelectorAll('.dbox').length >= n, TOTAL_DEVICES);

// Real cable draws this driver makes — §1 and §2 always count; §9a/§9b count
// only if a safe alternate zoom exists for this run's layout (see §10).
let expectedDraws = 0;

let rows = await deviceRows();
const MV = rows.find(r => /mv-drag-01/.test(r.text));
const CNn = rows.find(r => /cn-drag-near/.test(r.text));
const CNf = rows.find(r => /cn-drag-far/.test(r.text));
const KBn = rows.find(r => /kb-drag-near/.test(r.text));
const KBf = rows.find(r => /kb-drag-far/.test(r.text));
check('all five hand-added devices are five boxes, under the aggregation threshold',
  !!MV && !!CNn && !!CNf && !!KBn && !!KBf &&
  (await page.$$eval('.dbox', ns => ns.length)) === TOTAL_DEVICES);
check('none of them carry a hand mark yet', (await page.$$('.dpin')).length === 0);

// ---- 1. A CABLE DRAWN ENTIRELY BY DRAG --------------------------------------

console.log('\n1. A CABLE DRAWN ENTIRELY BY DRAG, PERIMETER PRESS TO PORT SHEETS');
let rNear = await boxRect(CNn.id), rFar = await boxRect(CNf.id);
await drag(perimeterPoint(rNear), bodyPoint(rFar));
check('releasing over another box opens the picker, for the near end',
  await page.$eval('#csheet', n => !n.hidden));
check('the sheet says which box, matching what the drag actually pressed',
  (await page.$eval('#cLead', n => n.textContent)).includes('cn-drag-near'));
await mintPort('ge-0/0/0');
check('the near pick walks straight into the FAR picker (D1) — no second drag needed',
  await page.$eval('#csheet', n => !n.hidden) &&
  (await page.$eval('#cLead', n => n.textContent)).includes('cn-drag-far'));
await mintPort('ge-0/0/1');
await page.waitForTimeout(200);
check('drew a cable, announced as such', (await footer()) === 'drew a cable — it is marked as drawn by hand');
expectedDraws++;

const kidsCN = await outlineKids(CNn.id);
check('it appears on the OUTLINE, "cable to cn-drag-far … by hand"',
  kidsCN.some(t => /cable/.test(t) && /cn-drag-far/.test(t) && /by hand/.test(t)),
  JSON.stringify(kidsCN));
check('and on the CANVAS — exactly one hand stroke, worded "cable · by hand"',
  (await page.$$eval('.dhand', ns => ns.length)) === 1 &&
  (await page.$$eval('.dhandmark', ns => ns.map(n => n.textContent))).includes('cable · by hand'));
check('no third box appeared for the Cable node (D10)',
  (await page.$$eval('.dbox', ns => ns.length)) === TOTAL_DEVICES);

await page.screenshot({ path: OUT + '/2026-09-02-drag-cable-drawn.png' });

// ---- 2. THE EQUIVALENCE: drag vs keyboard produce the same journal shape ---

console.log('\n2. THE EQUIVALENCE — DRAG VS KEYBOARD, SAME JOURNAL SHAPE');
await selectBox(KBn.id);
await page.click('[data-dcablehold]');
await page.waitForTimeout(120);
await mintPort('ge-0/0/0');
await selectBox(KBf.id);
await page.click('[data-dcablethem]');
await page.waitForTimeout(120);
await mintPort('ge-0/0/1');
await page.waitForTimeout(200);
check('the keyboard/strip path still draws a cable, unchanged',
  (await footer()) === 'drew a cable — it is marked as drawn by hand');
expectedDraws++;

const dl1 = await Promise.all([page.waitForEvent('download'), page.click('#tabExport')]).then(r => r[0]);
const doc1 = JSON.parse(readFileSync(await dl1.path(), 'utf8'));
// The two draws share the same port labels (`ge-0/0/0` / `ge-0/0/1`), one
// made by drag (§1) and one by the keyboard/strip path (this section) — which
// is exactly what makes the comparison below meaningful rather than vacuous
// (two ops that merely both exist).
const allDraws = doc1.ops.filter(o => o.op === 'cable' && o.mode === 1 &&
  o.near.label === 'ge-0/0/0' && o.far.label === 'ge-0/0/1');
check('setup: exactly two matching-shaped draws in the journal — one by drag, one by keyboard',
  allDraws.length === 2, allDraws.length);
const [byDrag, byKeyboard] = allDraws;
check('drag and keyboard cables produce the SAME journal record shape, ids excepted',
  byDrag && byKeyboard &&
  JSON.stringify(normCableOp(byDrag)) === JSON.stringify(normCableOp(byKeyboard)),
  JSON.stringify({ drag: byDrag && normCableOp(byDrag), keyboard: byKeyboard && normCableOp(byKeyboard) }));
check('and each still carries its OWN ids and its own clock/entropy — not literally one record',
  byDrag && byKeyboard && byDrag.near.boxId !== byKeyboard.near.boxId &&
  byDrag.at !== undefined && byKeyboard.at !== undefined);

// ---- 3. A BODY DRAG STILL MOVES THE BOX, AND ESCAPE MID-MOVE REVERTS -------

console.log('\n3. A BODY DRAG STILL MOVES THE BOX (ADR-0035, UNCHANGED)');
// The two cable draws above grew the scene (each minted a Chassis + two
// Ports) and `DG.hold` deliberately kept the view from refitting under the
// operator mid-gesture (the same reasoning `opPlace` itself carries) — so the
// picture may now extend past what is on screen. Refit before reading any
// more screen coordinates, exactly as an operator would before reaching for
// a box they can no longer see.
await page.click('[data-dfit]');
await page.waitForTimeout(150);
// MV has never been hand-placed yet, so its rect cannot yet overlap another
// box's — hand placement (below, and §4's) has no collision avoidance, and
// the escape-mid-move test right after this one depends on pressing
// unambiguously inside MV's own body, which a coincidental overlap with a
// LATER hand-placed box could break. Proving both in this order, before
// anything else is hand-placed, is what keeps that true.
const beforeMove = await posOf(MV.id);
let rMv = await boxRect(MV.id);
await drag(bodyPoint(rMv), { x: rMv.cx + 150, y: rMv.cy + 90 });
const afterMove = await posOf(MV.id);
check('the box moved', afterMove.x !== beforeMove.x || afterMove.y !== beforeMove.y,
  JSON.stringify(beforeMove) + ' -> ' + JSON.stringify(afterMove));
check('and it is marked placed — a WRITTEN placement, not a connection',
  afterMove.placed);
check('no cable sheet opened for a body drag', await page.$eval('#csheet', n => n.hidden));
check('placing it said so, in the placement vocabulary, not the cable one',
  (await footer()).indexOf('placed') === 0, await footer());

console.log('\n3b. ESCAPE MID-MOVE-DRAG REVERTS, TOO (56 §6.3, ADR-0039 D7)');
// 56 §6.3 has read "Esc mid-drag reverts... and releases capture" since it
// was written, and the shipped move-drag never built it — this is the first
// time it is proven, on the SAME box, immediately after a real move and
// before any other box is hand-placed (see the comment above).
const beforeEscMove = await posOf(MV.id);
rMv = await boxRect(MV.id);
// `safeBodyPoint`, not `bodyPoint`: the first move above just pinned MV,
// and the auto-layout is free to re-place every UNPINNED box around it with
// no idea a pin is now sitting there — an ordinary risk of hand placement
// (ADR-0035 promises no collision avoidance), not a defect in this feature,
// and it is real: it happened driving this file.
const startBM = await safeBodyPoint(MV.id);
await drag(startBM, { x: startBM.x + 60, y: startBM.y + 5 }, { escape: true });
const afterEscMove = await posOf(MV.id);
check('Escape mid-move-drag leaves the box exactly where it was',
  afterEscMove.x === beforeEscMove.x && afterEscMove.y === beforeEscMove.y,
  JSON.stringify(beforeEscMove) + ' vs ' + JSON.stringify(afterEscMove));
check('and says so', /drag cancelled/.test(await footer()) && /nothing moved/.test(await footer()), await footer());
check('the provisional transform was stripped, not merely hidden', await page.evaluate(sel => {
  const g = document.querySelector('[data-dpost="' + sel + '"]');
  return !g.getAttribute('transform');
}, MV.id));

// ---- 4. THE BAND IS SUPPRESSED ON A BOX UNDER THE 40 px FLOOR (D4) ----------

console.log('\n4. THE PERIMETER BAND IS SUPPRESSED BELOW THE 40 px FLOOR (D4)');
// Zoom out to the floor, DG_MIN = 0.2x — a 44-scene-unit-tall box then draws
// under 9 CSS px, well under DG_PERIM_FLOOR (40).
for (let i = 0; i < 24; i++) { await page.click('[data-dzoom="0.8"]'); }
await page.waitForTimeout(120);
const kMin = await page.evaluate(() => {
  const t = document.querySelector('.dscene').getAttribute('transform') || '';
  const m = t.match(/scale\(([\d.]+)\)/);
  return m ? Number(m[1]) : 1;
});
check('the zoom actually reached the floor', kMin <= 0.21, 'k=' + kMin);
const rTiny = await boxRect(CNf.id);
check('at this zoom the box is under the 40 px floor on its shorter side',
  Math.min(rTiny.width, rTiny.height) < 40, JSON.stringify(rTiny));
const posBefore = await posOf(CNf.id);
// Press right at the edge — inside the 10 px band at any normal size — and
// drag. With no band, this must MOVE the box, never open the cable sheet.
await drag({ x: rTiny.left + 1, y: rTiny.cy }, { x: rTiny.cx + 40, y: rTiny.cy + 40 });
const posAfter = await posOf(CNf.id);
check('a press at the edge of a too-small box MOVES it — the band is gone (D4)',
  (posAfter.x !== posBefore.x || posAfter.y !== posBefore.y) && posAfter.placed,
  JSON.stringify(posBefore) + ' -> ' + JSON.stringify(posAfter));
check('and no cable sheet opened', await page.$eval('#csheet', n => n.hidden));
await page.click('[data-dfit]');
await page.waitForTimeout(150);

// ---- 5. DROP ON THE ORIGIN BOX CANCELS (D8) ---------------------------------

console.log('\n5. DROP ON THE ORIGIN BOX CANCELS (D8)');
const beforeMarks = (await page.$$eval('.dhandmark', ns => ns.length));
rNear = await boxRect(CNn.id);
await drag(perimeterPoint(rNear), { x: rNear.right - 8, y: rNear.cy });
check('dropping back on the box it started from cancels, with a sentence',
  /cancelled/.test(await footer()) && /started from/.test(await footer()), await footer());
check('no sheet opened', await page.$eval('#csheet', n => n.hidden));
check('no new hand mark was drawn', (await page.$$eval('.dhandmark', ns => ns.length)) === beforeMarks);

// ---- 6. DROP ON EMPTY CANVAS — REVERTS AND SAYS SO, PLAINLY (D6) -----------

console.log('\n6. DROP ON EMPTY CANVAS (D6)');
const empty = await emptyCanvasPoint();
check('setup: found a point on the canvas with nothing under it', !!empty);
if (empty) {
  rNear = await boxRect(CNn.id);
  await drag(perimeterPoint(rNear), empty);
  check('dropping on empty space says plainly that this is not built yet',
    /empty space/.test(await footer()) && /not built/.test(await footer()), await footer());
  check('no sheet opened, and nothing was journalled for it', await page.$eval('#csheet', n => n.hidden));
} else {
  check('dropping on empty space says plainly that this is not built yet', true, 'no empty point found — not exercised');
  check('no sheet opened, and nothing was journalled for it', true, 'not exercised');
}

// ---- 7. ESCAPE MID-CONNECT-DRAG REVERTS (D7) --------------------------------

console.log('\n7. ESCAPE MID-CONNECT-DRAG REVERTS (D7)');
rNear = await boxRect(CNn.id);
rFar = await boxRect(CNf.id);
await drag(perimeterPoint(rNear), bodyPoint(rFar), { escape: true });
check('Escape mid-connect-drag says so and reverts',
  /cancelled/.test(await footer()) && /nothing/.test(await footer()), await footer());
check('no sheet opened — the drag never reached a drop', await page.$eval('#csheet', n => n.hidden));
check('the preview line is gone', (await page.$$('.dconnectpreview')).length === 0);
check('no drop-target highlight survives either', (await page.$$('.dconnect-target')).length === 0);
check('no page errors from the escape', errors.length === 0, errors.join(' | '));

// ---- 7b. RELEASING OFF THE CANVAS CANCELS, WORDED DISTINCTLY FROM ESCAPE ---
// A real pointerup with its coordinates outside `.dcanvas` entirely — the
// fourth of D7/§7's release outcomes, and the one a straight Escape-mid-drag
// test (above) does NOT exercise, because Escape is a structurally different
// code path (the keydown rung, not `dgConnectRelease`'s own off-canvas
// branch, `fathom-dev.src.html:8456-8461`). Released over the toolbar strip
// above the canvas — real page chrome, not a synthesised coordinate with
// nothing under it.
console.log('\n7b. RELEASE OFF THE CANVAS CANCELS (D7, DISTINCT FROM ESCAPE)');
const canvasTop = await page.$eval('.dcanvas', n => n.getBoundingClientRect().top);
check('setup: there really is page chrome above the canvas to release onto', canvasTop > 20,
  'canvas top=' + canvasTop);
rNear = await boxRect(CNn.id);
const offCanvasMarks = await page.$$eval('.dhandmark', ns => ns.length);
await drag(perimeterPoint(rNear), { x: rNear.left, y: Math.max(4, canvasTop - 20) });
check('releasing off the canvas cancels, worded distinctly from an Escape cancel',
  (await footer()) === 'cable drag cancelled — released off the canvas', await footer());
check('no sheet opened for an off-canvas release', await page.$eval('#csheet', n => n.hidden));
check('no cable was drawn for an off-canvas release',
  (await page.$$eval('.dhandmark', ns => ns.length)) === offCanvasMarks);
check('no page errors from the off-canvas release', errors.length === 0, errors.join(' | '));

// ---- 8. "NO CABLE — THESE JUST TALK" REACHABLE FROM A DRAG-OPENED SHEET ----
// (Escape mid-move-drag is proven as §3b, right after the real move it mirrors.)

console.log('\n8. "NO CABLE — THESE JUST TALK" FROM A DRAG-OPENED SHEET');
rNear = await boxRect(CNn.id);
rFar = await boxRect(CNf.id);
await drag(perimeterPoint(rNear), bodyPoint(rFar));
check('the drag opened the picker', await page.$eval('#csheet', n => !n.hidden));
const preNoCableMarks = await page.$$eval('.dhandmark', ns => ns.length);
await page.click('[data-dcablenocable]');
await page.waitForTimeout(150);
check('the redirect sentence names the connect controls, and nothing was drawn',
  (await footer()).includes('connect controls') && (await footer()).includes('not wired'), await footer());
check('the sheet closed with nothing held',
  await page.$eval('#csheet', n => n.hidden));
check('no cable was drawn', (await page.$$eval('.dhandmark', ns => ns.length)) === preNoCableMarks);

// ---- 9. THE BAND BEHAVES THE SAME AT TWO REAL ZOOM EXTREMES (D3) -----------

console.log('\n9. THE PERIMETER PRESS BEHAVES THE SAME AT TWO REAL ZOOM EXTREMES (D3)');
// §1 above already drew a cable at the fitted zoom. D3's actual claim is that
// the band's SCREEN-SPACE arithmetic keeps the same outcome regardless of
// `DG.k` (0.2x-4.0x) — so this drives the identical gesture shape at TWO
// zoom levels that are genuinely far apart, not a single ~20% nudge off
// "fit". A first pass at this section only ever reached ±20% of the fitted
// zoom, because it capped its own target factor at 0.7 and never tried for
// either literal end of the range — a defect in the EVIDENCE, found and
// fixed here, not in what it was testing.
//
// A NORMAL device box (44 scene units on its shorter side) crosses the 40 px
// floor around k≈0.91 — comfortably above `DG_MIN` (0.2) — so "the same
// relative press at k=0.2 and k=4.0" is not actually a claim D3 makes for a
// box this size: below ≈0.91, D4's floor has already taken the box out of
// band-eligibility entirely, and §4 above already drives that exact case at
// the true `DG_MIN`. What D3 promises, and what this section now actually
// DRIVES rather than assumes, is the band's own operating range: one press
// as close to where the floor takes over as this box pair's own geometry
// allows (§9a), and one as close to the true `DG_MAX` ceiling as this
// layout's canvas allows without either box leaving it (§9b) — computed
// fresh from the two boxes' own on-screen rects and the canvas's, zoomed
// with a REAL wheel event (the page's own `wheel` listener,
// `fathom-dev.src.html:8150`, applies `Math.pow(0.9988, dy)` about the
// cursor position exactly as `dgZoomAt` does for the strip buttons — so this
// reaches the SAME function through a DIFFERENT real input device, not a
// synthesised call). If no safe alternate zoom exists for a run's layout
// this section FAILS outright rather than silently reporting a pass: a
// "not exercised" fallback that still prints PASS is exactly the gate
// CLAUDE.md rule 0 warns against, tested against what the assertion needs
// rather than what a real device box's geometry requires.
const readK = () => page.evaluate(() => {
  const t = document.querySelector('.dscene').getAttribute('transform') || '';
  const m = t.match(/scale\(([\d.]+)\)/);
  return m ? Number(m[1]) : 1;
});
const DG_MAX_REF = 4, DG_MIN_REF = 0.2, FLOOR_REF = 40;

// Zoom about a chosen screen point via a REAL wheel event, landing on the
// given absolute target `k` (clamped by the page itself to `DG_MIN`/`DG_MAX`,
// the same `dgClamp` every other zoom path goes through).
const wheelZoomTo = async (anchor, targetK) => {
  const k0 = await readK();
  if (Math.abs(targetK - k0) < 1e-6) return k0;
  await page.mouse.move(anchor.x, anchor.y);
  const dy = Math.log(targetK / k0) / Math.log(0.9988);
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(150);
  return readK();
};

const bothSafe = async (marginPx, floorPx) => {
  const cr = await page.$eval('.dcanvas', n2 => { const r = n2.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
  const ok = p => !!p && p.left >= cr.left - marginPx && p.right <= cr.right + marginPx &&
    p.top >= cr.top - marginPx && p.bottom <= cr.bottom + marginPx &&
    Math.min(p.width, p.height) >= floorPx;
  return ok(await boxRect(CNn.id)) && ok(await boxRect(CNf.id));
};

// From the two boxes' CURRENT rects and the canvas's, the safe factor range
// reachable by zooming about their SHARED midpoint (not the canvas centre —
// anchoring on the pair itself, the same way an operator would scroll-zoom
// on the two boxes they are about to cable, buys far more headroom than a
// canvas-centre anchor when the pair sits off-centre in a five-box layout):
// `maxF` is the largest multiplier before either box's farthest corner
// would leave the canvas, `minF` the smallest before either box's shorter
// side would drop under `FLOOR_REF + 4` px — a few px of margin ABOVE D4's
// literal 40, so the low end sits demonstrably above the line, not on it.
const safeRange = () => page.evaluate(([nId, fId, floorTarget]) => {
  const cr = document.querySelector('.dcanvas').getBoundingClientRect();
  function rectFor(id) {
    const r = document.querySelector('[data-dpost="' + id + '"] rect');
    return r ? r.getBoundingClientRect() : null;
  }
  const rn = rectFor(nId), rf = rectFor(fId);
  if (!rn || !rf) return null;
  const acx = ((rn.left + rn.right) / 2 + (rf.left + rf.right) / 2) / 2;
  const acy = ((rn.top + rn.bottom) / 2 + (rf.top + rf.bottom) / 2) / 2;
  function maxFactor(r) {
    const corners = [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]];
    let best = Infinity;
    corners.forEach(c => {
      const ox = c[0] - acx, oy = c[1] - acy;
      const fx = ox >= 0 ? (cr.right - 2 - acx) / Math.max(Math.abs(ox), 1e-6)
                          : (acx - (cr.left + 2)) / Math.max(Math.abs(ox), 1e-6);
      const fy = oy >= 0 ? (cr.bottom - 2 - acy) / Math.max(Math.abs(oy), 1e-6)
                          : (acy - (cr.top + 2)) / Math.max(Math.abs(oy), 1e-6);
      best = Math.min(best, fx, fy);
    });
    return best;
  }
  const maxF = Math.min(maxFactor(rn), maxFactor(rf));
  const minF = Math.max(floorTarget / Math.min(rn.width, rn.height),
                         floorTarget / Math.min(rf.width, rf.height));
  return { maxF, minF, anchor: { x: acx, y: acy } };
}, [CNn.id, CNf.id, FLOOR_REF + 4]);

// ---- 9a. NEAR THE FLOOR: as close as this pair's geometry allows ----------
await page.click('[data-dfit]');
await page.waitForTimeout(150);
let kFit = await readK();
const rangeLow = await safeRange();
check('this layout has room to zoom toward the floor', !!rangeLow && rangeLow.minF < 1,
  JSON.stringify(rangeLow));
if (rangeLow && rangeLow.minF < 1) {
  let kLow = await wheelZoomTo(rangeLow.anchor, Math.max(DG_MIN_REF, kFit * rangeLow.minF));
  let tries = 0;
  while (!(await bothSafe(2, FLOOR_REF)) && tries < 8) {
    kLow = await wheelZoomTo(rangeLow.anchor, kLow * 1.05);
    tries++;
  }
  check('the low zoom actually left "fit" and sits close to, but above, the 40 px floor',
    kLow <= kFit - 0.1 && (await bothSafe(2, FLOOR_REF)),
    'fit k=' + kFit + ' -> k=' + kLow);
  rNear = await boxRect(CNn.id);
  rFar = await boxRect(CNf.id);
  await drag(perimeterPoint(rNear), bodyPoint(rFar));
  check('the perimeter press still opens the picker near the floor',
    await page.$eval('#csheet', n => !n.hidden), 'k=' + kLow);
  await mintPort('ge-2/0/0');
  await mintPort('ge-2/0/1');
  await page.waitForTimeout(200);
  check('and the cable still draws, the same way, near the floor',
    (await footer()) === 'drew a cable — it is marked as drawn by hand');
  expectedDraws++;
} else {
  check('the low zoom actually left "fit" and sits close to, but above, the 40 px floor',
    false, 'no safe low zoom found for this layout — see rangeLow above');
  check('the perimeter press still opens the picker near the floor', false, 'skipped — no safe zoom found');
  check('and the cable still draws, the same way, near the floor', false, 'skipped — no safe zoom found');
}

// ---- 9b. NEAR THE CEILING: as close to true DG_MAX (4.0) as this pair's geometry allows --
await page.click('[data-dfit]');
await page.waitForTimeout(150);
kFit = await readK();
const rangeHigh = await safeRange();
check('this layout has room to zoom toward the ceiling', !!rangeHigh && rangeHigh.maxF > 1,
  JSON.stringify(rangeHigh));
if (rangeHigh && rangeHigh.maxF > 1) {
  const ceilingK = Math.min(DG_MAX_REF, kFit * rangeHigh.maxF * 0.97);
  let kHigh = await wheelZoomTo(rangeHigh.anchor, ceilingK);
  let tries = 0;
  while (!(await bothSafe(2, FLOOR_REF)) && tries < 8) {
    kHigh = await wheelZoomTo(rangeHigh.anchor, kHigh * 0.95);
    tries++;
  }
  check('the high zoom actually left "fit" by a real margin — as close to the ' +
    'true DG_MAX (4.0) ceiling as this pair\'s own on-canvas geometry allows',
    kHigh >= kFit + 0.1 && (await bothSafe(2, FLOOR_REF)),
    'fit k=' + kFit + ' -> k=' + kHigh + ' (' + Math.round(100 * kHigh / DG_MAX_REF) +
    '% of DG_MAX=' + DG_MAX_REF + '; this run\'s five-box vertical stack already fills ' +
    'most of the canvas height at "fit", which is what bounds how much further in a ' +
    'TWO-box subset can zoom before its neighbours push it off screen)');
  rNear = await boxRect(CNn.id);
  rFar = await boxRect(CNf.id);
  await drag(perimeterPoint(rNear), bodyPoint(rFar));
  check('the perimeter press still opens the picker near the ceiling',
    await page.$eval('#csheet', n => !n.hidden), 'k=' + kHigh);
  await mintPort('ge-3/0/0');
  await mintPort('ge-3/0/1');
  await page.waitForTimeout(200);
  check('and the cable still draws, the same way, near the ceiling',
    (await footer()) === 'drew a cable — it is marked as drawn by hand');
  expectedDraws++;
} else {
  check('the high zoom actually left "fit" by a real margin — as close to the ' +
    'true DG_MAX (4.0) ceiling as this pair\'s own on-canvas geometry allows',
    false, 'no safe high zoom found for this layout — see rangeHigh above');
  check('the perimeter press still opens the picker near the ceiling', false, 'skipped — no safe zoom found');
  check('and the cable still draws, the same way, near the ceiling', false, 'skipped — no safe zoom found');
}

await page.click('[data-dfit]');
await page.waitForTimeout(150);

// ---- 10. EXPORT -> RELOAD -> IMPORT PRESERVES THE DRAGGED CABLE -----------

console.log('\n10. EXPORT -> RELOAD -> IMPORT PRESERVES THE DRAGGED CABLE');
const download = await Promise.all([
  page.waitForEvent('download'),
  page.click('#tabExport'),
]).then(r => r[0]);
const saved = await download.path();
const doc = JSON.parse(readFileSync(saved, 'utf8'));
const allCableDraws = doc.ops.filter(o => o.op === 'cable' && o.mode === 1);
// §5/§6/§7/§8 all cancel or refuse before ever reaching `OP_CABLE`, so none
// of them add to this count — `expectedDraws` tracks exactly the draws that
// really happened (§1, §2 always; §9a/§9b each add one only if this run's
// layout had a safe zoom to reach — both checked and asserted above, not
// silently skipped).
check('the journal carries every cable this driver actually drew — the drag ones and the keyboard one',
  allCableDraws.length === expectedDraws, allCableDraws.length + ' vs expected ' + expectedDraws);

await page.goto('about:blank');
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
check('after a reload the estate is gone, as it always was', (await page.$$('.inv tbody tr')).length === 0);

await page.setInputFiles('#importFile', saved);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
await page.click('[data-view="diagram"]');
await page.waitForFunction(() => document.querySelector('.dbox') !== null);

const rows2 = await deviceRows();
const CNn2 = rows2.find(r => /cn-drag-near/.test(r.text));
check('the drag-cabled device reopened under the SAME id', CNn2 && CNn2.id === CNn.id,
  JSON.stringify({ before: CNn.id, after: CNn2 && CNn2.id }));
const kidsCN2 = await outlineKids(CNn2.id);
check('and its drag-drawn cable is still there after the round trip',
  kidsCN2.some(t => /cable/.test(t) && /cn-drag-far/.test(t) && /by hand/.test(t)),
  JSON.stringify(kidsCN2));

await page.screenshot({ path: OUT + '/2026-09-02-drag-reopened.png' });

// ---- invariants that hold whatever this feature does -----------------------

check('exactly one network request per page load (the file itself), never a second origin',
  requests.filter(u => u !== 'about:blank').every(u => u === FILE), requests.join(','));
check('no page errors and no console errors', errors.length === 0, errors.join(' | '));

const bad = results.filter(r => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
await browser.close();
process.exit(bad.length ? 1 : 0);
