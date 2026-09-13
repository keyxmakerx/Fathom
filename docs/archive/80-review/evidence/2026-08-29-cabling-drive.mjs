// ADR-0038 — A CABLE IS DRAWN BY HAND, AND ITS PORTS ARE MINTED BY THE GESTURE.
// Driven through the shipped artifact, in Chromium, ASSERTING ON THE DOM. The
// screenshot beside this file is not the evidence; these assertions are.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-29-cabling-drive.mjs [repo-root]
//
// Before `OP_CABLE` a hand-built estate could be connected LOGICALLY
// (`OP_LINK`, 2026-08-16) and could not be connected PHYSICALLY at all —
// `Cable`, `Terminates` and (until 2026-08-28) even a labelless `PhysicalPort`
// existed only in `schema/`. This proves the whole gesture the owner asked for
// on 2026-08-18 (`57` §12): hold a port (minting one, or the box's own
// `Chassis`, when neither exists), select the other end, draw it — with
// "unknown" and "no cable" both real, distinct, honest doors — and that every
// bit of it is graph data, not a picture: it survives a real reload.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const pasteConfig = async text => {
  await page.click('#tabPaste');
  await page.waitForFunction(() => document.getElementById('pta') !== null);
  await page.fill('#pta', text);
  await page.click('#pRun');
  await page.waitForTimeout(400);
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

const handStrokes = () => page.$$eval('.dhand', ns => ns.length);
const handWords = () => page.$$eval('.dhandmark', ns => ns.map(n => n.textContent));

// Select a box on the canvas (via its Outline row) and press one of this
// view's strip buttons. Mirrors `2026-08-16-hand-link-drive.mjs`'s own idiom
// one rung down.
const selectBox = async id => { await objects(); await page.click('[data-drow="' + id + '"]'); };

// The picker sheet's own list of existing ports, read straight off the DOM —
// never off page internals, for the same reason every other helper here does
// not reach into `window`.
const portList = () => page.$$eval('.cport', ns => ns.map(n => ({
  label: n.querySelector('button').textContent,
  id: n.querySelector('button').getAttribute('data-dcableport'),
  note: (n.querySelector('.note') || {}).textContent || '',
})));

const cableHoldFromHere = async () => {
  await page.click('[data-dcablehold]');
  await page.waitForTimeout(120);
};
const cableThem = async () => {
  await page.click('[data-dcablethem]');
  await page.waitForTimeout(120);
};
const mintPort = async label => {
  if (label) await page.fill('#cAddLabel', label); else await page.fill('#cAddLabel', '');
  await page.click('[data-dcablemint]');
  await page.waitForTimeout(150);
};
const pickExistingPort = async id => {
  await page.click('[data-dcableport="' + id + '"]');
  await page.waitForTimeout(150);
};

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// ---- 1. TWO HAND-ADDED DEVICES, MINTED PORTS ON BOTH ENDS ------------------

console.log('\n1. DRAW A CABLE BETWEEN TWO HAND-ADDED BOXES, MINTING BOTH PORTS');
await addDevice('sw-cable-01', 'switch');
await addDevice('fw-cable-01', 'firewall');
await addDevice('ap-cable-01', 'access_point');
await page.click('[data-view="diagram"]');
await page.waitForFunction(() => document.querySelectorAll('.dbox').length >= 2);

let rows = await deviceRows();
const A = rows.find(r => /sw-cable-01/.test(r.text));
const B = rows.find(r => /fw-cable-01/.test(r.text));
const C = rows.find(r => /ap-cable-01/.test(r.text));
check('three hand-added devices are three boxes', !!A && !!B && !!C);

await selectBox(A.id);
check('cable from here is on the strip', await page.$('[data-dcablehold]') !== null);
await cableHoldFromHere();
check('the picker sheet is open, for the near end', await page.$eval('#csheet', n => !n.hidden));
check('a box with no ports says so', /has no ports recorded yet/.test(await page.$eval('#cform', n => n.textContent)));
await mintPort('ge-0/0/0');
check('holding a to-be-minted port is announced by name, and nothing is written yet',
  (await footer()).includes('ge-0/0/0') && (await footer()).includes('select the other end'));
check('the strip button now says what is held',
  (await page.$eval('[data-dcablehold]', n => n.textContent)).includes('ge-0/0/0'));

