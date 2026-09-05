// THE DIAGRAM OPENS ON THE DEVICES — driven in Chromium against the shipped
// artifact, over the documented SRX branch fixture, through a real
// export → reload → import.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-09-04-the-diagram-opens-on-the-devices.mjs [repo-root]
//
// WHAT WAS SEEN, 2026-09-04, at 1400×900: one pasted SRX config pressed into
// `diagram` drew 47 boxes and 60 lines five columns wide, fitted to 0.29× with
// 94 labels off — one `Device` and 46 things that live inside it. The view
// said `data-depth="site"`; `57` §2 says rung 1 is `Site → Device`.
//
// WHY, established before anything was changed and measured again here (§4):
// not the five layers — physical alone still draws every interface and the
// seven untabled kinds; not a missing like-kind fold — `59` §3 fires on runs
// of more than six IDENTICAL siblings and the SRX's eight interfaces have eight
// edge signatures, so the module reported 0 collapsed; it was the rung. `56`
// §4.1's stubs, labels and brackets are all drawn as full boxes one column
// deeper per containment hop, so the site rung drew rung 4's contents beside
// the device. The fix (`dgFoldInside`) folds everything under a `Device` into
// its box at rung 1, says how many, and offers `show what is inside`.
//
// THE CHECKS THAT FAILED BEFORE THE FIX are §1's first three: one box on
// first open, a zoom far above 0.29×, and a control that did not exist. §2 is
// the requirement that nothing was hidden or deleted: every one of the 46 is
// reached by ONE press, and the device box does not move when they appear.
// §3 walks the other ways in — the Outline's disclosure, the details pane,
// rung 4. §4 records the finding as a measurement rather than an argument.
// (§1 also pins, since 2026-09-05, that the note counts one box in the
// singular — the first run's own screenshot read "1 boxes standing for 1
// objects", a defect this fold made ordinary and the plural() fix removed.)
// §5 pins that a hand-built lab, which has nothing inside its boxes, is
// untouched and is not offered a control with nothing behind it (`70`
// §19.4b). §6 draws a link between two interfaces on two devices and requires
// the folded picture to draw it device-to-device, once, marked by hand. §7
// does the first open again after a real reload, from the exported journal.
//
// Playwright and Chromium are the ones already on this machine; neither is a
// dependency of the product and neither is in Cargo.lock (gate zero).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const OUT = ROOT + '/docs/80-review/evidence';
const FIXTURE = readFileSync(
  ROOT + '/crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt', 'utf8');
// A second box with one interface, so §6 has two devices with something
// inside each. A different hostname, so the additive paste asks no duplicate
// question and adds it beside the first.
const SECOND = [
  'set system host-name branch-two',
  'set interfaces ge-0/0/0 unit 0 family inet address 10.9.9.1/24',
].join('\n');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const requests = [];
page.on('request', r => requests.push(r.url()));

