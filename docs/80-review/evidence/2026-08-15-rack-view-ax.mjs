// ADR-0036's rack view, driven in the shipped artifact.
//
// This asks Chromium for the ACCESSIBLE TREE, not the DOM. A rack elevation
// drawn as <rect>s inside an aria-hidden <svg> announces nothing, and a
// disclosure contract declared on SVG nodes is a contract with no audience.
// This face is drawn in real DOM precisely so every box is a real focusable
// element with a real name -- so the bar is that the accessibility tree can
// see them, and that is what is asserted here.
//
// SECTIONS 10 AND 11 EXIST BECAUSE THIS FILE MISSED A DEFECT AT 19/19.
// The first version placed boxes only into distinct, non-overlapping units in
// two different racks. It therefore never asked the one question an elevation
// is for -- "is there room for this box, and where" -- and passed at 100%
// against a renderer that dropped a box whenever two runs began on the same
// drawn row. Front-and-rear at the same U is the ORDINARY arrangement of a
// rack, so the ordinary rack silently lost an occupant, and the caption
// underneath printed "Both are drawn" over a picture that drew one. The two
// collision cases below are that defect, asked of the accessible tree.
//
//   node 2026-08-15-rack-view-ax.mjs
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

// Walk the accessible tree, flattened.
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

// Invariant 1: nothing is retrieved from anywhere. Every request is counted.
const requests = [];
page.on('request', (r) => requests.push(r.url()));

await page.goto('file://' + artifact);
await page.waitForFunction(() => document.getElementById('tabEquip') !== null);

// -------------------------------------------------------------------------
// THE WAY IN CHANGED ON 2026-08-21 AND THIS FILE WAS TAUGHT IT (`57` §2).
//
// `rack view` used to be a third door in the band, and the owner's complaint
// about it opened the whole zoom-ladder design: `paste a config` and `add
// equipment` are how data gets IN, and `rack view` was a way of LOOKING at data
// already there. It is a rung of the diagram now — you select a rack and the
// chart area draws its elevation — and `put a box in a rack` moved to the `add
// equipment` sheet, which is the only door that does not need a rack to already
// exist.
//
// NOT ONE ASSERTION BELOW WAS WEAKENED FOR IT. Every check on what the
// elevation DRAWS is untouched and still reads `#rbody`, because the renderer
// is untouched — the change was to how it is reached. What moved is the
// plumbing: `enterRack` replaces `page.click('#tabRack')`, `place` opens the
// form through the equipment door, and section 1 now asserts the new contract
// (two doors, and selecting a rack is the way in) instead of the old one.
// -------------------------------------------------------------------------

// Dismiss whatever is up, so a helper never types into the wrong sheet. The
// scrim is the page's own answer to "is a sheet open", so it is what is asked.
async function closeSheets() {
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator('#scrim').isVisible())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
  }
}

// Open the placement form the way a person does now: through the second door.
async function openPlaceForm() {
  await closeSheets();
  await page.click('#tabEquip');
  await page.waitForTimeout(60);
  await page.click('#rAdd');
  await page.waitForTimeout(60);
}

// Go into a rack's elevation by SELECTING the rack, which is the whole of the
// new contract. The Outline row is the keyboard-and-pointer handle the diagram
// already gives every box; the rack is drawn as one because `layers.rs`
// over-draws it and marks it untabled.
async function enterRack(label) {
  await closeSheets();
  await page.click('[data-view="diagram"]');
  await page.waitForTimeout(200);
  const row = await page.evaluate((name) => {
    const r = [...document.querySelectorAll('[data-drow]')]
      .find((x) => /Rack/.test(x.textContent) && x.textContent.includes(name));
    return r ? r.getAttribute('data-drow') : null;
  }, label);
  if (!row) return false;
  await page.click('[data-drow="' + row + '"]');
  await page.waitForTimeout(250);
  return true;
}

