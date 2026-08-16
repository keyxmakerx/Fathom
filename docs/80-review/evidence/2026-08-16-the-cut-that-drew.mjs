// THE CUT THAT DREW — driven through the shipped artifact, in Chromium.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-16-the-cut-that-drew.mjs [repo-root]
//
// Two defects with one root cause. `DG_ASK` recorded the pair and the candidate
// kinds and NOT the verb that raised the question, so the chooser's click arm
// had nothing to read and used a literal `1` — draw. The consequences:
//
//   1. Pressing "cut the link", being asked which one, and answering CREATED a
//      brand-new edge. The gesture whose entire purpose is to remove a fact
//      asserted one instead — journalled, exported, permanent, and announced
//      only by a past-tense sentence in the footer after the fact.
//   2. Its corollary: a link of an ambiguous kind could NEVER be cut, because
//      every cut re-asked and every answer drew. Each attempt to remove one
//      line added another.
//
// Both were invisible to `2026-08-16-hand-link-drive.mjs`, which drives the
// unambiguous path only, and neither shows up in a unit test: the module is
// correct at both ends and the page is what guessed. This file drives the
// ambiguous pair — `IpsecVpn` → `LogicalUnit`, which a pasted `bind-interface`
// builds — through the chooser in both directions.
//
// The fix is that the mode travels with the question, and it is also the reason
// the cut path now asks the GRAPH what is live rather than the schema what is
// legal: a "which link do you want to cut" question offering a kind that does
// not exist between those two is a question with wrong answers in it.
//
// Playwright and Chromium are the ones already on this machine; neither is a
// dependency of the product and neither is in Cargo.lock (gate zero).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';

// A real SRX fragment, not a fixture: `bind-interface st0.0` under an ipsec vpn
// is the ordinary way a route-based tunnel is written, and it is what puts an
// `IpsecVpn` and a `LogicalUnit` on the same canvas.
const CFG = `set system host-name srx-cut-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security ike gateway gw-hq address 198.51.100.10
set security ipsec vpn hq-vpn ike gateway gw-hq
set security ipsec vpn hq-vpn bind-interface st0.0
`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({
  viewport: { width: 1500, height: 950 },
  acceptDownloads: true,
});
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.click('#tabPaste');
await page.fill('#pta', CFG);
await page.click('#pRun');
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
await page.click('[data-view="diagram"]');
await page.waitForSelector('.dcanvas svg');
await page.waitForTimeout(400);

// ---- helpers, reading the DOM and nothing else --------------------------------
//
// `DG` lives inside the page's IIFE and is not reachable from a driver, which is
// correct and is why every assertion below is on rendered attributes. The three
// controls are told apart by their data attributes, never by their text: "hold
// this end" carries `data-dhold`, and the two verbs carry `data-dlinkmode` 1 and
// 0. An earlier draft of this file looked for the hold button among
// `[data-dlinkmode]`, found nothing, silently held nothing, and every assertion
// after it was measuring an empty gesture.
const rowFor = frag => page.evaluate(f => {
  const r = [...document.querySelectorAll('[data-drow]')]
    .find(x => x.textContent.includes(f));
  return r ? r.getAttribute('data-drow') : null;
}, frag);

const hold = () => page.click('[data-dhold]');
const verb = m => page.click('[data-dlinkmode="' + m + '"]');
const kinds = () => page.$$eval('[data-dlinkkind]',
  n => n.map(x => x.getAttribute('data-dlinkkind')));
const askLabel = () => page.evaluate(() => {
  const g = document.querySelector('[aria-label*="which"]');
  return g ? g.getAttribute('aria-label') : '(no chooser)';
});
// A hand-drawn line's mark in the picture. `55` §1.4's rule — a state only a
// mouse can see is not a state — is why the Outline carries it too, but the
// count of drawn lines is what tells a draw from a cut.
const handLines = () => page.$$eval('.dhand', n => n.length);
const footer = () => page.$eval('#fMsg', n => n.textContent.trim());

const vpn = await rowFor('hq-vpn');
const unit = await rowFor('st0.0');
check('the ambiguous pair is on the canvas', !!vpn && !!unit,
  (vpn || 'no vpn') + ' + ' + (unit || 'no unit'));

const drawnByThePaste = await handLines();
check('the paste drew no hand links', drawnByThePaste === 0, String(drawnByThePaste));

// ---- 1. DRAW: the question is asked, and it says DRAW --------------------------
await page.click('[data-drow="' + vpn + '"]');
await hold();
await page.click('[data-drow="' + unit + '"]');
await verb(1);
await page.waitForTimeout(200);

const drawKinds = await kinds();
check('drawing an ambiguous pair asks which kind', drawKinds.length > 1,
  JSON.stringify(drawKinds));
const drawAsk = await askLabel();
check('and the question names the verb that raised it — DRAW',
  /draw/i.test(drawAsk) && !/cut/i.test(drawAsk), drawAsk);

check('both kinds the schema admits are offered',
  drawKinds.includes('BindsInterface') && drawKinds.includes('MonitorSource'),
  JSON.stringify(drawKinds));