const open = async () => {
  await page.goto('about:blank');
  await page.goto(FILE);
  await page.waitForFunction(() => !!document.getElementById('band').children.length);
};
const paste = async text => {
  await page.click('#tabPaste');
  await page.fill('#pta', text);
  await page.click('#pRun');
  await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
  await page.keyboard.press('Escape');
};
const addDevice = async (name, role) => {
  await page.click('#tabEquip');
  await page.fill('#ef6', name);
  await page.selectOption('#ef7', 'junos-srx');
  await page.selectOption('#ef9', role);
  await page.click('#eRun');
  await page.keyboard.press('Escape');
};
const toDiagram = async () => {
  await page.click('#band button:has-text("diagram")');
  await page.waitForSelector('.dcanvas');
};
// What the picture and its furniture say, read off the DOM the way a person
// reads it. The zoom is the readout in the strip, parsed.
const snap = () => page.evaluate(() => ({
  boxes: [...document.querySelectorAll('.dbox')].map(g => ({
    id: g.getAttribute('data-dpost') || g.getAttribute('data-group'),
    kind: g.querySelector('.dkind').textContent,
    name: g.querySelector('.dname').textContent,
    x: +g.querySelector('rect:last-of-type').getAttribute('x'),
    y: +g.querySelector('rect:last-of-type').getAttribute('y'),
  })),
  lines: document.querySelectorAll('.dline').length,
  refLines: document.querySelectorAll('.dline.dref').length,
  handMarks: [...document.querySelectorAll('.dhandmark')].map(n => n.textContent),
  zoom: parseFloat(document.querySelector('.dzoom').textContent),
  band: document.querySelector('.dband').textContent,
  insideMarks: [...document.querySelectorAll('.dinside')].map(n => n.textContent),
  toggle: [...document.querySelectorAll('[data-inside]')].map(n => ({
    text: n.textContent, pressed: n.getAttribute('aria-pressed') })),
  depth: document.querySelector('.dview').getAttribute('data-depth'),
  rows: [...document.querySelectorAll('[data-drow]')].map(r => ({
    id: r.getAttribute('data-drow'),
    name: r.querySelector('.doname').textContent,
    kind: r.querySelector('.dokind').textContent,
    inside: r.getAttribute('data-dinside'),
  })),
  note: document.querySelector('.dout .note').textContent,
}));
// Back to the OBJECTS pane. Selecting a row from the pointer turns the panel
// to DETAILS (Direction A), so a second row click has to come back first —
// the same `objects()` step `2026-08-29-cabling-drive.mjs` takes.
const objects = () => page.click('.dpanel [data-dpane="objects"]');
const showInside = async () => {
  await page.click('[data-inside][aria-pressed="false"]');
  await page.waitForSelector('.dcanvas');
};
const foldInside = async () => {
  await page.click('[data-inside][aria-pressed="true"]');
  await page.waitForSelector('.dcanvas');
};
// The Outline's disclosure under a row, opened the way a keyboard opens it.
const childrenOf = async id => {
  await objects();
  await page.focus('[data-drow="' + id + '"]');
  await page.keyboard.press('ArrowRight');
  return page.$$eval('[data-dparent="' + id + '"]', ns => ns.map(n => ({
    rel: n.querySelector('.dorel') ? n.querySelector('.dorel').textContent : '',
    name: n.querySelector('.doname') ? n.querySelector('.doname').textContent : '',
    kind: n.querySelector('.dokind') ? n.querySelector('.dokind').textContent : '',
    link: n.getAttribute('data-dlink'),
    inside: n.classList.contains('doinside'),
    text: n.textContent,
  })));
};

// ---- 1. FIRST OPEN: THE DEVICE, AT A ZOOM A PERSON CAN READ -----------------
await open();
await paste(FIXTURE);
await toDiagram();
let s = await snap();
check('one pasted config opens as ONE box, the device (was 47)',
  s.boxes.length === 1 && s.boxes[0].kind === 'Device' && s.boxes[0].name === 'branch-srx',
  s.boxes.length + ' boxes: ' + s.boxes.map(b => b.kind).join(', '));
check('and the first-open zoom is far above 0.29× (was 0.29×)', s.zoom >= 1,
  s.zoom + '×');
check('the strip offers `show what is inside`, unpressed (did not exist)',
  s.toggle.length === 1 && s.toggle[0].text === 'show what is inside' && s.toggle[0].pressed === 'false',
  JSON.stringify(s.toggle));
check('the view is at the site rung', s.depth === 'site', s.depth);
check('the box carries the count under it, in the picture',
  s.insideMarks.length === 1 && s.insideMarks[0] === '46 inside', JSON.stringify(s.insideMarks));
check('the Outline row carries the same count', s.rows.length === 1 && s.rows[0].inside === '46',
  JSON.stringify(s.rows));
check('the band says how many are not drawn, with its cardinal',
  /\b1 object · 0 links · 46 inside the boxes, not drawn\b/.test(s.band), s.band);
check('the note names the count, the 14 links among them, and the next action',
  /46 objects are inside the device boxes and not drawn beside them, with 14 links among them — press show what is inside/.test(s.note),
  s.note.slice(0, 220));
check('no labels are off at this zoom', !/labels? off/.test(s.band), s.band);
// Added 2026-09-05: the first screenshot this driver took read "1 boxes
// standing for 1 objects" — the fold made one box the ordinary first picture
// and the note had never had to count to one. Through plural() now, as the
// band's counts are. This check fails on the build that took that screenshot.
// (`textContent` runs the note's <b> lead straight into its body — "…not a
// record1 box…" — so the lead is matched literally rather than by a word
// boundary that is not there.)
check('and the note counts its one box in the singular (read "1 boxes standing for 1 objects")',
  /not a record1 box standing for 1 object · 46 objects are inside/.test(s.note), s.note.slice(34, 100));
