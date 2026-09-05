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
// FOUR MORE, ADDED 2026-09-05 AFTER A SKEPTIC ATTACKED THE FOLD and measured
// four defects in Chromium, each with a check here that FAILS on the build
// that shipped the fold (069896c) and passes after the repair: (1) §3 — at
// rung 4, and at the rack rung, the band read `46 inside the boxes, not
// drawn` over the very view that draws them; (2) §3 — `show what is inside`
// was on offer at both rungs and did nothing there; (3) §2 — with the control
// pressed the device's Outline row still carried `46 inside` and
// `data-dinside` while the picture's own mark was gone; (4) §5b — remove the
// device with the control pressed and the strip stayed `showing what is
// inside`, pressed, over a lab with nothing inside it. §5b's last check is
// the invariant that makes the repair honest: a later paste brings the
// control back pressed AND the picture agrees with it.
//
// AND THE NOTE, ADDED 2026-09-05 AFTER A SKEPTIC ATTACKED THAT REPAIR (ad6f36c)
// and found the same class one panel over: at rung 4 and at the rack rung the
// Outline NOTE still ended "… 46 objects are inside the device boxes and not
// drawn beside them, with 14 links among them — press show what is inside to
// draw every one, or open a box's row for the list" (47 at the rack rung)
// beside a band that had just stopped saying so, and at 390×800 with the
// picture collapsed it named a control 069896c's rule had taken off screen.
// §3 reads the note the way a reader does — innerText, which leaves out what
// CSS has taken off screen — at both rungs; §3c does the same at 390×800
// collapsed, then opens the picture and requires the clause back in the band
// AND the note, so the gate is shown to be the collapsed state and not the
// width. The three depth/collapsed checks fail on ad6f36c; the open one
// passes on both, as a control must.
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
// A box put in a rack through the equipment sheet, exactly as
// `2026-08-21-rack-is-a-rung.mjs` does it: the sheet's `put a box in a rack`
// door, the form read by its labels, the chassis picked by its host's name.
// Placing a box lands the reader in that rack's rung (that driver's §4).
const placeInRack = async (rack, host, pos) => {
  await page.click('#tabEquip');
  await page.click('#rAdd');
  const map = await page.locator('#mform label').evaluateAll(
    ls => Object.fromEntries(ls.map(
      l => [l.textContent.replace(/ — required$/, '').trim(), l.getAttribute('for')])));
  await page.fill('#' + map['rack name'], rack);
  await page.fill('#' + map['rack height in units'], '10');
  await page.selectOption('#' + map['unit numbering'], 'ascending');
  await page.fill('#' + map['position — lowest unit the box occupies'], String(pos));
  const opts = await page.locator('#mfChassis option').evaluateAll(
    os => os.map(o => ({ v: o.value, t: o.textContent })));
  await page.selectOption('#mfChassis', (opts.find(o => o.t.includes(host)) || opts[0]).v);
  await page.click('#mRun');
};
// What a depth rung (or a collapsed picture) shows of the band, the two canvas
// controls and the Outline note: the band's words, the COMPUTED display of
// `show what is inside` and of the zoom group — both are built and then taken
// off screen by two adjacent CSS rules of one shape, so presence in the DOM is
// not the fact a reader sees — and the note as a READER sees it: innerText,
// which leaves out what CSS has taken off screen, where snap().note's
// textContent (right for the site rung's checks) would still carry it.
const atDepth = () => page.evaluate(() => {
  const shown = sel => {
    const n = document.querySelector(sel);
    return n ? getComputedStyle(n).display !== 'none' : null;
  };
  const note = document.querySelector('.dout .note');
  return { depth: document.querySelector('.dview').getAttribute('data-depth'),
           open: document.querySelector('.dview').getAttribute('data-open'),
           width: document.getElementById('sheet').getAttribute('data-width'),
           band: document.querySelector('.dband').textContent,
           inside: shown('[data-inside]'), zoom: shown('.dzoomctl'),
           note: note ? note.innerText : '' };
});
// The note's body as seen, without its lead line; for a check's detail.
const noteBody = n => n.split('\n').pop().slice(0, 170);
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
// Added 2026-09-05, from a skeptic's attack on the fold: with the control
// pressed the device row still carried `46 inside` as a `.docnt` span and
// `data-dinside="46"` — the idiom `N collapsed` / `N chassis` use for FOLDED
// things — while the picture's own mark was gone and the 46 were level-1 rows
// the disclosure no longer listed. dgOutline read the count with no `applied`
// test; dgExpand and the svg mark had one. This fails on that build.
const shownRow = await page.evaluate(id => {
  const r = document.querySelector('[data-drow="' + id + '"]');
  return { inside: r.getAttribute('data-dinside'),
           counts: [...r.querySelectorAll('.docnt')].map(n => n.textContent) };
}, deviceId);
check('and the device ROW agrees with the picture: no `46 inside`, no data-dinside, while the 46 are rows of their own (the row kept both)',
  shownRow.inside === null && !shownRow.counts.some(t => /inside/.test(t)),
  JSON.stringify(shownRow));
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
// Added 2026-09-05, from the same attack, both measured at rung 4: (1) the
// band read `1 object · 0 links · 46 inside the boxes, not drawn · inside a
// box — escape comes back out` over the one view that draws exactly those
// 46 — dgBand gated its `labels off` clauses on `away` for precisely this,
// and the fold clause was not; (2) `show what is inside` sat in the strip,
// pressing it changed nothing on screen (#ibody 101 → 101 nodes), the footer
// said `drawing what is inside the boxes beside them`, and the change showed
// only after Escape. Now off screen by the rule that takes `.dzoomctl` off
// there, and measured the way that rule works: computed display, both
// controls, one answer. Both checks fail on that build.
const r4 = await atDepth();
check('at rung 4 the band does not say `46 inside the boxes, not drawn` over the view that draws them (it did)',
  r4.depth === 'device' && /inside a box — escape comes back out/.test(r4.band) &&
  !/inside the boxes, not drawn/.test(r4.band), r4.band);