await selectBox(B.id);
await cableThem();
check('the far picker offers unknown and a cable label — B has no ports yet',
  await page.$('[data-dcableunknown]') !== null && await page.$('#cCableLabel') !== null);
await mintPort(''); // unlabelled far port — D11's own case
await page.waitForTimeout(200);
check('drew a cable, announced as such', (await footer()) === 'drew a cable — it is marked as drawn by hand');

const kidsA = await outlineKids(A.id);
check('the Outline reads "cable to fw-cable-01 · by hand" (D13)',
  kidsA.some(t => /cable/.test(t) && /fw-cable-01/.test(t) && /by hand/.test(t)),
  JSON.stringify(kidsA));
check('exactly one hand stroke, and the midpoint word is "cable · by hand" (D13)',
  (await handStrokes()) === 1 && (await handWords()).includes('cable · by hand'),
  (await handStrokes()) + ' strokes · ' + JSON.stringify(await handWords()));
check('the picture never grew a third box for the Cable node, or two more for its ports (D10)',
  (await page.$$eval('.dbox', ns => ns.length)) === 3,
  await page.$$eval('.dbox', ns => ns.length) + ' boxes drawn');

await page.screenshot({ path: OUT + '/2026-08-29-cabling-drawn.png' });

// ---- 2. AN EXISTING PORT REUSED ---------------------------------------------

console.log('\n2. REUSE AN EXISTING PORT');
await selectBox(A.id);
await cableHoldFromHere();
let ports = await portList();
check('A\'s existing port is listed, and shown as already cabled',
  ports.some(p => p.label === 'ge-0/0/0' && /cabled to/.test(p.note)), JSON.stringify(ports));
const gePortId = ports.find(p => p.label === 'ge-0/0/0').id;
await pickExistingPort(gePortId);
check('holding a REUSED port names it, not "a new port"',
  (await footer()).includes('ge-0/0/0') && !(await footer()).includes('new'));

await selectBox(C.id);
await cableThem();
await mintPort('ge-0/0/1');
await page.waitForTimeout(200);
check('a second cable off the SAME reused port drew (breakout, Terminates.in: 0..n)',
  (await footer()) === 'drew a cable — it is marked as drawn by hand');
const kidsA2 = await outlineKids(A.id);
check('A now cables to both fw-cable-01 and ap-cable-01',
  kidsA2.filter(t => /cable to/.test(t)).length === 2, JSON.stringify(kidsA2));

// ---- 3. "ALREADY THERE" ON A REPEAT ----------------------------------------

console.log('\n3. DRAWING THE SAME CABLE AGAIN IS A NO-OP, NOT A SECOND FACT');
await selectBox(A.id);
await cableHoldFromHere();
ports = await portList();
await pickExistingPort(ports.find(p => p.label === 'ge-0/0/0').id);
await selectBox(B.id);
await cableThem();
ports = await portList();
const bPortId = ports[0].id; // B has exactly one port, the unlabelled far end from step 1
await pickExistingPort(bPortId);
await page.waitForTimeout(200);
check('the module says "already there" and nothing new was drawn',
  (await footer()) === 'those two ports already have a cable between them — nothing was drawn',
  await footer());
const kidsA3 = await outlineKids(A.id);
check('and A still cables to exactly two devices — no duplicate row',
  kidsA3.filter(t => /cable to/.test(t)).length === 2, JSON.stringify(kidsA3));
check('no extra hand stroke was drawn for the no-op', (await handStrokes()) === 2);

// ---- 4. UNKNOWN FAR END — A ONE-ENDED CABLE, LABELLED -----------------------

console.log('\n4. AN UNKNOWN FAR END');
await selectBox(C.id);
await cableHoldFromHere();
await mintPort('ge-0/0/2');
await selectBox(A.id); // whatever is selected when "cable them" opens is irrelevant to "unknown"
await cableThem();
await page.fill('#cCableLabel', 'wan-uplink');
await page.click('[data-dcableunknown]');
await page.waitForTimeout(200);
check('an unknown far end still draws (a one-ended cable is legal, Terminates.out: 0..2)',
  (await footer()) === 'drew a cable — it is marked as drawn by hand');