// Added 2026-09-05, from re-running `2026-08-15-diagram-surface-drive.mjs`
// after the fold: dgHold clamped the pan against the PADDED extent, and at
// this fit DG_PAD scales to 85 px — more than the 48 px the hold keeps — so
// six full-width drags pushed the one box clean off the canvas with 48 px of
// blank paper still "on screen". dgHold now holds the boxes. The drag starts
// on canvas background (the box's left edge is ~109 px in at this fit), so it
// pans and never places. This check fails on the page before the inset.
const cbb = await (await page.$('.dcanvas')).boundingBox();
for (let i = 0; i < 6; i++) {
  await page.mouse.move(cbb.x + 30, cbb.y + cbb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cbb.x + cbb.width - 20, cbb.y + cbb.height / 2, { steps: 6 });
  await page.mouse.up();
}
const pushed = await page.evaluate(() => {
  const c = document.querySelector('.dcanvas').getBoundingClientRect();
  const shapes = Array.from(document.querySelectorAll('.dbox rect'));
  const touching = shapes.filter(r => {
    const b = r.getBoundingClientRect();
    return b.right > c.left && b.left < c.right && b.bottom > c.top && b.top < c.bottom;
  }).length;
  return { touching, total: shapes.length,
           placed: document.querySelectorAll('.dplaced').length,
           transform: document.querySelector('.dscene').getAttribute('transform') };
});
check('six full-width drags cannot push the one box off the canvas at this fit (they could)',
  pushed.touching >= 1, pushed.touching + '/' + pushed.total + ' still on screen · ' + pushed.transform);
check('and the drags panned — nothing was placed by hand', pushed.placed === 0,
  pushed.placed + ' placed');
await page.click('[data-dfit]');
s = await snap();
const deviceId = s.rows[0].id;
const deviceAt = { x: s.boxes[0].x, y: s.boxes[0].y };
await page.screenshot({ path: OUT + '/2026-09-04-the-diagram-opens-on-the-devices.png' });

// ---- 2. ONE PRESS REACHES EVERY ONE OF THE 46, AND THE BOX DOES NOT MOVE ----
// The 46 are named FIRST, from the folded picture's own disclosure, so the
// assertion below is "each of these" and never "whatever appeared".
const folded = await childrenOf(deviceId);
const insideRows = folded.filter(k => k.inside);
check('the device row opens onto 46 `inside` rows', insideRows.length === 46,
  insideRows.length + ' of ' + folded.length + ' children');
check('every one is selectable — carries the object\'s own id',
  insideRows.every(k => k.link && k.rel === 'inside'),
  insideRows.filter(k => !k.link).length + ' without an id');
const kindsFolded = {};
insideRows.forEach(k => { kindsFolded[k.kind] = (kindsFolded[k.kind] || 0) + 1; });
check('they are the interfaces, units, zones and policies of rung 4',
  kindsFolded.Interface === 8 && kindsFolded.LogicalUnit === 8 && kindsFolded.Zone === 5 &&
  kindsFolded.PolicySet === 4 && kindsFolded.SecurityPolicy === 4 && kindsFolded.Address === 4,
  JSON.stringify(kindsFolded));

await showInside();
s = await snap();
check('one press draws every one: 47 boxes, 60 lines — the picture as it was',
  s.boxes.length === 47 && s.lines === 60, s.boxes.length + ' boxes, ' + s.lines + ' lines');
const drawnIds = new Set(s.boxes.map(b => b.id));
const rowIds = new Set(s.rows.map(r => r.id));
check('and each of the 46 named above is now a box AND a level-1 row',
  insideRows.every(k => drawnIds.has(k.link) && rowIds.has(k.link)),
  insideRows.filter(k => !drawnIds.has(k.link)).length + ' not drawn');
check('the device box did not move when they appeared (`56` §3.6)',
  s.boxes.find(b => b.id === deviceId).x === deviceAt.x &&
  s.boxes.find(b => b.id === deviceId).y === deviceAt.y,
  JSON.stringify(deviceAt) + ' → ' + JSON.stringify(s.boxes.find(b => b.id === deviceId)));
