// ADR-0035's rack view, driven in the shipped artifact.
//
// This asks Chromium for the ACCESSIBLE TREE, not the DOM. A rack elevation
// drawn as <rect>s inside an aria-hidden <svg> announces nothing, and a
// disclosure contract declared on SVG nodes is a contract with no audience.
// This face is drawn in real DOM precisely so every box is a real focusable
// element with a real name -- so the bar is that the accessibility tree can
// see them, and that is what is asserted here.
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
await page.waitForFunction(() => document.getElementById('tabRack') !== null);

console.log('\n1. the rack view exists and is reachable');
check('a "rack view" tab is present', await page.locator('#tabRack').count() === 1);

// Build an estate by hand: two boxes, since a cluster's two halves in two
// racks is the case the model exists to express.
async function addBox(hostname, member) {
  await page.click('#tabEquip');
  await page.fill('#ef6', hostname);
  await page.selectOption('#ef7', 'junos-srx');
  const idx = await page.locator('#ef18').count();
  if (idx) await page.fill('#ef18', member);
  await page.click('#eRun');
  await page.waitForTimeout(50);
}
await addBox('srx-a', '0');
await addBox('srx-b', '1');

console.log('\n2. the empty state says what it cannot do, rather than showing nothing');
await page.click('#tabRack');
await page.waitForTimeout(50);
const empty = await page.locator('#rbody').innerText();
check('it says no config states rack position',
  /nothing in a pasted config says which rack/i.test(empty), empty.slice(0, 160));

console.log('\n3. a box can be placed by hand');
await page.click('#rAdd');
await page.waitForTimeout(50);
await page.fill('#mf300', 'R12');       // rack name
await page.fill('#mf301', '42');        // rack height
await page.selectOption('#mf302', 'ascending');
await page.fill('#mf304', '5');         // position_u
await page.fill('#mf305', '2');         // height_u
await page.selectOption('#mf306', 'front');
// Choose the FIRST chassis explicitly.
const chassisValues = await page.locator('#mfChassis option').evaluateAll(
  (os) => os.map((o) => o.value));
await page.selectOption('#mfChassis', chassisValues[0]);
await page.click('#mRun');
await page.waitForTimeout(80);

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
await page.keyboard.press('Escape');   // close, so focus starts clean
await page.click('#tabRack');
await page.waitForTimeout(50);
let reached = false;
for (let i = 0; i < 40 && !reached; i++) {
  await page.keyboard.press('Tab');
  reached = await page.evaluate(() => {
    const a = document.activeElement;
    return !!(a && a.classList && a.classList.contains('rbox'));
  });
}
check('a placed box can be reached with Tab alone', reached);

console.log('\n6. an unstated height is MARKED, never recorded as 1U');
await page.click('#rAdd');
await page.waitForTimeout(50);
await page.fill('#mf300', 'R12');
await page.fill('#mf301', '42');
await page.selectOption('#mf302', 'ascending');
await page.fill('#mf304', '20');
// height_u deliberately left blank
await page.selectOption('#mfChassis', chassisValues[1]);
await page.click('#mRun');
await page.waitForTimeout(80);
const marked = await page.locator('#rbody').innerText();
check('the unmeasured box says so in words',
  /height not stated, drawn as 1U/.test(marked), marked.slice(0, 400));
snap = await page.accessibility.snapshot();
flat = axFlat(snap);
check('and the accessible name says so too',
  flat.some((n) => n.role === 'button' && /height not stated/.test(n.name)),
  JSON.stringify(flat.filter((n) => n.role === 'button' && /srx-b/.test(n.name)).map((n) => n.name)));

console.log('\n7. re-placing an already-placed box is refused BY NAME');
await page.click('#rAdd');
await page.waitForTimeout(50);
await page.fill('#mf300', 'R99');
await page.fill('#mf301', '10');
await page.selectOption('#mf302', 'descending');
await page.fill('#mf304', '1');
await page.selectOption('#mfChassis', chassisValues[0]);   // already in R12
await page.click('#mRun');
await page.waitForTimeout(80);
check('the refusal names the reason rather than silently moving the box',
  await page.locator('#mErr').isVisible()
    && /already in a rack/.test(await page.locator('#mErr').innerText()),
  await page.locator('#mErr').innerText().catch(() => '(no error shown)'));

console.log('\n8. the numbering direction reaches the picture');
// A third box, into a DESCENDING frame. Same arithmetic, opposite direction:
// U1 must be the TOP row here and the BOTTOM row in R12.
// Escape unwinds ONE level: the placement form returns to the rack view that
// opened it. So two presses to reach the page — which is itself the contract
// 53 §3.7 asks for, and is asserted here rather than assumed.
await page.keyboard.press('Escape');
await page.waitForTimeout(50);
check('esc from the placement form returns to the rack view, not to the page',
  await page.locator('#rsheet').isVisible() && !(await page.locator('#msheet').isVisible()));
await page.keyboard.press('Escape');
await page.waitForTimeout(50);
check('a second esc closes the rack view',
  !(await page.locator('#rsheet').isVisible()));
await addBox('srx-c', '0');
await page.click('#tabRack');
await page.waitForTimeout(50);
await page.click('#rAdd');
await page.waitForTimeout(50);
const allChassis = await page.locator('#mfChassis option').evaluateAll(
  (os) => os.map((o) => o.value));
await page.fill('#mf300', 'R99');
await page.fill('#mf301', '10');
await page.selectOption('#mf302', 'descending');
await page.fill('#mf304', '1');
await page.selectOption('#mfChassis', allChassis[allChassis.length - 1]);
await page.click('#mRun');
await page.waitForTimeout(80);
const desc = await page.locator('#rbody').innerText();
check('a descending frame reports U1 at the top', /U1 at the top/.test(desc),
  desc.slice(0, 200));
// The gutter's first row is the unit nearest the top of the drawing. Under
// descending numbering that is U1; under ascending it would be U10.
const firstUnit = await page.locator('#rbody .relev .ru .u').first().innerText();
check('and the TOP row of the drawing is U1, not U10', firstUnit.trim() === '1', firstUnit);
// The same assertion inverted, on the ascending frame.
await page.locator('.rpick button', { hasText: 'R12' }).first().click();
await page.waitForTimeout(50);
const topUnitAsc = await page.locator('#rbody .relev .ru .u').first().innerText();
check('while the ascending frame draws U42 at the top', topUnitAsc.trim() === '42', topUnitAsc);

console.log('\n9. the face states its own limits');
const limits = await page.locator('#rbody').innerText();
check('it says nothing here was parsed',
  /Nothing here was parsed/i.test(limits), limits.slice(-320));
check('it says floor, building and map are not built',
  /Floor, building and map are not built/i.test(limits), limits.slice(-320));

console.log('\n10. invariant 1 — no egress');
const offFile = requests.filter((u) => !u.startsWith('file://'));
check(`zero non-file requests (saw ${requests.length} total)`, offFile.length === 0,
  offFile.join(', '));

console.log('\n11. evidence');
await page.screenshot({ path: resolve(here, '2026-08-15-rack-view.png'), fullPage: false });
console.log('  wrote 2026-08-15-rack-view.png');

console.log(`\n${pass}/${pass + fail} checks passed`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
