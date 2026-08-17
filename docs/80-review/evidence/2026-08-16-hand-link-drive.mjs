// DRAWING A LINK BY HAND, driven through the shipped artifact, in Chromium,
// ASSERTING ON THE DOM and on the ACCESSIBLE TREE. The screenshots beside this
// file are not the evidence; these assertions are.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-16-hand-link-drive.mjs [repo-root]
//
// The question this file exists to answer is the owner's whole brief: "as long
// as I could design my network and servers for my home lab as a example that's
// all that matters". Designing a network means CONNECTING things. Before
// `OP_LINK` a person could add a box, name it, correct it, move it, rack it and
// remove it — and could not connect it to anything, so a hand-built lab was a
// pile of unconnected boxes and a diagram of unconnected boxes is not a network
// diagram.
//
// So this starts from a genuinely EMPTY page: no paste, no fixture, no demo
// estate. Two devices typed into the equipment sheet, connected by pointing at
// both, and then the round trip — because "connected" is a claim about the
// RECORD, not about the next paint. Export the journal, throw the page away
// entirely (a real reload, new WebAssembly instance and all), import the file,
// and the link has to still be there.
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
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  acceptDownloads: true,
});

const requests = [];
page.on('request', r => requests.push(r.url()));
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// ---- helpers reading the DOM, never page internals ---------------------------

// Every connection row the Outline shows for a box, read after EXPANDING it
// with the keyboard.
//
// The rows are built on disclosure — `dgExpand` inserts them as siblings when a
// treeitem opens — so a driver that queried `.dolink` on a closed tree would
// find nothing and call it "no link", which is the one wrong answer this whole
// file exists to distinguish from the right one. It failed exactly that way on
// its first run and the assertion was green, which is worth recording: an
// absence read from an unopened disclosure is not evidence of absence.
//
// The Outline is where the fact has to live: the <svg> is aria-hidden, so a
// mark that exists only in the picture is a mark announced to nobody.
const outlineLinks = async id => {
  await page.evaluate(sel => {
    const row = document.querySelector('[data-drow="' + sel + '"]');
    if (!row) return;
    row.focus();
    if (row.getAttribute('aria-expanded') !== 'true') {
      row.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'ArrowRight', bubbles: true }));
    }
  }, id);
  await page.waitForTimeout(60);
  return page.evaluate(sel =>
    [...document.querySelectorAll('[data-dparent="' + sel + '"]')]
      .map(r => r.textContent), id);
};

// The picture's own count of hand-drawn strokes, from the class the painter
// puts on the path. Asserted alongside the Outline so a page that marked one
// and not the other is caught.
const handStrokes = () => page.$$eval('.dhand', ns => ns.length);

const footer = () => page.$eval('#fMsg', n => n.textContent);

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

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// ---- A HOME LAB, TYPED FROM AN EMPTY PAGE ------------------------------------
check('the page starts with no estate at all',
  (await page.$$('.inv tbody tr')).length === 0);

await addDevice('switch-lab-01', 'switch');
await addDevice('fw-lab-01', 'firewall');
await page.click('[data-view="diagram"]');
// TWO devices are TWO boxes. It was four until 2026-08-17: every hand-added
// device also writes a Chassis and the picture drew it as a second box, which
// is what the owner meant by "why does creating a piece of equipment have 2
// things listed vs just one?". The chassis is now a row under its device.
await page.waitForFunction(() => document.querySelectorAll('.dbox').length >= 2);

const rows = await deviceRows();
const sw = rows.find(r => /switch-lab-01/.test(r.text));
const fw = rows.find(r => /fw-lab-01/.test(r.text));
check('two devices typed by hand are two boxes in the picture',
  !!sw && !!fw, (sw && sw.id) + '  ' + (fw && fw.id));

// THE GAP THIS FEATURE CLOSES, stated as an assertion so it cannot be assumed.
const before = await outlineLinks(sw.id);
check('and NOTHING connects them — this is the pile of unconnected boxes',
  !before.some(t => /PeersWith/.test(t)),
  before.length + ' connection rows, none between the two devices');