check('and it draws NO line — D4/D10: a one-ended cable lives only in the Outline',
  (await handStrokes()) === 2, (await handStrokes()) + ' strokes (want 2, unchanged)');
const kidsC = await outlineKids(C.id);
check('the one-ended cable is listed under its device, by its label, by hand',
  kidsC.some(t => /cable/.test(t) && /wan-uplink/.test(t) && /far end unmodelled/.test(t) && /by hand/.test(t)),
  JSON.stringify(kidsC));

// ---- 5. A PASTED DEVICE, CABLED — ITS CHASSIS MINTED SILENTLY (D5) ---------

console.log('\n5. A PASTED DEVICE HAS NO CHASSIS UNTIL THE GESTURE MINTS ONE');
await pasteConfig('set system host-name srx-cable-01\n');
await page.click('[data-view="diagram"]');
await page.waitForTimeout(200);
rows = await deviceRows();
const P = rows.find(r => /srx-cable-01/.test(r.text));
check('the pasted device is on the canvas', !!P);
const kidsPBefore = await outlineKids(P.id);
check('and it has no chassis row yet — nothing paste-side ever builds one',
  !kidsPBefore.some(t => /made of/.test(t)), JSON.stringify(kidsPBefore));

await selectBox(P.id);
await cableHoldFromHere();
check('the sheet opens for a pasted device too, with no ports', await page.$eval('#csheet', n => !n.hidden));
await mintPort('ge-0/0/0');
// B's existing (unlabelled) port from step 1 — reused so A's own cable count
// (asserted later, after the round trip) stays at exactly two.
await selectBox(B.id);
await cableThem();
ports = await portList();
await pickExistingPort(ports[0].id);
await page.waitForTimeout(200);
check('the cable drew, on a device that had zero ports and zero chassis a moment ago',
  (await footer()) === 'drew a cable — it is marked as drawn by hand');
const kidsPAfter = await outlineKids(P.id);
check('the pasted device now shows a chassis row — minted silently, in the same batch (D5)',
  kidsPAfter.some(t => /made of/.test(t) && /HasChassis/.test(t)), JSON.stringify(kidsPAfter));
check('and its own cable row too',
  kidsPAfter.some(t => /cable (to|from)/.test(t) && /fw-cable-01/.test(t)), JSON.stringify(kidsPAfter));

// ---- 6. "NO CABLE — THESE JUST TALK" ---------------------------------------

console.log('\n6. THE REDIRECT SENTENCE');
await selectBox(B.id);
await cableHoldFromHere();
await page.click('[data-dcablenocable]');
await page.waitForTimeout(150);
check('the redirect names the connect controls, and nothing was drawn',
  (await footer()).includes('connect controls') && (await footer()).includes('not wired'),
  await footer());
check('and the sheet closed with nothing held',
  await page.$eval('#csheet', n => n.hidden) &&
  (await page.$eval('[data-dcablehold]', n => n.textContent)) === 'cable from here');

// ---- 7. ESCAPE MID-HOLD RELEASES (D12) -------------------------------------

console.log('\n7. ESCAPE RELEASES A HELD END');
await selectBox(B.id);
await cableHoldFromHere();
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('Escape while the picker is open just closes the picker',
  await page.$eval('#csheet', n => n.hidden));
check('and holds nothing — the strip button is back to its rest label',
  (await page.$eval('[data-dcablehold]', n => n.textContent)) === 'cable from here');

await selectBox(B.id);
await cableHoldFromHere();
await mintPort('ge-1/0/0');
check('now something IS held', (await page.$eval('[data-dcablehold]', n => n.getAttribute('aria-pressed'))) === 'true');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('Escape with no sheet open releases the held end — the gap this ADR closes (D12)',
  (await page.$eval('[data-dcablehold]', n => n.getAttribute('aria-pressed'))) === 'false' &&
  (await page.$eval('[data-dcablehold]', n => n.textContent)) === 'cable from here',
  await footer());
check('and says so', (await footer()) === 'released');
// Pressing it once more must find nothing left to press through — the
// corollary of the chooser's 2026-08-16 defect, checked in advance: a rung
// that is reachable but does not actually clear state would look identical
// to this one press and fail silently on the second.
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check('a second Escape does not error or re-announce a release that already happened',
  errors.length === 0);