// The placement form's field ids are the schema's field keys, and those keys
// MOVED during a rebase -- 300-306 became 302-307 when a concurrent branch took
// 300/301 for LayoutPin.x/.y. A driver that hard-codes them is a third copy of
// the registry that goes stale silently, so they are read out of the rendered
// form by its LABELS, which is also how a person finds them.
async function fieldIds() {
  await openPlaceForm();
  const map = await page.locator('#mform label').evaluateAll(
    (ls) => Object.fromEntries(ls.map((l) => [l.textContent.replace(/ — required$/, '').trim(),
                                              l.getAttribute('for')])));
  await closeSheets();
  return map;
}

async function addBox(hostname, member) {
  await page.click('#tabEquip');
  await page.fill('#ef6', hostname);
  await page.selectOption('#ef7', 'junos-srx');
  const idx = await page.locator('#ef18').count();
  if (idx) await page.fill('#ef18', member);
  await page.click('#eRun');
  await page.waitForTimeout(50);
}

// One placement through the page's own form, exactly as a person makes it.
// `host` picks the box by the hostname the option text shows -- the chassis
// display id is a ULID and naming one here would fossilise a value the store
// mints.
const F = {};
async function place(opts) {
  /* The placement form opens FROM the equipment sheet now. A successful
     placement closes both and lands inside the rack; a refusal leaves the form
     open with everything still typed in it. Either way this starts from a clean
     page rather than assuming which of the two it is looking at, which is the
     same discipline the version that drove the rack sheet had. */
  await openPlaceForm();
  await page.fill('#' + F.rack, opts.rack);
  await page.fill('#' + F.height, String(opts.height));
  await page.selectOption('#' + F.numbering, opts.numbering);
  await page.fill('#' + F.pos, String(opts.pos));
  if (opts.span !== undefined) await page.fill('#' + F.span, String(opts.span));
  if (opts.face !== undefined) await page.selectOption('#' + F.face, opts.face);
  const opts2 = await page.locator('#mfChassis option').evaluateAll(
    (os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  const want = opts.chassis
    || (opts2.find((o) => o.t.includes(opts.host)) || opts2[0]).v;
  await page.selectOption('#mfChassis', want);
  await page.click('#mRun');
  await page.waitForTimeout(80);
}

console.log('\n1. rack view is NOT a door — the band is two doors, and the way in is the rack');
// The category error, asserted from the outside: the band's job is HOW DATA
// GETS IN, and there are exactly two ways in.
check('the band offers two doors, not three',
  await page.locator('.doors button').count() === 2,
  (await page.locator('.doors button').evaluateAll((ns) => ns.map((n) => n.textContent.trim())))
    .join(' | '));
check('and none of them is a way of LOOKING',
  await page.locator('#tabRack').count() === 0);
// The `then` kicker went with the door it belonged to. `start here` and `or`
// are a pair; `then` was the third rung of a sequence with no third rung left.
const kickers = await page.locator('.doors .dk').evaluateAll((ns) => ns.map((n) => n.textContent.trim()));
check('the "then" kicker went with it', !kickers.includes('then'), kickers.join(','));

await addBox('srx-a', '0');
await addBox('srx-b', '1');

console.log('\n2. the empty state says what it cannot do, rather than showing nothing');
// THIS SENTENCE MOVED WITH THE SHEET IT USED TO LIVE IN, and it is asserted in
// its new home rather than dropped. It was the rack sheet's empty state — which
// cannot exist any more, because with no racks there is nothing to select and
// no elevation to stand in. The one person who needs telling that a rack is
// hand-entered is the one about to create one, so it is now the hint on the
// form that creates it.
await openPlaceForm();
const empty = await page.locator('#mHint').innerText();
check('it says no config states rack position',
  /nothing in a pasted config says which rack/i.test(empty), empty.slice(0, 200));
await closeSheets();

console.log('\n3. a box can be placed by hand');
const LABELS = await fieldIds();
F.rack = LABELS['rack name'];
F.height = LABELS['rack height in units'];
F.numbering = LABELS['unit numbering'];
F.pos = LABELS['position — lowest unit the box occupies'];
F.span = LABELS['box height in units'];
F.face = LABELS['face'];
check('the form offers every placement field the schema declares',
  Object.values(F).every(Boolean), JSON.stringify(F));
await openPlaceForm();
const chassisValues = await page.locator('#mfChassis option').evaluateAll(
  (os) => os.map((o) => o.value));
await closeSheets();
await place({ rack: 'R12', height: 42, numbering: 'ascending', pos: 5, span: 2,
              face: 'front', chassis: chassisValues[0] });

// A SUCCESSFUL PLACEMENT LANDS YOU IN THE RACK, which is the ladder's own
// answer to "did that work?" — it used to reopen the rack sheet, and there is
// no sheet. The elevation is on screen with nothing further pressed.
check('placing a box lands inside the rack it was placed in',
  await page.locator('.dview').getAttribute('data-depth') === 'rack'
    && await page.locator('#rbody').isVisible(),
  String(await page.locator('.dview').getAttribute('data-depth')));
check('and the picture one rung up is not on screen at the same time',
  !(await page.locator('.dcanvas').isVisible()));

const drawn = await page.locator('#rbody').innerText();
check('the frame states its own geometry', /42U/.test(drawn) && /U1 at the bottom/.test(drawn),
  drawn.slice(0, 200));
check('the placed box is drawn at its unit', /U5–U6/.test(drawn), drawn.slice(0, 300));

console.log('\n4. THE ACCESSIBLE TREE — the bar, not the DOM');
let snap = await page.accessibility.snapshot();
let flat = axFlat(snap);
const boxNodes = flat.filter((n) => /srx-a/.test(n.name) && n.role === 'button');
check('the placed box is a BUTTON in the accessibility tree', boxNodes.length >= 1,
  JSON.stringify(flat.filter((n) => /srx/.test(n.name)).slice(0, 6)));
check('its accessible name carries the position, not just a label',
  boxNodes.some((n) => /U5/.test(n.name)),
  JSON.stringify(boxNodes.map((n) => n.name)));
check('the rack picker is a button in the accessibility tree',
  flat.some((n) => n.role === 'button' && n.name === 'R12'),
  JSON.stringify(flat.filter((n) => n.role === 'button').slice(0, 12).map((n) => n.name)));

console.log('\n5. the box is keyboard reachable and activates');
// Leave and come back by SELECTING the rack, so the state under this section is
// reached the way a person reaches it rather than by reopening a sheet.
check('escape comes back out of the rack', await (async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return await page.locator('.dview').getAttribute('data-depth') === 'site';
})());
check('selecting the rack goes back in', await enterRack('R12'));
let reached = false;
for (let i = 0; i < 60 && !reached; i++) {
  await page.keyboard.press('Tab');
  reached = await page.evaluate(() => {
    const a = document.activeElement;
    return !!(a && a.classList && a.classList.contains('rbox'));
  });
}
check('a placed box can be reached with Tab alone', reached);

console.log('\n6. an unstated height is MARKED, never recorded as 1U');
await place({ rack: 'R12', height: 42, numbering: 'ascending', pos: 20,
              chassis: chassisValues[1] });
const marked = await page.locator('#rbody').innerText();
check('the unmeasured box says so in words',
  /height not stated, drawn as 1U/.test(marked), marked.slice(0, 400));
snap = await page.accessibility.snapshot();
flat = axFlat(snap);
check('and the accessible name says so too',
  flat.some((n) => n.role === 'button' && /height not stated/.test(n.name)),
  JSON.stringify(flat.filter((n) => n.role === 'button' && /srx-b/.test(n.name)).map((n) => n.name)));

console.log('\n7. re-placing an already-placed box is refused BY NAME');
await place({ rack: 'R99', height: 10, numbering: 'descending', pos: 1,
              chassis: chassisValues[0] });   // already in R12
check('the refusal names the reason rather than silently moving the box',
  await page.locator('#mErr').isVisible()
    && /already in a rack/.test(await page.locator('#mErr').innerText()),
  await page.locator('#mErr').innerText().catch(() => '(no error shown)'));

console.log('\n8. the numbering direction reaches the picture');
// Escape unwinds ONE level, and the level below the placement form is now the
// EQUIPMENT SHEET that opened it rather than the rack sheet that used to. Two
// presses to reach the page either way — the contract 53 §3.7 asks for is that
// one press undoes one thing, not that a particular sheet is underneath.
await page.keyboard.press('Escape');
await page.waitForTimeout(60);
check('esc from the placement form returns to the sheet that opened it, not to the page',
  await page.locator('#esheet').isVisible() && !(await page.locator('#msheet').isVisible()));
await page.keyboard.press('Escape');
await page.waitForTimeout(60);
check('a second esc closes that sheet too',
  !(await page.locator('#esheet').isVisible()) && !(await page.locator('#scrim').isVisible()));
await addBox('srx-c', '0');
await place({ rack: 'R99', height: 10, numbering: 'descending', pos: 1, host: 'srx-c' });
const desc = await page.locator('#rbody').innerText();
check('a descending frame reports U1 at the top', /U1 at the top/.test(desc),
  desc.slice(0, 200));
// The gutter's first row is the unit nearest the top of the drawing. Under
// descending numbering that is U1; under ascending it would be U10.
const firstUnit = await page.locator('#rbody .relev .u').first().innerText();
check('and the TOP row of the drawing is U1, not U10', firstUnit.trim() === '1', firstUnit);
check('a 10U frame draws exactly 10 unit rows',
  await page.locator('#rbody .relev .u').count() === 10,
  String(await page.locator('#rbody .relev .u').count()));
// The same assertion inverted, on the ascending frame.
await page.locator('.rpick button', { hasText: 'R12' }).first().click();
await page.waitForTimeout(50);
const topUnitAsc = await page.locator('#rbody .relev .u').first().innerText();
check('while the ascending frame draws U42 at the top', topUnitAsc.trim() === '42', topUnitAsc);
check('and a 42U frame draws exactly 42 unit rows',
  await page.locator('#rbody .relev .u').count() === 42,
  String(await page.locator('#rbody .relev .u').count()));

console.log('\n9. the face states its own limits');
const limits = await page.locator('#rbody').innerText();
check('it says nothing here was parsed',
  /Nothing here was parsed/i.test(limits), limits.slice(-400));
check('it says floor, building and map are not built',
  /Floor, building and map are not built/i.test(limits), limits.slice(-400));
check('it says how the two faces are drawn',
  /two columns against one unit gutter/i.test(limits), limits.slice(-400));

// -------------------------------------------------------------------------
// 10. CASE A — BACK TO BACK. ADR-0036 §6 calls this normal rather than a
// defect, and the first renderer deleted one of the two boxes for it, with no
// message of any kind. Front and rear at one U, in a 10U frame.
// -------------------------------------------------------------------------
console.log('\n10. two boxes at the same unit on OPPOSITE faces — both drawn');
await page.reload();
await page.waitForFunction(() => document.getElementById('tabEquip') !== null);
await addBox('srx-front', '0');
await addBox('srx-rear', '0');
await place({ rack: 'RB', height: 10, numbering: 'ascending', pos: 5, span: 1,
              face: 'front', host: 'srx-front' });
await place({ rack: 'RB', height: 10, numbering: 'ascending', pos: 5, span: 1,
              face: 'rear', host: 'srx-rear' });

const bbBoxes = await page.locator('#rbody .rbox').count();
check('BOTH boxes are in the DOM', bbBoxes === 2, `saw ${bbBoxes}`);
snap = await page.accessibility.snapshot();
flat = axFlat(snap);
// An elevation box's accessible name is "<who> — <position>...". The estate's
// other buttons carry the bare hostname, so the em dash is what tells a box in
// the PICTURE from a row somewhere else on the page.
const bbNames = flat.filter((n) => n.role === 'button' && / — U/.test(n.name))
  .map((n) => n.name);
check('BOTH boxes are in the ACCESSIBLE TREE', bbNames.length === 2, JSON.stringify(bbNames));
check('the front box names its face', bbNames.some((n) => /srx-front/.test(n) && /front/.test(n)),
  JSON.stringify(bbNames));
check('the rear box names its face', bbNames.some((n) => /srx-rear/.test(n) && /rear/.test(n)),
  JSON.stringify(bbNames));
check('the frame still draws all 10 units',
  await page.locator('#rbody .relev .u').count() === 10,
  String(await page.locator('#rbody .relev .u').count()));
const bbText = await page.locator('#rbody').innerText();
check('the two faces are headed in the picture',
  /front/.test(bbText) && /rear/.test(bbText), bbText.slice(0, 300));
check('the count sentence agrees with the picture: 2 recorded, 2 drawn',
  /2 box\(es\) recorded in this rack; 2 drawn/.test(bbText),
  (bbText.match(/\d+ box\(es\) recorded[^.]*\./) || ['(no count sentence)'])[0]);
check('opposite faces are NOT reported as a clash',
  !/same units on the same face/.test(bbText));

// -------------------------------------------------------------------------
// 11. CASE B — a genuine same-face overlap, which is the data of the Rust test
// `two_boxes_in_one_unit_are_reported_not_resolved`. Both runs compute the
// same top row (42-10-3+1 = 42-12-1+1 = 30), which is exactly what the old
// `starts[top] = s` map could not hold. The taller box was the one that
// disappeared.
// -------------------------------------------------------------------------
console.log('\n11. two boxes overlapping on the SAME face — both drawn, both marked');
await page.reload();
await page.waitForFunction(() => document.getElementById('tabEquip') !== null);
await addBox('srx-a2', '0');
await addBox('srx-b2', '0');
await place({ rack: 'RC', height: 42, numbering: 'ascending', pos: 10, span: 3,
              face: 'front', host: 'srx-a2' });
await place({ rack: 'RC', height: 42, numbering: 'ascending', pos: 12, span: 1,
              face: 'front', host: 'srx-b2' });

const ovBoxes = await page.locator('#rbody .rbox').count();
check('BOTH overlapping boxes are in the DOM', ovBoxes === 2, `saw ${ovBoxes}`);
snap = await page.accessibility.snapshot();
flat = axFlat(snap);
const ovNames = flat.filter((n) => n.role === 'button' && / — U/.test(n.name))
  .map((n) => n.name);
check('BOTH overlapping boxes are in the ACCESSIBLE TREE', ovNames.length === 2,
  JSON.stringify(ovNames));
check('the 3U box — the one the old renderer lost — is there and spans U10–U12',
  ovNames.some((n) => /srx-a2/.test(n) && /U10–U12/.test(n)), JSON.stringify(ovNames));
check('both say in their accessible name that they share the units',
  ovNames.filter((n) => /shares these units/.test(n)).length === 2, JSON.stringify(ovNames));
check('both are MARKED in the picture, not only in the caption',
  await page.locator('#rbody .rbox.clash').count() === 2,
  String(await page.locator('#rbody .rbox.clash').count()));
check('the frame still draws all 42 units — U10 and U11 are not deleted',
  await page.locator('#rbody .relev .u').count() === 42,
  String(await page.locator('#rbody .relev .u').count()));
const ovText = await page.locator('#rbody').innerText();
check('the count sentence agrees with the picture: 2 recorded, 2 drawn',
  /2 box\(es\) recorded in this rack; 2 drawn/.test(ovText),
  (ovText.match(/\d+ box\(es\) recorded[^.]*\./) || ['(no count sentence)'])[0]);
check('the caption says both are drawn, and it is now true',
  /Both are drawn/.test(ovText), (ovText.match(/[^.]*drawn[^.]*\./) || [''])[0]);
// The gutter must still read 14, 13, 12, 11, 10 — the units the old renderer
// removed along with the box it lost.
const units = await page.locator('#rbody .relev .u').evaluateAll(
  (ns) => ns.map((n) => n.textContent.trim()));
check('U11 and U10 are still in the gutter',
  units.includes('11') && units.includes('10'),
  units.slice(28, 36).join(','));

// The evidence shot is taken HERE, on the case that used to be wrong, rather
// than at the end on whatever happens to be on screen. A screenshot of the
// easy case proves nothing about the hard one. The frame is scrolled to the
// boxes first: 42 units do not fit the sheet and the occupied ones are thirty
// rows down, so an unscrolled shot would be a picture of empty rails.
await page.locator('#rbody .rbox').first().scrollIntoViewIfNeeded();
await page.waitForTimeout(50);
await page.screenshot({ path: resolve(here, '2026-08-15-rack-view.png'), fullPage: false });
console.log('  wrote 2026-08-15-rack-view.png (the same-face overlap, both boxes drawn)');

// -------------------------------------------------------------------------
// 12. A box that cannot be drawn is NAMED with a count, never dropped.
// -------------------------------------------------------------------------
console.log('\n12. a box outside the frame is named, never clipped and never silent');
await page.reload();
await page.waitForFunction(() => document.getElementById('tabEquip') !== null);
await addBox('srx-hi', '0');
await place({ rack: 'RD', height: 10, numbering: 'ascending', pos: 40, span: 1,
              face: 'front', host: 'srx-hi' });
const outText = await page.locator('#rbody').innerText();
check('the count sentence says 1 recorded, 0 drawn',
  /1 box\(es\) recorded in this rack; 0 drawn/.test(outText),
  (outText.match(/\d+ box\(es\) recorded[^.]*\./) || ['(no count sentence)'])[0]);
check('the box is named in full, with its reason',
  /srx-hi/.test(outText) && /outside this 10U frame/.test(outText), outText.slice(0, 500));
check('and the frame is still the full 10 units',
  await page.locator('#rbody .relev .u').count() === 10,
  String(await page.locator('#rbody .relev .u').count()));

// -------------------------------------------------------------------------
// 13. THE REFUSAL IS NOT DRIVEN HERE, AND THAT IS SAID RATHER THAN HIDDEN.
//
// A numbering token this build cannot read makes the page draw no frame at all.
// It cannot be reached from this driver, and not for want of trying: no input
// the shipped artifact accepts produces that state -- `parse_into_slot` refuses
// an unknown token, `OP_RACK_PLACE` demands the field before touching the
// store, and importing a journal replays through the same door. The page's
// script is an IIFE, so its state cannot be forged from outside either, which
// is a property worth keeping rather than a hole to drill through.
//
// So the guard is driven where the state IS constructible, at the wire:
//   crates/fathom-inventory/tests/rack_numbering.rs — the model answers with no
//     direction rather than with "ascending"
//   crates/fathom-wasm/tests/rack.rs
//     ::the_direction_slot_tells_no_direction_apart_from_descending — and the
//     wire carries that as a third state the page can branch on
// The page's own half is one `if (!e.readable)`, which is why the decision was
// moved into the module: a branch on a flag cannot drift from the rule, and a
// token-spelling comparison in JavaScript could.
// -------------------------------------------------------------------------

console.log('\n14. the declared range is enforced, not decoration');
await page.reload();
await page.waitForFunction(() => document.getElementById('tabEquip') !== null);
await addBox('srx-r', '0');
await place({ rack: 'R0', height: 0, numbering: 'ascending', pos: 1,
              host: 'srx-r' });
check('a 0U rack is refused, by name',
  await page.locator('#mErr').isVisible()
    && /Rack.height_u is 0/.test(await page.locator('#mErr').innerText()),
  await page.locator('#mErr').innerText().catch(() => '(no error shown)'));
await place({ rack: 'R200', height: 200, numbering: 'ascending', pos: 1,
              host: 'srx-r' });
check('a 200U rack is refused, by name',
  await page.locator('#mErr').isVisible()
    && /Rack.height_u is 200/.test(await page.locator('#mErr').innerText()),
  await page.locator('#mErr').innerText().catch(() => '(no error shown)'));

console.log('\n15. invariant 1 — no egress');
const offFile = requests.filter((u) => !u.startsWith('file://'));
check(`zero non-file requests (saw ${requests.length} total)`, offFile.length === 0,
  offFile.join(', '));

console.log('\n16. A RACK SURVIVES AN EXPORT AND A RE-OPEN');
/* ADR-0036 §1 reason 1 is the whole argument for putting placement in the
   graph: "A diagram an engineer arranged and cannot keep is not worth
   arranging." A rack is the ONLY kind in the estate no paste can rebuild — §1
   records that nothing parses one — so a round trip that drops it does not
   degrade the record, it DELETES it.

   It shipped dropping it. `runPlaceIntoRack` wrote through `OP_RACK_PLACE`,
   updated the view, and never touched `S.journal`; `importJournal` had arms for
   paste, equip, field, remove and place and none for a rack. The exported `ops`
   array held one op for two user actions, the footer counted one step, the
   re-opened file read "No racks yet.", and nothing anywhere said a thing had
   been dropped. Nothing caught it because the journal lives in page JavaScript
   where no Rust test can see it, and because THIS FILE never exported. */
await place({ rack: 'RKEEP', height: 42, numbering: 'ascending', pos: 7,
              span: 2, host: 'srx-a' });
await page.waitForTimeout(80);

/* Asserted on the EXPORTED FILE rather than on `S.journal`: the page's script
   is scoped, so the state object is not reachable from a driver — and the file
   is the thing that actually matters, being what an operator keeps. */
const dl = page.waitForEvent('download');
await page.click('#tabExport');
const saved = resolve(here, '../../../target/rack-round-trip.fathom-journal.json');
await (await dl).saveAs(saved);
const doc = JSON.parse((await import('node:fs')).readFileSync(saved, 'utf8'));
check('and in the file that leaves the machine',
  doc.ops.some((o) => o.op === 'rack'),
  JSON.stringify(doc.ops.map((o) => o.op)));

await page.reload();
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await (await page.$('input[type=file]')).setInputFiles(saved);
await page.waitForTimeout(900);
/* THE RE-OPENED RACK IS REACHED THE NEW WAY, and that makes this a stronger
   round trip than it was. It used to open a sheet and then pick RKEEP out of
   its picker, because after an import no rack was selected. Now the imported
   rack has to be a BOX IN THE PICTURE carrying its own label for `enterRack` to
   find it at all — so a rack that came back as a bare ULID, or came back and
   was not drawn, fails here rather than being picked out of a list by a driver
   that already knew its name. */
const back = await enterRack('RKEEP');
check('THE RACK COMES BACK, drawn and named, and selecting it opens its frame',
  back && await page.locator('.dview').getAttribute('data-depth') === 'rack');
const chosen = await page.locator('#rbody').innerText();
check('with the box still at the unit it was put at',
  /\bU7\b/.test(chosen) && !/No racks yet/i.test(chosen),
  chosen.slice(0, 220).replace(/\n/g, ' | '));

console.log(`\n${pass}/${pass + fail} checks passed`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