// Culled from 40 words to 12 on 2026-08-17, and renamed with the controls it
// names: the paragraph explaining that a link is graph data no paste can
// rebuild is this driver's subject, not something to print on every render.
// What survives is the instruction, in the buttons' own current words.
check('the note names the gesture in the controls\' own words',
  (await page.$$eval('.dout .note', ns => ns.map(n => n.textContent).join(' ')))
    .includes('Press connect from here on one box, select another, and connect them'));

await page.screenshot({ path: OUT + '/2026-08-16-link-before.png' });

// ---- DRAW THE LINK, WITH THE KEYBOARD ---------------------------------------
// `55` §4.5.2 puts focus in the Outline and never in the <svg>, so a drag from
// one shape to another is a gesture half the contract cannot perform. The
// buttons ARE the interface, and they are driven WITH THE KEYBOARD here — Tab
// to them, press Enter — because "a keyboard can do it" is a claim about keys,
// not about a programmatic click.
await page.click('[data-drow="' + sw.id + '"]');
await page.focus('[data-dhold]');
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
check('holding one end is announced as a mode, not just in the footer',
  await page.$eval('[data-dhold]', b => b.getAttribute('aria-pressed')) === 'true',
  await footer());

await page.click('[data-drow="' + fw.id + '"]');
await page.focus('[data-dlinkmode="1"]');
await page.keyboard.press('Enter');
await page.waitForTimeout(150);

const after = await outlineLinks(sw.id);
check('THE TWO DEVICES ARE CONNECTED',
  after.some(t => /PeersWith/.test(t)),
  after.filter(t => /PeersWith/.test(t)).join(' | ') || 'no PeersWith row');

// THE SCHEMA CHOSE, AND THE OPERATOR WAS NOT ASKED. Exactly one reference edge
// runs between two Devices, so a menu of one would be a question with no
// content. `fathom-weld/tests/hand_links.rs` proves the "exactly one" from the
// other side of the boundary.
check('and the operator was not asked which kind, because only one is legal',
  (await footer()).includes('PeersWith') && !(await footer()).includes('pick one'),
  await footer());

// ---- THE PICTURE SAYS A PERSON DREW IT ---------------------------------------
check('the picture marks the stroke', (await handStrokes()) >= 1,
  (await handStrokes()) + ' hand strokes');
check('and the word, which survives forced colours and being read aloud',
  await page.$$eval('.dhandmark', ns => ns.some(t => t.textContent === 'by hand')));
check('`51` §9 is respected: no dashed or dotted stroke anywhere in the picture',
  await page.evaluate(() => [...document.querySelectorAll('.dline')].every(p => {
    const s = getComputedStyle(p).strokeDasharray;
    return !s || s === 'none';
  })),
  'dashed is reserved for AI-proposed, dotted for unanswered-required');
check('the note counts it',
  (await page.$$eval('.dout .note', ns => ns.map(n => n.textContent).join(' ')))
    .includes('1 line was drawn by hand'));

// THE ACCESSIBLE TREE, not the DOM. The <svg> is aria-hidden, so the word and
// the stroke above are announced to nobody; the Outline row is the only place a
// screen reader can learn who drew this line. The bar is
// `2026-08-15-diagram-aggregation-ax.mjs`, set after a whole disclosure
// contract was declared on SVG nodes and announced to no one.
await outlineLinks(sw.id);
const ax = await page.accessibility.snapshot({ interestingOnly: false });
const flat = [];
(function walk(n) { if (!n) return; flat.push(n); (n.children || []).forEach(walk); })(ax);
const spoken = flat.filter(n => /drawn by hand/.test(n.name || '')).map(n => n.name);
check('and the ACCESSIBLE TREE carries it, because the <svg> does not',
  spoken.some(n => /PeersWith/.test(n)), spoken.join(' | ') || 'not found');