check('and `show what is inside` is off screen there, by the rule that takes the zoom controls off (it was in the strip)',
  r4.inside === false && r4.zoom === false, JSON.stringify({ inside: r4.inside, zoom: r4.zoom }));
// Added 2026-09-05, after a skeptic attacked THAT repair (ad6f36c) and found
// the same class one panel over: with the band and the strip honest at rung 4
// the Outline note beside them still ended "… 46 objects are inside the device
// boxes and not drawn beside them, with 14 links among them — press show what
// is inside to draw every one, or open a box's row for the list" — a count for
// the picture one rung up, naming a control the rule above had just hidden.
// The band drops that whole clause at depth; the note now does too, whole, by
// the same CSS rule that hides the control. Read as a reader reads it
// (innerText); the note's own first clause is the proof it is still on screen
// and the check is not vacuous. Fails on ad6f36c.
check('and the Outline NOTE beside them drops its fold clause too — no count of what one rung up folds, no `press show what is inside` (it kept both)',
  /standing for/.test(r4.note) && !/inside the device boxes/.test(r4.note) &&
  !/show what is inside/.test(r4.note), noteBody(r4.note));
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('.dview').getAttribute('data-depth') === 'site');
s = await snap();
check('and Escape comes back out to the one box', s.boxes.length === 1 && s.depth === 'site',
  s.boxes.length + ' at ' + s.depth);
// And the rack rung, the other depth the same gate and the same rule cover
// (added 2026-09-05 with the two above). A box added by hand and put in a
// rack, which lands the reader in that rack; the pasted firewall is still on
// the estate with its 46 inside, so the band and the strip have the same two
// things to get wrong here. Both fail on the build the two above fail on.
await addDevice('sw-rack-01', 'switch');
await placeInRack('R1', 'sw-rack-01', 1);
await page.waitForFunction(() => document.querySelector('.dview') &&
  document.querySelector('.dview').getAttribute('data-depth') === 'rack');
const rk = await atDepth();
check('at the rack rung the band says `inside a rack` and never `inside the boxes, not drawn` (it said both)',
  rk.depth === 'rack' && /inside a rack — escape comes back out/.test(rk.band) &&
  !/inside the boxes, not drawn/.test(rk.band), rk.band);
check('and `show what is inside` is off screen there too, with the zoom controls (it was offered)',
  rk.inside === false && rk.zoom === false, JSON.stringify({ inside: rk.inside, zoom: rk.zoom }));
// The note at the rack rung, the same way (added 2026-09-05 with the rung-4
// check above): it read "… 47 objects are inside the device boxes … press show
// what is inside …" over an elevation. Fails on ad6f36c.
check('and the Outline NOTE at the rack rung drops its fold clause as well — no `47 … inside the device boxes`, no `press show what is inside` (it kept both)',
  /standing for/.test(rk.note) && !/inside the device boxes/.test(rk.note) &&
  !/show what is inside/.test(rk.note), noteBody(rk.note));
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('.dview').getAttribute('data-depth') === 'site');
s = await snap();
// 47, not 46: the box just placed has a rack-mounted chassis, which the
// chassis fold declines (its mount line would vanish) and rung 1's fold
// takes, with the mount line re-homed — 069896c's own note. A true count.
check('and back at the site rung the band says it again — 47 now, the rack-mounted chassis included — and the control is back',
  /\b47 inside the boxes, not drawn\b/.test(s.band) && s.toggle.length === 1 &&
  (await atDepth()).inside === true, s.band);