// ---- 8. CUT: REMOVING A CABLE THROUGH THE INVENTORY (D8) -------------------

console.log('\n8. CUT');
await page.click('[data-view="inventory"]');
await page.waitForTimeout(150);
const CABLE_KIND_INDEX = await page.$$eval('[data-kind]', ns =>
  ns.findIndex(n => n.textContent === 'Cable'));
check('Cable is a kind on the inventory strip (D14)', CABLE_KIND_INDEX >= 0);
await page.click('[data-kind="' + CABLE_KIND_INDEX + '"]');
await page.waitForTimeout(150);
const cableRows = await page.$$eval('.invwrap table.inv tbody tr', trs =>
  trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())));
check('the picker-drawn cables are inventory rows, four of them',
  cableRows.length === 4, JSON.stringify(cableRows));
const wanRow = cableRows.find(r => r[0] === 'wan-uplink');
check('the one-ended cable is among them, findable by its label', !!wanRow, JSON.stringify(cableRows));

// Select the wan-uplink cable and cut it.
await page.click('[data-post]:has-text("wan-uplink")');
await page.waitForTimeout(150);
check('selecting it offers "remove this element"', await page.$('[data-remove]') !== null);
await page.click('[data-remove]');
await page.waitForTimeout(200);
check('cutting it says so, by name', (await footer()).includes('cut the cable'), await footer());

await page.click('[data-view="diagram"]');
await page.waitForTimeout(150);
const kidsCAfterCut = await outlineKids(C.id);
check('the cut cable no longer appears under its device — the DEVICE side of D8',
  !kidsCAfterCut.some(t => /wan-uplink/.test(t)), JSON.stringify(kidsCAfterCut));

// The port side of D8: cabled_peer must stop reporting it too, checked through
// the SAME picker the operator would actually use next.
await selectBox(C.id);
await cableHoldFromHere();
ports = await portList();
const wanPort = ports.find(p => p.label === 'ge-0/0/2');
check('and the port itself no longer shows "cabled to" anything (cabled_peer honours the tombstone)',
  !!wanPort && !/cabled to/.test(wanPort.note), JSON.stringify(ports));
await page.click('[data-dcablenocable]'); // close the sheet without holding anything
await page.waitForTimeout(100);

// ---- 9. EXPORT -> RELOAD -> IMPORT: EVERY CABLE, AND THE DETERMINISTIC MINT --

console.log('\n9. THE ROUND TRIP');
const download = await Promise.all([
  page.waitForEvent('download'),
  page.click('#tabExport'),
]).then(r => r[0]);
const saved = await download.path();
const doc = JSON.parse(readFileSync(saved, 'utf8'));
const cableOps = doc.ops.filter(o => o.op === 'cable');
check('the journal carries a cable op per gesture — draws and the one cut',
  cableOps.filter(o => o.mode === 1).length === 4 && cableOps.filter(o => o.mode === 0).length === 1,
  JSON.stringify(cableOps.map(o => o.mode)));
check('a draw record carries the RAW end specs, not the ids the reply minted',
  cableOps.filter(o => o.mode === 1).every(o => o.near && o.far && typeof o.near.tag === 'number'),
  JSON.stringify(cableOps.find(o => o.mode === 1)));

// Capture the unlabelled far port's id (B's port from step 1/3) BEFORE the
// reload, so the deterministic-mint claim is a comparison and not an
// assertion about a number nobody checked.
await page.click('[data-view="diagram"]');
await selectBox(A.id);
await cableHoldFromHere();
const beforePorts = await portList();
await page.click('[data-dcablenocable]');
await page.waitForTimeout(100);

await page.goto('about:blank');
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
check('after a reload the estate is gone, as it always was',
  (await page.$$('.inv tbody tr')).length === 0);

await page.setInputFiles('#importFile', saved);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
await page.click('[data-view="diagram"]');
await page.waitForFunction(() => document.querySelector('.dbox') !== null);

const rows2 = await deviceRows();
const A2 = rows2.find(r => /sw-cable-01/.test(r.text));
const B2 = rows2.find(r => /fw-cable-01/.test(r.text));
const C2 = rows2.find(r => /ap-cable-01/.test(r.text));
const P2 = rows2.find(r => /srx-cable-01/.test(r.text));
check('all four devices reopened under the SAME ids',
  A2 && A2.id === A.id && B2 && B2.id === B.id && C2 && C2.id === C.id && P2 && P2.id === P.id,
  JSON.stringify({ A: [A.id, A2 && A2.id], B: [B.id, B2 && B2.id] }));