check('the control says what IS: `showing what is inside`, pressed',
  s.toggle.length === 1 && s.toggle[0].text === 'showing what is inside' && s.toggle[0].pressed === 'true',
  JSON.stringify(s.toggle));
check('the count under the box is gone — it marked a fold', s.insideMarks.length === 0,
  JSON.stringify(s.insideMarks));
check('the band no longer says anything is not drawn', !/not drawn/.test(s.band), s.band);
check('the note flips to say the 46 are drawn beside their device',
  /showing the 46 objects inside the device boxes beside them/.test(s.note), s.note.slice(0, 160));
const shownZoom = s.zoom;
check('the fit is back to the whole picture (recorded, not judged)', shownZoom < 1,
  shownZoom + '×');
// Added 2026-09-05, from re-running `2026-08-15-diagram-surface-drive.mjs`:
// with the insides shown an interface has a box of its own, and the first cut
// of dgBoxOf still sent its selection and its ring to the DEVICE, because the
// fold's object→device map was consulted whether or not the fold was applied.
// Selected from its own level-1 row, through the same click a person makes.
const shownIf = insideRows.find(k => k.kind === 'Interface');
await objects();
await page.click('[data-drow="' + shownIf.link + '"]');
const own = await page.evaluate(id => {
  const sel = document.querySelector('.dsel');
  const box = document.querySelector('[data-dpost="' + id + '"] rect:last-of-type');
  const row = document.querySelector('[data-drow="' + id + '"]');
  return { sel: sel ? sel.getAttribute('data-dpost') : null,
           ringX: +document.querySelector('.dring').getAttribute('x'),
           boxX: box ? +box.getAttribute('x') : null,
           ariaSel: row ? row.getAttribute('aria-selected') : null };
}, shownIf.link);
check('with the insides shown, selecting an interface selects ITS box, not the device\'s (it did)',
  own.sel === shownIf.link && own.ariaSel === 'true', JSON.stringify(own));
check('and the ring is on that box, 4 px out', own.boxX !== null && own.ringX === own.boxX - 4,
  'ring x=' + own.ringX + ' box x=' + own.boxX);

await foldInside();
s = await snap();
check('pressing it again folds them back: one box, the zoom a person can read',
  s.boxes.length === 1 && s.zoom >= 1, s.boxes.length + ' boxes at ' + s.zoom + '×');

// ---- 3. THE OTHER WAYS IN: A ROW, THE DETAILS PANE, RUNG 4 -----------------
const first = insideRows.find(k => k.kind === 'Interface');
await childrenOf(deviceId);
await page.click('[data-dparent="' + deviceId + '"][data-dlink="' + first.link + '"]');
const det = await page.evaluate(() => ({
  head: document.querySelector('#ddetHead').textContent,
  folio: document.querySelector('.ddet .folio').textContent,
  ring: document.querySelector('.dring').getAttribute('visibility'),
  ringX: +document.querySelector('.dring').getAttribute('x'),
  foot: document.getElementById('foot') ? document.getElementById('foot').textContent : '',
}));
check('an `inside` row selects the object: the details name it and its kind',
  det.head === first.name && det.folio === 'Interface', det.head + ' / ' + det.folio);
check('and the ring lands on the device it is inside, 4 px out (`--s1`)',
  det.ring === 'visible' && det.ringX === deviceAt.x - 4, det.ring + ' at x=' + det.ringX);

await page.click('[data-drow="' + deviceId + '"]');
const sum = await page.$eval('.ddet .dinsidesum', n => n.textContent);
check('the details pane says WHAT is inside, by kind',
  /^46 inside, not drawn beside it: /.test(sum) && /8 Interface/.test(sum) &&
  /8 LogicalUnit/.test(sum) && /5 Zone/.test(sum) && /4 SecurityPolicy/.test(sum), sum);
check('and still offers the way down to rung 4',
  (await page.$$('[data-dinto]')).length === 1);
