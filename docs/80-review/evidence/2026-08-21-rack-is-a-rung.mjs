// `rack view` stops being a door — `57` §2 and §14.1's item A1, driven.
//
// THE DEFECT THIS CLOSES IS A CATEGORY ERROR. The band read `START HERE: paste
// a config / OR: add equipment / THEN: rack view`. The first two are HOW DATA
// GETS IN; the third was A WAY OF LOOKING AT DATA ALREADY THERE. It shipped on
// 2026-08-17 and the owner spotted it the same day, and the complaint opened the
// whole zoom-ladder design: "i want to be able to zoom that way into the boxes,
// and zoom out all the way until we are at site data".
//
// WHAT IS ASSERTED HERE IS THE LADDER, NOT THE ELEVATION. What the elevation
// DRAWS is `2026-08-15-rack-view-ax.mjs`'s 54 checks and none of it changed.
// This file asks the other question: is the rack reachable the right way, is
// the way back obvious, does a keyboard get both, and — the load-bearing half
// of `57` §2 — do the band, the masthead and the side panel STAY PUT while the
// chart area swaps what it draws.
//
//   node 2026-08-21-rack-is-a-rung.mjs
//
// Requires the artifact at target/artifact/fathom-dev.html.

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const artifact = resolve(here, '../../../target/artifact/fathom-dev.html');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function axFlat(node, out = []) {
  if (!node) return out;
  out.push({ role: node.role, name: node.name || '' });
  for (const c of node.children || []) axFlat(c, out);
  return out;
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();

const requests = [];
page.on('request', (r) => requests.push(r.url()));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto('file://' + artifact);
await page.waitForFunction(() => document.getElementById('tabEquip') !== null);

const depth = () => page.locator('.dview').getAttribute('data-depth');

async function addBox(hostname) {
  await page.click('#tabEquip');
  await page.waitForTimeout(60);
  await page.fill('#ef6', hostname);
  await page.selectOption('#ef7', 'junos-srx');
  await page.click('#eRun');
  await page.waitForTimeout(80);
}

async function place(rack, host, pos) {
  await page.click('#tabEquip');
  await page.waitForTimeout(60);
  await page.click('#rAdd');
  await page.waitForTimeout(80);
  const map = await page.locator('#mform label').evaluateAll(
    (ls) => Object.fromEntries(ls.map(
      (l) => [l.textContent.replace(/ — required$/, '').trim(), l.getAttribute('for')])));
  await page.fill('#' + map['rack name'], rack);
  await page.fill('#' + map['rack height in units'], '10');
  await page.selectOption('#' + map['unit numbering'], 'ascending');
  await page.fill('#' + map['position — lowest unit the box occupies'], String(pos));
  const opts = await page.locator('#mfChassis option').evaluateAll(
    (os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  await page.selectOption('#mfChassis', (opts.find((o) => o.t.includes(host)) || opts[0]).v);
  await page.click('#mRun');
  await page.waitForTimeout(250);
}

// The rack's own Outline row, found by the label the operator stencilled on the
// frame. Every use of this is also a test of the display-name fix below.
async function rackRow(label) {
  return await page.evaluate((name) => {
    const r = [...document.querySelectorAll('[data-drow]')]
      .find((x) => /Rack/.test(x.textContent) && x.textContent.includes(name));
    return r ? r.getAttribute('data-drow') : null;
  }, label);
}

// -------------------------------------------------------------------------
console.log('\n1. THE BAND IS TWO DOORS');
// -------------------------------------------------------------------------
const doors = await page.locator('.doors button').evaluateAll(
  (ns) => ns.map((n) => n.textContent.trim()));
check('two doors, not three', doors.length === 2, doors.join(' | '));
check('both are ways data gets IN',
  /paste a config/.test(doors[0]) && /add equipment/.test(doors[1]), doors.join(' | '));
check('`rack view` is not one of them', await page.locator('#tabRack').count() === 0);
// The kicker was the third rung of a three-part sequence. There is no third
// part, so `then` names nothing and goes with the door it introduced.
const kickers = await page.locator('.doors .dk').evaluateAll(
  (ns) => ns.map((n) => n.textContent.trim()));
check('the kickers are `start here` and `or`, and `then` is gone',
  kickers.join(',') === 'start here,or', kickers.join(','));
// The toolbar is one tab stop with arrow keys inside it (`53` §8.3), and it has
// to stay one after losing a member rather than quietly becoming two.
check('the doors are still ONE toolbar and one tab stop',
  await page.locator('.doors[role="toolbar"]').count() === 1
    && await page.locator('.doors button[tabindex="0"]').count() === 1);

// -------------------------------------------------------------------------
console.log('\n2. THE ONLY THING THAT CREATES A RACK IS STILL REACHABLE FROM AN EMPTY PAGE');
// -------------------------------------------------------------------------
// The locked-room test. Selecting a rack is how you see one — so if the only
// control that MAKES one lived behind a rack that already existed, the feature
// would be unreachable from a fresh page. It lives on the second door instead.
await page.click('#tabEquip');
await page.waitForTimeout(80);
check('`put a box in a rack` is in the add-equipment sheet',
  await page.locator('#esheet #rAdd').isVisible());
await page.click('#rAdd');
await page.waitForTimeout(100);
check('and it opens the placement form',
  await page.locator('#msheet').isVisible() && !(await page.locator('#esheet').isVisible()));
check('whose hint still says a rack is something you tell Fathom',
  /nothing in a pasted config says which rack/i.test(await page.locator('#mHint').innerText()),
  (await page.locator('#mHint').innerText()).slice(0, 160));
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check('escape from it unwinds ONE level, to the door that opened it (53 §3.7)',
  await page.locator('#esheet').isVisible() && !(await page.locator('#msheet').isVisible()));
await page.keyboard.press('Escape');
await page.waitForTimeout(100);

// -------------------------------------------------------------------------
console.log('\n3. A RACK IS A BOX IN THE PICTURE, AND IT CARRIES ITS OWN NAME');
// -------------------------------------------------------------------------
// `layers.rs` over-draws `Rack` and marks it untabled, so there has been
// something to click since ADR-0036 — and it drew as `rack:01M0J…` because
// `display_name` had no arm for the kind. You cannot select a frame you cannot
// tell from the frame beside it, so the ULID is this job's business.
await addBox('srx-a');
await place('R12', 'srx-a', 3);
const r12 = await rackRow('R12');
check('the rack is drawn and its Outline row reads R12, not a ULID',
  !!r12 && !/rack:01/.test(await page.locator('[data-drow="' + r12 + '"]').innerText()),
  r12 ? (await page.locator('[data-drow="' + r12 + '"]').innerText()).replace(/\n/g, ' ') : '(no row)');
// THE TREEITEMS, not the whole page. The masthead ribbon prints `name · kind ·
// id` on purpose — "THE NAME FIRST, THE ULID LAST" — so a document-wide search
// for a ULID would be asserting against a decision this job did not touch. What
// must not be a ULID is what a person PICKS FROM, and `55` §4.5.2 makes the
// Outline's treeitems the whole keyboard interface for this view.
const axRows = axFlat(await page.accessibility.snapshot())
  .filter((n) => n.role === 'treeitem').map((n) => n.name);
check('and the accessible tree offers it by name, not by id',
  axRows.some((n) => /R12/.test(n)) && !axRows.some((n) => /rack:01/.test(n)),
  axRows.join(' | ').slice(0, 240));
// Selecting a rack does something no other box does, and the reader is told
// BEFORE the press rather than only by the breadcrumb that appears after it.
await page.click('[data-ddepth="site"]');
await page.waitForTimeout(250);
check('the note over the estate says a rack is a way in',
  /1 rack is drawn — select one to go inside it/.test(await page.locator('.dout').innerText()),
  (await page.locator('.dout').innerText()).slice(-300).replace(/\n/g, ' | '));
await page.click('[data-drow="' + r12 + '"]');
await page.waitForTimeout(250);

// -------------------------------------------------------------------------
console.log('\n4. PLACING A BOX LANDS YOU IN THE RACK YOU PLACED IT IN');
// -------------------------------------------------------------------------
// It used to reopen the rack sheet. There is no sheet; the landing is the rung.
check('the chart area is at rack depth', await depth() === 'rack');
check('the elevation is on screen', await page.locator('#rbody').isVisible());
check('and the box is at the unit it was given',
  /U3/.test(await page.locator('#rbody').innerText()),
  (await page.locator('#rbody').innerText()).slice(0, 160).replace(/\n/g, ' | '));

// -------------------------------------------------------------------------
console.log('\n5. `57` §2, THE LOAD-BEARING HALF: only the CHART AREA swaps');
// -------------------------------------------------------------------------
// "One canvas. Zoom is a depth axis, not a set of modes. The chart area swaps
//  what it draws; the band, the masthead and the side panel stay put."
check('the view is still the diagram, not a seventh view',
  await page.evaluate(() => document.getElementById('sheet').getAttribute('data-viewing')) === 'diagram');
check('the masthead is still here', await page.locator('#mTitle').isVisible());
check('the side panel is still here, with its two tabs',
  await page.locator('.dpanel [role="tab"]').count() === 2);
// 2026-09-05: was `>= 3` — the rack, the device and the rack-mounted chassis the
// chassis fold declined. Rung 1 now folds that chassis into its device as well
// (dgFoldInside, `57` §2), so the whole estate at level 1 is the rack and the
// device: "not just the rack" is a row that is not the rack.
check('the Outline still lists the whole estate, not just the rack',
  await page.locator('[data-drow]').count() >= 2 &&
  await page.locator('[data-drow]:not([data-drow="' + r12 + '"])').count() >= 1,
  String(await page.locator('[data-drow]').count()));
check('the band below is still here', await page.locator('.dband').isVisible());
check('the layer toggles are still here — they change what the Outline lists',
  await page.locator('[data-layer]').count() === 5);
// And the canvas is NOT: it is hidden, not destroyed, so it keeps its pan.
check('the picture one rung up is off screen', !(await page.locator('.dcanvas').isVisible()));
check('but still in the document, so its pan and zoom survive the trip',
  await page.locator('.dcanvas').count() === 1);
// A zoom control for a surface that is not on screen is furniture — the same
// test the narrow-width rules already apply.
check('the zoom controls are gone with the surface they drive',
  !(await page.locator('.dzoomctl').isVisible()));
check('and so are the move controls', !(await page.locator('.dmovectl').isVisible()));
// The masthead instruction is about what is on screen. "Drag one to move it" is
// false of a rack elevation — nothing in a frame can be dragged.
check('the masthead no longer tells you to drag a box',
  !/Drag one to move it/i.test(await page.locator('#mImp').innerText()),
  await page.locator('#mImp').innerText());

// -------------------------------------------------------------------------
console.log('\n6. THE WAY BACK IS OBVIOUS, AND IT IS A BREADCRUMB');
// -------------------------------------------------------------------------
check('the strip says how deep you are looking',
  await page.locator('.dladder').isVisible());
check('with a real button out', await page.locator('[data-ddepth="site"]').count() === 1);
check('and the rung you are ON as text, not as a pressed state (55 §1.4)',
  /rack R12/.test(await page.locator('.dladder [aria-current="true"]').innerText()),
  (await page.locator('.dladder').innerText()).replace(/\n/g, ' | '));
check('the band says it too, and says which key comes back',
  /inside a rack/.test(await page.locator('.dband').innerText())
    && /escape/i.test(await page.locator('.dband').innerText()),
  await page.locator('.dband').innerText());
await page.click('[data-ddepth="site"]');
await page.waitForTimeout(250);
check('pressing it comes back out', await depth() === 'site');
check('and the picture is back', await page.locator('.dcanvas').isVisible());
check('with the elevation gone rather than stacked behind it',
  await page.locator('#rbody').count() === 0);

// -------------------------------------------------------------------------
console.log('\n7. SELECTING THE RACK IS HOW YOU GET AN ELEVATION — with a pointer');
// -------------------------------------------------------------------------
await page.click('[data-drow="' + r12 + '"]');
await page.waitForTimeout(250);
check('clicking the rack descends', await depth() === 'rack');
check('and the rack is what is selected, so the panel agrees with the picture',
  /R12/.test(await page.locator('#dpaneDetailsTab').innerText()),
  await page.locator('#dpaneDetailsTab').innerText());
// Selecting the rack you are already inside is a no-op, not a re-entry.
await page.click('.rpick button[aria-pressed="true"]');
await page.waitForTimeout(200);
check('re-selecting the rack you are in changes nothing', await depth() === 'rack');

// -------------------------------------------------------------------------
console.log('\n8. AND WITH A KEYBOARD — every gesture has a key path');
// -------------------------------------------------------------------------
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
check('escape comes back out', await depth() === 'site');
// `55` §5.6: never stranded. Coming out with a key lands on the row of the rack
// you were inside, which is where you were when you went in.
check('and focus lands on the rack it came out of, never on <body>',
  await page.evaluate((id) => document.activeElement
    && document.activeElement.getAttribute('data-drow') === id, r12),
  await page.evaluate(() => document.activeElement.tagName + '.' + document.activeElement.className));
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
check('Enter on the focused rack row descends, same as a click',
  await depth() === 'rack');
check('and focus follows the reader in, onto the rung out',
  await page.evaluate(() => document.activeElement
    && document.activeElement.getAttribute('data-ddepth') === 'site'),
  await page.evaluate(() => document.activeElement.outerHTML.slice(0, 90)));
// One press, one level (53 §3.7). Nothing above the rack rung is open, so the
// first press is the ascent — and the second clears the selection, not before.
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
check('one escape unwinds exactly one level — the rack, and not the selection',
  await depth() === 'site' && /R12/.test(await page.locator('#dpaneDetailsTab').innerText()),
  await page.locator('#dpaneDetailsTab').innerText());
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
check('and the next escape clears the selection, which is the rung below',
  /none/i.test(await page.locator('#dpaneDetailsTab').innerText()),
  await page.locator('#dpaneDetailsTab').innerText());

// -------------------------------------------------------------------------
console.log('\n9. A SECOND RACK IS A PEER, NOT A MODE');
// -------------------------------------------------------------------------
await addBox('srx-b');
await place('R13', 'srx-b', 5);
check('placing into a new rack lands in THAT rack',
  await depth() === 'rack'
    && /rack R13/.test(await page.locator('.dladder [aria-current="true"]').innerText()),
  (await page.locator('.dladder').innerText()).replace(/\n/g, ' | '));
// The picker inside the elevation is how you step sideways to the rack next to
// it — the owner's "takes you to a different rack", one rung at a time.
await page.locator('.rpick button', { hasText: 'R12' }).first().click();
await page.waitForTimeout(250);
check('and the picker steps sideways to the rack beside it',
  /rack R12/.test(await page.locator('.dladder [aria-current="true"]').innerText()),
  (await page.locator('.dladder').innerText()).replace(/\n/g, ' | '));

// -------------------------------------------------------------------------
console.log('\n10. THE RUNG IS RECONCILED AGAINST THE ESTATE THAT IS HELD');
// -------------------------------------------------------------------------
// THIS SECTION ASSERTED THE OPPOSITE UNTIL 2026-08-21, and the inversion is the
// point rather than a repair.
//
// `OP_PASTE` used to REPLACE what is held, so a reader standing inside a rack
// when a paste landed was left in a frame that no longer existed — under a
// breadcrumb naming it, swallowing the Escape that would clear the selection.
// The rung had to be dropped, and this checked that it was.
//
// A paste ADDS now (`49` §10b). The rack a person is standing in survives, so
// dropping the rung would be the defect: it would throw away where they were
// for an event that did not touch it. What must still hold is the underlying
// rule — THE RUNG NAMES SOMETHING THAT EXISTS — and the honest way to test that
// is with the gesture that can still make it false, which is removing the rack
// itself, not pasting beside it.
await page.click('#tabPaste');
await page.waitForTimeout(100);
await page.fill('#pta', [
  'set system host-name srx-hq-01',
  'set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/30',
].join('\n'));
await page.click('#pRun');
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
await page.click('[data-view="diagram"]');
await page.waitForTimeout(300);
check('A PASTE NO LONGER THROWS AWAY WHERE YOU WERE STANDING',
  await depth() === 'rack', String(await depth()));
check('and the breadcrumb still names the rack, because it still exists',
  await page.locator('.dladder').count() > 0);

// And the rule the old assertion was really protecting, tested with the
// gesture that can still break it: REMOVE THE RACK WHILE STANDING INSIDE IT.
// The 2026-08-28 review caught that this comment promised the gesture and the
// code below only pressed Escape — a test description asserting a test that
// did not exist, which is the same defect class as a sentence overclaiming on
// screen. The renderer carries a reconciliation pass (renderDiagram: "if
// (!still) DG_DEPTH = null") and until now NOTHING drove it.
const railBefore = await page.locator('.dladder').count();
await page.click('[data-view="inventory"]');
await page.waitForTimeout(200);
// Select the rack's row (the Rack kind strip entry), then remove it.
await page.evaluate(() => {
  const strip = [...document.querySelectorAll('[data-kind]')]
    .find(n => /rack/i.test(n.textContent));
  strip.click();
});
await page.waitForTimeout(200);
await page.click('.inv tbody tr td button');
await page.waitForTimeout(200);
await page.click('[data-remove]');
await page.waitForTimeout(300);
await page.click('[data-view="diagram"]');
await page.waitForTimeout(300);
check('REMOVING THE RACK YOU ARE STANDING IN DROPS THE RUNG',
  await depth() === 'site', String(await depth()));
check('and leaves no breadcrumb naming a rack that is gone',
  await page.locator('.dladder').count() === 0,
  (await page.locator('.dladder').count()) + ' rail(s), was ' + railBefore);

// -------------------------------------------------------------------------
console.log('\n11. invariant 1 — no egress');
// -------------------------------------------------------------------------
const off = requests.filter((u) => !u.startsWith('file://'));
check(`zero non-file requests (saw ${requests.length} total)`, off.length === 0, off.join(', '));
check('no page errors and no console errors', errors.length === 0, errors.join(' | '));

console.log(`\n${pass}/${pass + fail} checks passed`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