await selectBox(A2.id);
await cableHoldFromHere();
const afterPorts = await portList();
check('THE DETERMINISTIC MINT: the same header replayed mints the SAME port ids, ' +
  'including the unlabelled one nothing else in this build had exercised before',
  JSON.stringify(beforePorts.map(p => p.id).sort()) === JSON.stringify(afterPorts.map(p => p.id).sort()),
  JSON.stringify({ before: beforePorts, after: afterPorts }));
await page.click('[data-dcablenocable]');
await page.waitForTimeout(100);

const kidsA4 = await outlineKids(A2.id);
check('A cables to exactly two devices after the round trip, same as before the reload',
  kidsA4.filter(t => /cable to/.test(t)).length === 2, JSON.stringify(kidsA4));
const kidsC4 = await outlineKids(C2.id);
check('the wan-uplink one-ended cable did NOT come back — it was cut before the export',
  !kidsC4.some(t => /wan-uplink/.test(t)), JSON.stringify(kidsC4));
const kidsP4 = await outlineKids(P2.id);
check('the pasted device\'s silently-minted chassis survived the round trip too',
  kidsP4.some(t => /made of/.test(t)), JSON.stringify(kidsP4));

await page.screenshot({ path: OUT + '/2026-08-29-cabling-reopened.png' });

// ---- 10. A HAND-TAMPERED RECORD IS NEVER GUESSED THROUGH --------------------
//
// `cableEndSpec`/`cableEndBytes` decode a JOURNAL RECORD, not just the
// picker's own output — and the sheet itself never builds anything but tag
// 0, 1 or 2. A record naming tag 3 (RESERVED for ExternalPeer, ADR-0038 §4;
// refused module-side today, `tag_three_is_refused` in cable.rs) can only
// arrive by a hand edit or corruption. The first cut of this decoder
// silently folded any tag that was not literally 0 or 1 into `{tag:2}` —
// turning a tampered or forward-declared tag-3 end into a legitimate-looking
// "unknown far end" and drawing a real one-ended cable nobody asked for,
// without the module's own tag-3 refusal ever getting a chance to fire. This
// proves the fix: the tag is forwarded to the module as given, and a replay
// that names an illegal tag is refused honestly, aborting the whole import,
// rather than silently reinterpreted into something legal.

console.log('\n10. A HAND-TAMPERED RECORD IS NEVER GUESSED THROUGH');
const tamperedDoc = JSON.parse(JSON.stringify(doc));
const drawOps = tamperedDoc.ops.filter(o => o.op === 'cable' && o.mode === 1);
check('setup: the export has a draw op to tamper', drawOps.length > 0, drawOps.length);
drawOps[0].far = { tag: 3, id: 'external-peer:doesnotexist' };
const tamperedPath = join(tmpdir(), 'fathom-cable-tamper.json');
writeFileSync(tamperedPath, JSON.stringify(tamperedDoc));

await page.goto('about:blank');
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.setInputFiles('#importFile', tamperedPath);
await page.waitForTimeout(300);

check('the tampered import is REFUSED, by name, not silently accepted',
  /refused/.test(await footer()) && /nothing was opened/.test(await footer()),
  await footer());
check('and it left no estate at all — the illegal tag never became a drawn cable',
  (await page.$$('.inv tbody tr')).length === 0);

// The untampered original import (already proved to work in §9) still works
// afterwards — this session did not lose the ability to import for real.
await page.setInputFiles('#importFile', saved);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
check('a real, untampered import still works after the refusal',
  (await page.$$('.inv tbody tr')).length > 0);

// ---- invariants that hold whatever this feature does -----------------------

check('exactly one network request per page load (the file itself), never a second origin',
  requests.filter(u => u !== 'about:blank').every(u => u === FILE), requests.join(','));
check('no page errors and no console errors', errors.length === 0, errors.join(' | '));

const bad = results.filter(r => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
await browser.close();
process.exit(bad.length ? 1 : 0);