await page.click('[data-dinto]');
check('rung 4 opens as before', (await page.$$('#ibody')).length === 1 &&
  (await page.$eval('.dview', n => n.getAttribute('data-depth'))) === 'device');
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('.dview').getAttribute('data-depth') === 'site');
s = await snap();
check('and Escape comes back out to the one box', s.boxes.length === 1 && s.depth === 'site',
  s.boxes.length + ' at ' + s.depth);

// ---- 4. THE FINDING, MEASURED: THE LAYERS COULD NOT HAVE DONE THIS ----------
await showInside();
for (const layer of ['2', '4', '8', '16']) await page.click('[data-layer="' + layer + '"]');
await page.waitForSelector('.dcanvas');
s = await snap();
check('physical alone still draws more than the device (the mask thins, it does not fold)',
  s.boxes.length > 1 && s.boxes.some(b => b.kind === 'Interface'),
  s.boxes.length + ' boxes with only physical on: ' +
  Object.entries(s.boxes.reduce((m, b) => (m[b.kind] = (m[b.kind] || 0) + 1, m), {}))
    .map(e => e.join(' ')).join(', '));
check('and no box collapsed as a like-kind run — 0 collapsed in the note',
  !/collapsed/.test(s.note), s.note.slice(0, 120));
for (const layer of ['2', '4', '8', '16']) await page.click('[data-layer="' + layer + '"]');
await page.waitForSelector('.dcanvas');
await foldInside();

// ---- 5. A HAND-BUILT LAB HAS NOTHING INSIDE ITS BOXES, AND IS TOLD NOTHING ---
await open();
await addDevice('sw-core-01', 'switch');
await addDevice('ap-loft', 'access_point');
await toDiagram();
s = await snap();
check('two hand-added boxes draw as two boxes, as before', s.boxes.length === 2,
  s.boxes.length + ' boxes');
check('no control is offered, because nothing is behind it (`70` §19.4b)',
  s.toggle.length === 0 && s.insideMarks.length === 0 && !/inside/.test(s.band),
  JSON.stringify(s.toggle) + ' ' + s.band);
check('and the fit is the one this lab always had', s.zoom >= 1, s.zoom + '×');

// ---- 6. A LINK BETWEEN TWO INSIDES IS DRAWN BETWEEN THE TWO BOXES ------------
await open();
await paste(FIXTURE);
await paste(SECOND);
await toDiagram();
s = await snap();
check('two pasted devices open as two boxes', s.boxes.length === 2 &&
  s.boxes.every(b => b.kind === 'Device'), s.boxes.map(b => b.name).join(', '));
const rowA = s.rows.find(r => r.name === 'branch-srx');
const rowB = s.rows.find(r => r.name === 'branch-two');
check('each says what it holds — 46, and the interface, unit and address of the second',
  rowA && rowA.inside === '46' && rowB && rowB.inside === '3',
  JSON.stringify(s.rows.map(r => [r.name, r.inside])));
// The two interfaces, found through each device's own disclosure so the two
// `ge-0/0/0`s are told apart by the box they are inside of, not by list order.
const kidsA = await childrenOf(rowA.id);
const kidsB = await childrenOf(rowB.id);
const geA = kidsA.find(k => k.inside && k.name === 'ge-0/0/0');
const geB = kidsB.find(k => k.inside && k.name === 'ge-0/0/0');
check('both interfaces are reachable while folded', !!(geA && geA.link && geB && geB.link),
  JSON.stringify([geA, geB]));
// Holding an end that is folded into a box is refused in words that name the
// way out, never "select a box first" over a selection the reader just made.
await page.click('[data-dparent="' + rowA.id + '"][data-dlink="' + geA.link + '"]');
await page.click('[data-dhold]');
const refusal = await page.$eval('#fMsg', n => n.textContent);
check('holding an interface that is inside a box is refused, naming the control that draws it',
  /that Interface is inside a box at this rung — press show what is inside to connect from it, or hold the device instead/.test(refusal),
  refusal);