// The converse, and it is the assertion that gives the mark its meaning: the
// CONTAINMENT rows in the same tree are NOT marked. Every edge in a hand-built
// estate is `Origin::Hand`, so a mark that tested origin alone would appear on
// all of them and distinguish nothing. `route::hand_drawn` carries the
// reasoning; this is the measurement that produced it.
check('and containment rows are NOT marked, so the mark still means something',
  flat.filter(n => /HasChassis/.test(n.name || ''))
      .every(n => !/drawn by hand/.test(n.name || '')),
  flat.filter(n => /HasChassis/.test(n.name || '')).map(n => n.name).join(' | '));

await page.screenshot({ path: OUT + '/2026-08-16-link-drawn.png' });

// ---- PRESSING IT TWICE IS NOT TWO FACTS --------------------------------------
await page.click('[data-drow="' + sw.id + '"]');
await page.click('[data-dhold]');
await page.click('[data-drow="' + fw.id + '"]');
await page.click('[data-dlinkmode="1"]');
await page.waitForTimeout(150);
check('drawing the same link twice leaves one line',
  (await outlineLinks(sw.id)).filter(t => /PeersWith/.test(t)).length === 1,
  'one row under each end, so one under the switch');
check('and one stroke in the picture', (await handStrokes()) === 1);