// `BindsInterface` is the one the PASTE already wrote — `bind-interface st0.0`.
// Drawing it again is a no-op that SUCCEEDS, which is right: "these two are
// connected" is a statement about the end state. What is not right, and is what
// this assertion pins, is claiming to have drawn it. The module answers `2` in
// the reply's written slot, the page says which happened, and the picture keeps
// no hand mark — because that line is the parser's, not a person's.
await page.click('[data-dlinkkind="BindsInterface"]');
await page.waitForTimeout(250);
check('drawing a link the paste already made claims no hand mark',
  (await handLines()) === 0 && /already have a BindsInterface/.test(await footer()),
  (await handLines()) + ' hand line(s) · ' + (await footer()));

// ---- 2. DRAW the other one, which is genuinely new ----------------------------
await page.click('[data-drow="' + vpn + '"]');
await hold();
await page.click('[data-drow="' + unit + '"]');
await verb(1);
await page.waitForTimeout(200);
await page.click('[data-dlinkkind="MonitorSource"]');
await page.waitForTimeout(250);
check('answering with a free kind draws exactly one link',
  (await handLines()) === 1, (await handLines()) + ' hand line(s)');

// ---- 3. CUT: the same pair, the other verb ------------------------------------
//
// THIS IS THE BLOCKER. Two kinds are now LIVE between these two — one from the
// paste, one drawn by hand — so the cut is ambiguous and must ask. Before the
// fix the count went 1 → 2 here: the chooser answered "draw" to a question
// raised by "cut", and the gesture meant to remove a line added one.
await page.click('[data-drow="' + vpn + '"]');
await hold();
await page.click('[data-drow="' + unit + '"]');
const before = await handLines();
await verb(0);
await page.waitForTimeout(250);
const afterAsking = await handLines();
check('PRESSING CUT DOES NOT DRAW', afterAsking === before,
  before + ' → ' + afterAsking + ' hand line(s)');

const cutKinds = await kinds();
check('the cut is ambiguous and asks', cutKinds.length === 2, JSON.stringify(cutKinds));
check('and the question names the verb that raised it — CUT',
  /cut/i.test(await askLabel()) && !/draw/i.test(await askLabel()), await askLabel());
// The cut chooser asks the GRAPH what is live, not the schema what is legal —
// so a kind the schema admits but nothing has written is never offered as
// something to remove.
check('the cut chooser offers only kinds the schema also admits',
  cutKinds.every(k => drawKinds.includes(k)),
  'cut ' + JSON.stringify(cutKinds) + ' vs draw ' + JSON.stringify(drawKinds));

// ---- 4. and the answer CUTS ---------------------------------------------------
//
// THE SECOND BLOCKER, from the other side: before the fix a link of an
// ambiguous kind could never be cut at all, because every attempt re-asked and
// every answer drew.
await page.click('[data-dlinkkind="MonitorSource"]');
await page.waitForTimeout(250);
check('A LINK OF AN AMBIGUOUS KIND CAN BE CUT', (await handLines()) === 0,
  (await handLines()) + ' hand line(s) left · ' + (await footer()));

// ---- 5. one kind left, so the next cut does not ask ---------------------------
await page.click('[data-drow="' + vpn + '"]');
await hold();
await page.click('[data-drow="' + unit + '"]');
await verb(0);
await page.waitForTimeout(250);
check('with one live kind left the cut does not ask',
  (await kinds()).length === 0, JSON.stringify(await kinds()));
check('and it still draws nothing', (await handLines()) === 0,
  (await handLines()) + ' hand line(s) · ' + (await footer()));

// ---- 6. now nothing joins them, and cutting says so ---------------------------
await page.click('[data-drow="' + vpn + '"]');
await hold();
await page.click('[data-drow="' + unit + '"]');
await verb(0);
await page.waitForTimeout(250);
check('cutting nothing is refused in words, and draws nothing',
  (await handLines()) === 0 && (await footer()).length > 0 &&
    !/code \d/.test(await footer()),
  (await handLines()) + ' hand line(s) · ' + (await footer()));

// ---- 7. and the RECORD agrees with the sentences ------------------------------
//
// The journal is the file an operator keeps and a colleague reads. Over this
// whole run exactly two things were written by hand — one `MonitorSource` drawn
// and two cuts — and the no-op draw must have left NO trace, because an entry
// saying a person drew a line the parser read is a false provenance claim that
// replays into every future copy of the estate.
const download = await Promise.all([
  page.waitForEvent('download'),
  page.click('#tabExport'),
]).then(r => r[0]);
const doc = JSON.parse(readFileSync(await download.path(), 'utf8'));
const linkOps = doc.ops.filter(o => o.op === 'link');
check('the journal records the draw that happened and not the one that did not',
  linkOps.filter(o => o.mode === 1).length === 1 &&
    linkOps.filter(o => o.mode === 1)[0].kind === 'MonitorSource',
  JSON.stringify(linkOps.map(o => o.mode + ':' + o.kind)));
check('and both cuts, by name', linkOps.filter(o => o.mode === 0).length === 2,
  JSON.stringify(linkOps.filter(o => o.mode === 0).map(o => o.kind)));

check('no page errors', errors.length === 0, errors.join(' | '));

const pass = results.filter(r => r.ok).length;
console.log('\n' + pass + '/' + results.length + ' checks pass');
await browser.close();
process.exit(pass === results.length ? 0 : 1);