check('and nothing is held', (await page.$eval('[data-dhold]', n => n.getAttribute('aria-pressed'))) === 'false');
// With the insides shown, the two interfaces are boxes and the link is drawn
// exactly as `2026-08-16-hand-link-drive.mjs` draws one.
await showInside();
await objects();
await page.click('[data-drow="' + geA.link + '"]');
await page.click('[data-dhold]');
await objects();
await page.click('[data-drow="' + geB.link + '"]');
await page.click('[data-dlinkmode="1"]');
// The schema admits more than one edge between two interfaces, so the module
// asks and the page never guesses (2026-08-16). Answer `Link` if asked.
const ask = await page.$('[data-dlinkkind="Link"]');
if (ask) await ask.click();
await page.waitForSelector('.dcanvas');
const drewMsg = await page.$eval('#fMsg', n => n.textContent);
check('the link is drawn, interface to interface, with everything shown',
  /^drew a Link link between Interface and Interface — it is marked as drawn by hand$/.test(drewMsg), drewMsg);
let shown = await snap();
const allBoxes = 2 + 46 + 3;
check('and with everything shown it is one line among ' + allBoxes + ' boxes, marked by hand',
  shown.boxes.length === allBoxes && shown.handMarks.length === 1, shown.boxes.length + ' boxes, ' + JSON.stringify(shown.handMarks));
await foldInside();
s = await snap();
check('folded, the same link is drawn between the two DEVICE boxes, once',
  s.boxes.length === 2 && s.refLines === 1, s.boxes.length + ' boxes, ' + s.refLines + ' reference lines');
check('and it is still marked by hand', s.handMarks.length === 1 && s.handMarks[0] === 'by hand',
  JSON.stringify(s.handMarks));
const kidsA2 = await childrenOf(rowA.id);
const toB = kidsA2.find(k => !k.inside && k.link === rowB.id);
check('the Outline row under branch-srx says `to branch-two Link`, drawn by hand',
  !!toB && /^to/.test(toB.rel) && /Link/.test(toB.text) && /drawn by hand/.test(toB.text),
  toB ? toB.text : 'no row to branch-two');
check('the note says one line from inside a box is drawn to the box',
  /1 line from inside a box drawn to the box instead/.test(s.note), s.note.slice(0, 300));
const path = await page.$eval('.dline.dref', n => n.getAttribute('d'));
const devA = s.boxes.find(b => b.id === rowA.id), devB = s.boxes.find(b => b.id === rowB.id);
const face = await page.$eval('[data-dpost="' + rowA.id + '"] rect:last-of-type', r => +r.getAttribute('x') + +r.getAttribute('width'));
check('it leaves the right face of a device box (same column, `route.rs`\'s own channel) and is orthogonal',
  path.startsWith('M' + face + ' ') && path.trim().split(' L').length === 4 &&
  /^M(\d+) ([\d.]+) L(\d+) \2 L\3 ([\d.]+) L(\d+) \4 $/.test(path),
  path + ' · face x=' + face + ' · boxes at x=' + devA.x + ',' + devB.x);

// ---- 7. THROUGH A REAL RELOAD, FROM THE EXPORTED JOURNAL ---------------------
const download = await Promise.all([
  page.waitForEvent('download'),
  page.click('#tabExport'),
]).then(r => r[0]);
const saved = await download.path();
await open();
check('after a reload the estate is gone, as it always was',
  (await page.$$('.inv tbody tr')).length === 0);
await page.setInputFiles('#importFile', saved);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
await toDiagram();
s = await snap();
check('the reopened estate opens on its two devices, folded, at a readable zoom',
  s.boxes.length === 2 && s.boxes.every(b => b.kind === 'Device') && s.zoom >= 1,
  s.boxes.length + ' boxes at ' + s.zoom + '×');
check('with the hand-drawn link still between them and still marked',
  s.refLines === 1 && s.handMarks.length === 1, s.refLines + ' lines, ' + JSON.stringify(s.handMarks));
check('and the counts survive the round trip',
  s.rows.map(r => r.inside).sort().join(',') === '3,46', JSON.stringify(s.rows.map(r => [r.name, r.inside])));
await page.screenshot({ path: OUT + '/2026-09-04-the-diagram-opens-on-the-devices-two.png' });

// ---- the floor every driver here stands on --------------------------------
check('no page errors', errors.length === 0, errors.join(' | '));
// Four real loads of the page in this file (§1, §5, §6, §7), and nothing else.
check('every network request is the file itself, once per load — four loads, four requests',
  requests.length === 4 && requests.every(u => u === FILE), requests.join(' '));

await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
process.exit(failed ? 1 : 0);