// ---- 3c. 390×800, THE PICTURE COLLAPSED: THE NOTE AGREES WITH THE BAND ------
// Added 2026-09-05 with the two note checks above. At narrow width the canvas
// is collapsed to a summary line until `show the picture` is pressed (`55`
// §6.3); 069896c's rule takes `show what is inside` off screen while it is,
// and ad6f36c made the band drop its fold clause there (`shut`). The note kept
// it — a count for a drawing that is not on screen, naming a control that is
// not on screen. The Outline row still carries the count (`data-dinside`),
// which is why the clause can go whole rather than lose only its instruction.
// Then the picture is opened and the clause must come BACK on both surfaces:
// the gate is the collapsed state, not the width. The first check fails on
// ad6f36c; the second passes on both, as a control must. The viewport goes
// back to 1400×900 afterwards, so §4 onward measures what it always did.
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForFunction(() => document.getElementById('sheet').getAttribute('data-width') === 'narrow');
const nw = await atDepth();
// The rows, summed: the band's 47 is 46 under branch-srx plus the rack-mounted
// switch's chassis under ITS row, so no one row says 47 and the sum is the
// fact (the first cut of this check read one row and failed on its own
// arithmetic, 2026-09-05 — recorded so nobody "fixes" it back).
const nwRows = await page.$$eval('[data-drow]', rs => rs.reduce(
  (t, r) => t + (+r.getAttribute('data-dinside') || 0), 0));
check('at 390×800 with the picture collapsed the note drops its fold clause as the band does — the control it names is off screen, and the rows still carry the 47 between them (the note kept the clause)',
  nw.width === 'narrow' && nw.open === '0' && nw.inside === false &&
  /picture collapsed at this width/.test(nw.band) && !/not drawn/.test(nw.band) &&
  /standing for/.test(nw.note) && !/inside the device boxes/.test(nw.note) &&
  !/show what is inside/.test(nw.note) && nwRows === 47,
  JSON.stringify({ band: nw.band, note: noteBody(nw.note), rowsInside: nwRows, inside: nw.inside }));
await page.click('[data-dexpand]');
await page.waitForFunction(() => document.querySelector('.dview').getAttribute('data-open') === '1');
const nwOpen = await atDepth();
check('and opening the picture brings the clause back on BOTH surfaces — band `47 inside the boxes, not drawn`, note `press show what is inside`, control on screen — so the gate is the collapsed state, not the width',
  nwOpen.open === '1' && nwOpen.inside === true &&
  /\b47 inside the boxes, not drawn\b/.test(nwOpen.band) &&
  /47 objects are inside the device boxes and not drawn beside them/.test(nwOpen.note) &&
  /press show what is inside/.test(nwOpen.note),
  JSON.stringify({ band: nwOpen.band, inside: nwOpen.inside, note: noteBody(nwOpen.note) }));
await page.click('[data-dexpand]');
await page.waitForFunction(() => document.querySelector('.dview').getAttribute('data-open') === '0');
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForFunction(() => document.getElementById('sheet').getAttribute('data-width') === 'wide');

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

// ---- 5b. A PRESSED CONTROL WITH NOTHING BEHIND IT ---------------------------
// Added 2026-09-05, from the same attack: paste the SRX, press `show what is
// inside`, remove the device, and the strip still read `showing what is
// inside`, aria-pressed=true, over a hand-added switch with nothing inside
// it. The build test was `objects > 0 || S.inside`, the second half "so that
// what it did can be undone" — and with nothing folded there is nothing to
// undo. Now `objects > 0` only. `S.inside` stays true in session state, and
// the last check is the invariant that makes that honest: a later paste
// brings the control back PRESSED and the picture already agrees with it.
// The "no control" check fails on that build.
await open();
await paste(FIXTURE);
await addDevice('sw-core-01', 'switch');
await toDiagram();
await showInside();
s = await snap();
const srxRow = s.rows.find(r => r.name === 'branch-srx');
check('a firewall shown beside a hand-added switch: 48 boxes, the control pressed',
  s.boxes.length === 48 && s.toggle.length === 1 && s.toggle[0].pressed === 'true' && !!srxRow,
  s.boxes.length + ' boxes, ' + JSON.stringify(s.toggle));
await objects();
await page.click('[data-drow="' + srxRow.id + '"]');
await page.click('[data-remove]');
await page.waitForFunction(() => document.querySelectorAll('.dbox').length === 1);
s = await snap();
check('removing the firewall leaves the switch alone — one box, nothing inside it',
  s.boxes.length === 1 && s.boxes[0].name === 'sw-core-01' && s.insideMarks.length === 0,
  s.boxes.map(b => b.name).join(', '));
check('and no control is offered over it (it stayed: `showing what is inside`, pressed, over nothing)',
  s.toggle.length === 0 && !/inside/.test(s.band) && !/inside/.test(s.note),
  JSON.stringify(s.toggle) + ' · ' + s.band);
await paste(SECOND);
await toDiagram();
s = await snap();
check('a later paste brings insides: the control comes back pressed and the picture agrees — the 3 drawn beside their device, no fold mark',
  s.toggle.length === 1 && s.toggle[0].text === 'showing what is inside' &&
  s.toggle[0].pressed === 'true' && s.boxes.length === 5 && s.insideMarks.length === 0 &&
  /showing the 3 objects inside the device boxes beside them/.test(s.note),
  s.boxes.length + ' boxes, ' + JSON.stringify(s.toggle) + ' · ' + s.note.slice(0, 160));

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
// Five real loads of the page in this file (§1, §5, §5b, §6, §7), and nothing else.
check('every network request is the file itself, once per load — five loads, five requests',
  requests.length === 5 && requests.every(u => u === FILE), requests.join(' '));

await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
process.exit(failed ? 1 : 0);