// ---- A PAIR THE SCHEMA DOES NOT JOIN -----------------------------------------
// A device and a chassis are joined by CONTAINMENT and by nothing else, and
// containment is never offerable — a node has exactly one parent and the weld
// computes it from the kind pair alone. The refusal must be a SENTENCE, never a
// Rust error, and it must name both kinds.
// The chassis is no longer a TOP-LEVEL Outline row — it is the folded child row
// under its device, so it is reached by opening that disclosure. Order matters:
// the hold click re-renders and rebuilds the Outline, so the disclosure has to
// be opened AFTER it, never before.
await page.click('[data-drow="' + sw.id + '"]');
await page.click('[data-dhold]');
await outlineLinks(sw.id);
const chassisRow = await page.$('.dofold[data-dparent="' + sw.id + '"]');
if (chassisRow) {
  await page.click('.dofold[data-dparent="' + sw.id + '"]');
  await page.click('[data-dlinkmode="1"]');
  await page.waitForTimeout(150);
  const msg = await footer();
  check('a pair with no legal edge is refused, naming both kinds',
    /nothing in the schema connects a \w+ to a \w+/.test(msg), msg);
  check('and the refusal is English, not a Rust error',
    !/\{|WriteError|Err\(/.test(msg), msg);
} else {
  check('a pair with no legal edge is refused, naming both kinds', false,
    'no chassis row found — the fixture changed');
}

// ---- EXPORT, RELOAD, IMPORT --------------------------------------------------
// THE ASSERTION THIS WHOLE FILE IS FOR. A hand-drawn link that does not survive
// a round trip is not degraded, it is DELETED: no paste can rebuild it, because
// no config ever said it. The rack shipped writing to the module and not to the
// journal and an export dropped every rack in silence; that is twice now.
const download = await Promise.all([
  page.waitForEvent('download'),
  page.click('#tabExport'),
]).then(r => r[0]);
const saved = await download.path();
const doc = JSON.parse(readFileSync(saved, 'utf8'));
const linkOps = doc.ops.filter(o => o.op === 'link');
check('the export carries the link as an op', linkOps.length >= 1,
  linkOps.length + ' link ops of ' + doc.ops.length);
check('with the clock and entropy that made it, and both ends',
  linkOps.every(o => typeof o.at === 'number' && typeof o.ent === 'string' &&
                     typeof o.from === 'string' && typeof o.to === 'string'),
  JSON.stringify(linkOps[0] || {}));
// THE KIND BY NAME, not by an index into EdgeKind::ALL. An exported journal
// outlives the build that wrote it, and an ordinal is a number whose meaning
// moves the next time `schema/` declares an edge.
check('and the edge kind BY NAME, which is stable across schema versions',
  linkOps.every(o => o.kind === 'PeersWith'),
  linkOps.map(o => o.kind).join(','));

// A REAL RELOAD. Not a soft reset: the document, the WebAssembly instance and
// every scrap of page state go away, which is the only honest way to ask
// whether the link lives in the record or in a variable.
await page.goto('about:blank');
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
check('after a reload the estate is gone, as it always was',
  (await page.$$('.inv tbody tr')).length === 0);

await page.setInputFiles('#importFile', saved);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
await page.click('[data-view="diagram"]');
await page.waitForFunction(() => document.querySelector('.dbox') !== null);

// The ids are re-derived from the reopened page rather than reused. They HAPPEN
// to be identical — the replay uses each op's own recorded clock and entropy, so
// the mint produces the same ULIDs — but a driver that assumed that would be
// asserting its own arithmetic instead of the product's.
const rows2 = await deviceRows();
const sw2 = rows2.find(r => /switch-lab-01/.test(r.text));
const fw2 = rows2.find(r => /fw-lab-01/.test(r.text));
check('the reopened workspace has the same two boxes, under the same ids',
  !!sw2 && !!fw2 && sw2.id === sw.id && fw2.id === fw.id,
  (sw2 && sw2.id) + '  vs  ' + sw.id);

const reopened = await outlineLinks(sw2.id);
check('THE LINK SURVIVED THE EXPORT AND THE IMPORT',
  reopened.some(t => /PeersWith/.test(t)),
  reopened.filter(t => /PeersWith/.test(t)).join(' | ') || 'GONE');
check('and it is still marked as drawn by hand, not silently demoted to parsed',
  (await handStrokes()) === 1 &&
  await page.$$eval('.dhandmark', ns => ns.some(t => t.textContent === 'by hand')),
  (await handStrokes()) + ' hand strokes');

await page.screenshot({ path: OUT + '/2026-08-16-link-reopened.png' });

// ---- CUTTING IT --------------------------------------------------------------
// "Removing a link must be possible too, or the first mistake is permanent."
await page.click('[data-drow="' + sw2.id + '"]');
await page.click('[data-dhold]');
await page.click('[data-drow="' + fw2.id + '"]');
await page.click('[data-dlinkmode="0"]');
await page.waitForTimeout(150);
check('a link can be cut', !(await outlineLinks(sw2.id)).some(t => /PeersWith/.test(t)),
  await footer());
check('and the picture has no hand stroke left', (await handStrokes()) === 0);

// A second cut says there is nothing there rather than pretending to work.
await page.click('[data-drow="' + sw2.id + '"]');
await page.click('[data-dhold]');
await page.click('[data-drow="' + fw2.id + '"]');
await page.click('[data-dlinkmode="0"]');
await page.waitForTimeout(150);
// AND WITHOUT MACHINERY IN IT. `replyProblem` renders an unexpected refusal as
// `the module refused: code 15 · ...`, which is right for a defect and wrong for
// an ordinary answer to an ordinary question. A network engineer reading `code
// 15` has been handed a Rust error with the words changed.
const cutMsg = await footer();
check('cutting a link that is not there says so', /no such link/.test(cutMsg), cutMsg);
check('and says it without an error code in the sentence',
  !/code \d/.test(cutMsg) && !/module refused/.test(cutMsg), cutMsg);

// A cut is a TOMBSTONE, not a delete, so redrawing has to work — the store
// counts live edges only.
await page.click('[data-drow="' + sw2.id + '"]');
await page.click('[data-dhold]');
await page.click('[data-drow="' + fw2.id + '"]');
await page.click('[data-dlinkmode="1"]');
await page.waitForTimeout(150);
check('a cut link can be drawn again, because a cut is a tombstone',
  (await outlineLinks(sw2.id)).some(t => /PeersWith/.test(t)), await footer());

// ---- the invariants that hold whatever this feature does ---------------------
check('exactly one network request, the file itself, both loads',
  requests.filter(u => u !== 'about:blank').every(u => u === FILE),
  requests.length + ' requests');
check('no page errors and no console errors', errors.length === 0,
  errors.join(' | '));

const bad = results.filter(r => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
await browser.close();
process.exit(bad.length ? 1 : 0);
