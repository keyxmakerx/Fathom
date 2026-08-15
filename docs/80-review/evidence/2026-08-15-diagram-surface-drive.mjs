// Drive the real page in Chromium and ASSERT ON THE DOM. The screenshots beside
// this file are not the evidence; these assertions are, and a screenshot that
// disagrees with them is a screenshot of a different build.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-15-diagram-surface-drive.mjs [repo-root]
//
// Playwright and Chromium are the ones already on this machine; neither is a
// dependency of the product and neither is in Cargo.lock (gate zero).
//
// The narrow-viewport case -- which is where the previous attempt broke -- is
// the sibling file, `-edges.mjs`. This one is the surface at a desk.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const OUT = ROOT + '/docs/80-review/evidence';

const CONFIG = `set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces ge-0/0/1 unit 0 family inet address 10.10.0.1/24
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security ike gateway gw-hq address 198.51.100.10
set security ike gateway gw-hq external-interface ge-0/0/0.0
set security ipsec vpn hq-vpn ike gateway gw-hq
set security ipsec vpn hq-vpn bind-interface st0.0
set security zones security-zone trust interfaces ge-0/0/1.0
set security zones security-zone untrust interfaces ge-0/0/0.0
set security zones security-zone vpn interfaces st0.0
`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const requests = [];
page.on('request', r => requests.push(r.url()));
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// ---- load an estate through the only door the product has -------------------
await page.click('#tabPaste');
await page.fill('#pta', CONFIG);
await page.click('#pRun');
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);

// The kind strip's real contents, read off the page rather than assumed. The
// previous attempt's driver exercised ONE box, which happened to be a kind the
// strip has; six of fifteen were kinds it does not.
const STRIP = await page.$$eval('[data-kind]', ns => ns.map(n => n.textContent));

// ---- into the diagram -------------------------------------------------------
await page.click('[data-view="diagram"]');
await page.waitForSelector('.dcanvas svg');

const objects = await page.$$eval('.dbox', n => n.length);
const rows = await page.$$eval('[data-drow]', n => n.length);
check('one Outline row per drawn box', objects > 0 && objects === rows,
  objects + ' boxes, ' + rows + ' rows');

check('focus never enters the svg: no shape is focusable',
  await page.$$eval('.dcanvas svg [tabindex]', n => n.length) === 0);
check('the svg is aria-hidden (55 §10 item 6)',
  await page.getAttribute('.dcanvas svg', 'aria-hidden') === 'true');
check('no role=img on a manipulation surface (55 §4.5.1)',
  await page.getAttribute('.dcanvas svg', 'role') === null);
// M32's reasoning applies to a LINE verbatim, which the previous attempt
// disclosed as a decision and the reviewer took as a defect: a tooltip inside an
// aria-hidden subtree is mouse-hover-only, `55` §1.4's impossible failure.
check('no <title> survives anywhere in the picture (56 §2.4/§5.7, M32)',
  await page.$$eval('.dcanvas svg title', n => n.length) === 0);
check('every stroke is non-scaling (56 §5.3)',
  await page.$$eval('.dcanvas svg rect, .dcanvas svg path',
    ns => ns.every(n => n.getAttribute('vector-effect') === 'non-scaling-stroke')));

// ---- FIT ---------------------------------------------------------------------
const readTransform = () => page.$eval('.dscene', n => n.getAttribute('transform'));
const zoomOf = async () => parseFloat((await page.textContent('.dzoom')).replace('×', ''));

await page.click('[data-dfit]');
const fitT = await readTransform();
const fitZ = await zoomOf();
check('fit gives a readable zoom and a real transform',
  /translate\([-\d.]+ [-\d.]+\) scale\([\d.]+\)/.test(fitT) && fitZ > 0,
  fitT + '  readout ' + fitZ.toFixed(2));

const insideCanvas = () => page.evaluate(() => {
  const c = document.querySelector('.dcanvas').getBoundingClientRect();
  return Array.from(document.querySelectorAll('.dbox rect')).every(r => {
    const b = r.getBoundingClientRect();
    return b.left >= c.left - 1 && b.right <= c.right + 1
        && b.top >= c.top - 1 && b.bottom <= c.bottom + 1;
  });
});
check('after fit every box is inside the canvas', await insideCanvas());

// ---- ZOOM TO THE CURSOR, not the origin -------------------------------------
const box = await page.$('.dcanvas');
const cbb = await box.boundingBox();
const before = await page.$eval('.dbox rect', r => {
  const b = r.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
});
await page.mouse.move(before.x, before.y);
await page.mouse.wheel(0, -600);
const zAfter = await zoomOf();
const after = await page.$eval('.dbox rect', r => {
  const b = r.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
});
const drift = Math.hypot(after.x - before.x, after.y - before.y);
check('wheel zooms IN', zAfter > fitZ, fitZ.toFixed(2) + ' -> ' + zAfter.toFixed(2));
check('the point under the cursor stays put (drift < 12 px)', drift < 12,
  'drift ' + drift.toFixed(1) + ' px');
check('a hairline is still 1px at ' + zAfter.toFixed(2) + 'x',
  await page.$eval('.dbox rect', r => getComputedStyle(r).strokeWidth) === '1px');

// ---- PAN ---------------------------------------------------------------------
// FROM THE BACKGROUND, and this line changed with ADR-0035. A press on a BOX is
// now a placement gesture, not a pan, so a pan test that starts on whatever
// happens to be under the canvas centre is testing whichever of the two the
// zoom left there. The empty point is computed rather than guessed: walk a grid
// over the canvas and take the first spot `elementFromPoint` says is the canvas
// itself. If the picture ever fills the canvas completely this returns null and
// the check fails loudly instead of silently panning from a box.
const empty = await page.evaluate(() => {
  const c = document.querySelector('.dcanvas');
  const r = c.getBoundingClientRect();
  for (let y = r.top + 8; y < r.bottom - 8; y += 12) {
    for (let x = r.left + 8; x < r.right - 8; x += 12) {
      const at = document.elementFromPoint(x, y);
      if (at === c || (at && at.tagName === 'svg')) return { x, y };
    }
  }
  return null;
});
check('the canvas has background to pan from', empty !== null, JSON.stringify(empty));
const panBefore = await readTransform();
await page.mouse.move(empty.x, empty.y);
await page.mouse.down();
await page.mouse.move(empty.x - 140, empty.y - 60, { steps: 8 });
await page.mouse.up();
const panAfter = await readTransform();
const parse = t => t.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/).slice(1).map(Number);
const [bx, by, bk] = parse(panBefore), [ax, ay, ak] = parse(panAfter);
check('drag pans by exactly the pointer delta',
  Math.abs((ax - bx) + 140) < 2 && Math.abs((ay - by) + 60) < 2,
  'dx ' + (ax - bx).toFixed(0) + '  dy ' + (ay - by).toFixed(0));
check('a pan does not change the zoom', ak === bk);
check('a pan that moved did not also select',
  await page.$$eval('.dsel', n => n.length) === 0);

// ---- THE PAN IS BOUNDED -------------------------------------------------------
// The previous build let a drag push the scene off the canvas and keep going --
// measured, translate x 24 -> 224 and continuing indefinitely -- recoverable
// only by knowing about `z`. Six full-width drags in one direction now stop.
await page.click('[data-dfit]');
for (let i = 0; i < 6; i++) {
  await page.mouse.move(cbb.x + 60, cbb.y + cbb.height / 2);
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
           transform: document.querySelector('.dscene').getAttribute('transform') };
});
check('a pan cannot push the whole picture off the canvas', pushed.touching >= 1,
  pushed.touching + '/' + pushed.total + ' still on screen · ' + pushed.transform);

// ---- ZOOM BOUNDS --------------------------------------------------------------
await page.click('[data-dfit]');
await page.mouse.move(cbb.x + cbb.width / 2, cbb.y + cbb.height / 2);
for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 900);
const floor = await zoomOf();
for (let i = 0; i < 80; i++) await page.mouse.wheel(0, -900);
const ceil = await zoomOf();
check('zoom is bounded below', floor >= 0.2 - 1e-9 && floor <= 0.21, 'floor ' + floor);
check('zoom is bounded above', ceil === 4, 'ceiling ' + ceil);

// ---- LEVEL OF DETAIL, and the count in the band -------------------------------
await page.click('[data-dfit]');
await page.mouse.move(cbb.x + cbb.width / 2, cbb.y + cbb.height / 2);
for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 900);
const lod = await page.getAttribute('.dcanvas svg', 'data-lod');
const band = await page.textContent('.dband');
check('at the zoom floor the labels are off', lod === '0',
  'data-lod=' + lod + ' at ' + (await zoomOf()));
check('the band COUNTS what it dropped (56 §5.5, 59 §6.2)',
  /\d+ (kind )?labels? off/.test(band), band.trim());
check('the name really is not drawn at the floor',
  await page.$eval('.dname', n => getComputedStyle(n).display) === 'none');

// At fit, whatever rung the fit zoom lands on, the band and the rung must agree
// -- and every suppression carries a cardinal. Asserting one particular rung
// here would be asserting the window size: this fixture fits at 0.34x in a
// 1400 px window and would fit at a different rung in another.
await page.click('[data-dfit]');
const fitLod = await page.getAttribute('.dcanvas svg', 'data-lod');
const fitBand = await page.textContent('.dband');
check('at fit the band and the level-of-detail rung agree, with a cardinal',
  fitLod === '2' ? !/labels? off/.test(fitBand)
  : fitLod === '1' ? /\d+ kind labels? off/.test(fitBand)
  : /\d+ labels? off/.test(fitBand) && !/kind label/.test(fitBand),
  'lod ' + fitLod + ' · ' + fitBand.trim());

// ---- KEYBOARD: walk the outline, ring follows, scene reveals -------------------
const first = await page.$('[data-drow]');
await first.focus();
check('focusing an Outline row draws the ring in the picture',
  await page.$eval('.dring', r => r.getAttribute('visibility')) === 'visible');
const ringBox1 = await page.$eval('.dring', r => r.getBoundingClientRect().x);

await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
const focusedId = await page.evaluate(() => document.activeElement.getAttribute('data-drow'));
const ringBox2 = await page.$eval('.dring', r => r.getBoundingClientRect().x);
check('arrow keys move focus between boxes', !!focusedId, focusedId);
check('the ring follows the focused row', ringBox1 !== ringBox2);
check('the focused row shows the product\'s one focus ring (51 §4.7)',
  await page.evaluate(() => {
    const a = document.activeElement;
    return a.matches(':focus-visible')
      && getComputedStyle(a).outlineWidth === '2px'
      && getComputedStyle(a).outlineStyle === 'solid';
  }));
check('the focus ring is 2 CSS px',
  await page.$eval('.dring', r => getComputedStyle(r).strokeWidth) === '2px');

await page.mouse.move(cbb.x + 200, cbb.y + 200);
await page.mouse.wheel(0, -1200);
check('the focus ring is still 2 CSS px zoomed in',
  await page.$eval('.dring', r => getComputedStyle(r).strokeWidth) === '2px',
  'at zoom ' + (await zoomOf()).toFixed(2));
await page.click('[data-dfit]');

// ---- KEYBOARD: follow an edge --------------------------------------------------
const linked = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-drow]'));
  const r = rows.find(x => !/^0 /.test(x.querySelector('.docnt').textContent));
  return r ? r.getAttribute('data-drow') : null;
});
check('some object has links to follow', !!linked, linked);
await (await page.$('[data-drow="' + linked + '"]')).focus();
await page.keyboard.press('ArrowRight');
check('ArrowRight expands the row into its connections',
  (await page.getAttribute('[data-drow="' + linked + '"]', 'aria-expanded')) === 'true' &&
  (await page.$$eval('[data-dparent="' + linked + '"]', n => n.length)) > 0,
  (await page.$$eval('[data-dparent="' + linked + '"]', n => n.length)) + ' connections');
await page.keyboard.press('ArrowRight');
const onLink = await page.evaluate(() => document.activeElement.getAttribute('data-dlink'));
check('ArrowRight again moves onto a connection row', !!onLink, onLink);
await page.keyboard.press('Enter');
check('Enter on a connection follows the edge to the far object',
  (await page.evaluate(() => document.activeElement.getAttribute('data-drow'))) === onLink);
check('the far object is now selected in the picture',
  await page.$eval('.dsel', n => n.getAttribute('data-dpost')) === onLink);
check('and in the inspector', (await page.textContent('#mRibbon')).includes(onLink));

// ---- z fits, and the strip buttons ----------------------------------------------
await page.mouse.move(cbb.x + 300, cbb.y + 300);
await page.mouse.wheel(0, -1500);
await page.keyboard.press('z');
check('z zooms to fit (53 §3.4)', Math.abs((await zoomOf()) - fitZ) < 0.01);
await page.click('[data-dzoom="1.25"]');
const zIn = await zoomOf();
await page.click('[data-dzoom="0.8"]');
const zOut = await zoomOf();
check('the zoom buttons work in both directions',
  zIn > fitZ && Math.abs(zOut - fitZ) < 0.01, fitZ + ' -> ' + zIn + ' -> ' + zOut);
check('the live region says what happened',
  (await page.textContent('#live')).includes('zoom'), await page.textContent('#live'));

// ---- SELECTION BOTH WAYS, FOR EVERY DRAWN BOX ------------------------------------
//
// DEFECT 2. The previous build did
//     var ki = KINDS.indexOf(b.kind); if (ki >= 0 && ki !== S.invKind) loadKind(ki);
// and skipped the branch in SILENCE when the kind was not in the strip -- so for
// LogicalUnit and Address, six of that fixture's fifteen boxes, the user landed
// on an unrelated kind with zero rows marked. Every box is driven here, and the
// kinds the strip cannot reach must DECLINE VISIBLY rather than no-op.
await page.click('[data-dfit]');
const ids = await page.$$eval('.dbox', ns => ns.map(n => n.getAttribute('data-dpost')));
const kindOf = await page.evaluate(() => {
  const out = {};
  document.querySelectorAll('[data-drow]').forEach(r => {
    out[r.getAttribute('data-drow')] = r.querySelector('.dokind').textContent;
  });
  return out;
});
let reachable = 0, declined = 0;
for (const id of ids) {
  await page.click('[data-dfit]');
  await page.click('[data-dpost="' + id + '"] rect');
  const kind = kindOf[id];
  const inStrip = STRIP.indexOf(kind) >= 0;
  const foot = await page.textContent('#fMsg');
  const live = await page.textContent('#live');
  const bandNow = await page.textContent('.dband');
  const rowNoSet = await page.$eval('[data-drow="' + id + '"]',
    r => r.getAttribute('data-noset') === '1');
  if (inStrip) {
    reachable++;
    await page.click('[data-view="inventory"]');
    const marked = await page.$$eval('tr[data-tier="primary"] button[data-post]',
      ns => ns.map(n => n.getAttribute('data-post')));
    const pressed = await page.$$eval('[data-kind][aria-pressed="true"]', ns => ns.map(n => n.textContent));
    check('diagram -> inventory: ' + kind + ' lands on its own row',
      marked[0] === id && pressed[0] === kind,
      'strip ' + pressed.join(',') + ' · marked ' + marked.length);
    await page.click('[data-view="diagram"]');
    await page.waitForSelector('.dcanvas svg');
  } else {
    declined++;
    check('diagram -> inventory: ' + kind + ' declines OUT LOUD, in the footer',
      foot.indexOf(kind) >= 0 && /no row set/.test(foot), foot);
    check('  · and in the live region', live.indexOf(kind) >= 0 && /no row set/.test(live));
    check('  · and in the band, which keeps saying it', /no row set/.test(bandNow), bandNow.trim());
    check('  · and on the row itself, before you ever click it', rowNoSet);
  }
}
check('the fixture exercises both halves of the branch',
  reachable > 0 && declined > 0, reachable + ' reachable, ' + declined + ' declined');

// ---- the tab stop follows a MOUSE selection too (defect 5) -------------------------
await page.click('[data-dfit]');
const sixth = ids[5];
await page.click('[data-dpost="' + sixth + '"] rect');
check('clicking a box moves the Outline\'s one tab stop onto its row (55 §5.6)',
  (await page.getAttribute('[data-drow="' + sixth + '"]', 'tabindex')) === '0' &&
  (await page.$$eval('[data-drow][tabindex="0"]', n => n.length)) === 1,
  'stops at tabindex 0: ' + (await page.$$eval('[data-drow][tabindex="0"]', n => n.length)));

// ---- clicking empty canvas clears (defect 4, 56 §6.1) ------------------------------
check('something is selected before the clear', (await page.$$eval('.dsel', n => n.length)) === 1);
await page.mouse.click(cbb.x + 6, cbb.y + 6);
check('clicking empty canvas clears the selection (56 §6.1)',
  (await page.$$eval('.dsel', n => n.length)) === 0 &&
  (await page.textContent('#mRibbon')) === '',
  'ribbon: ' + JSON.stringify(await page.textContent('#mRibbon')));
check('the ring goes with it',
  (await page.$eval('.dring', r => r.getAttribute('visibility'))) === 'hidden');

// ---- Escape does not strand focus on <body> (defect 6, 55 §5.6) --------------------
await page.click('[data-dpost="' + sixth + '"] rect');
await (await page.$('[data-drow="' + sixth + '"]')).focus();
check('focus is on the row before Escape',
  (await page.evaluate(() => document.activeElement.getAttribute('data-drow'))) === sixth);
await page.keyboard.press('Escape');
const landed = await page.evaluate(() => ({
  tag: document.activeElement.tagName, id: document.activeElement.id }));
check('Escape moves focus to the Outline\'s heading, not to <body> (55 §5.6)',
  landed.id === 'doutHead', JSON.stringify(landed));
check('and the selection is gone', (await page.$$eval('.dsel', n => n.length)) === 0);

// ---- inventory -> diagram ----------------------------------------------------------
await page.click('[data-view="inventory"]');
await page.click('[data-kind="0"]');
const devId = await page.$eval('.inv tbody button[data-post]', b => b.getAttribute('data-post'));
await page.click('button[data-post="' + devId + '"]');
await page.click('[data-view="diagram"]');
await page.waitForSelector('.dcanvas svg');
check('a row picked in the inventory is the selected box in the diagram',
  await page.$eval('.dsel', n => n.getAttribute('data-dpost')) === devId, devId);
check('and it is inside the viewport (56 §6.2 reveal)', await page.evaluate((id) => {
  const c = document.querySelector('.dcanvas').getBoundingClientRect();
  const b = document.querySelector('[data-dpost="' + id + '"] rect').getBoundingClientRect();
  return b.left >= c.left && b.right <= c.right && b.top >= c.top && b.bottom <= c.bottom;
}, devId));
check('Tab lands on the row you chose, not on row 0',
  (await page.evaluate((id) =>
    document.querySelector('[data-drow="' + id + '"]').getAttribute('tabindex'), devId)) === '0');

// ---- the transform survives a view switch ------------------------------------------
await page.mouse.move(cbb.x + 400, cbb.y + 300);
await page.mouse.wheel(0, -900);
const keptZoom = await zoomOf();
await page.click('[data-view="inventory"]');
await page.click('[data-view="diagram"]');
check('zoom survives a view switch (52 §10 session state)',
  Math.abs((await zoomOf()) - keptZoom) < 1e-9, keptZoom.toFixed(2) + 'x kept');

await page.keyboard.press('Escape');
await page.waitForSelector('.dcanvas svg');
await page.mouse.move(cbb.x + 380, cbb.y + 260);
await page.mouse.wheel(0, -300);
const keptT = await readTransform();
await page.click('[data-view="inventory"]');
await page.click('[data-view="diagram"]');
check('pan survives a view switch when nothing is selected',
  (await readTransform()) === keptT, keptT);

// ---- a keyboard-driven pan is not thrown away by a resize (defect 7) ---------------
// dgReveal never set DG.touched, so arrow-walking the Outline to bring a box into
// view was silently undone by the next resize.
await page.click('[data-dfit]');
await page.mouse.move(cbb.x + cbb.width / 2, cbb.y + cbb.height / 2);
await page.mouse.wheel(0, -1400);                    // zoom in so a reveal must pan
const walkFrom = await readTransform();
await (await page.$('[data-drow]')).focus();
for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
const walked = await readTransform();
check('walking the Outline pans the scene', walked !== walkFrom, walkFrom + ' -> ' + walked);
await page.setViewportSize({ width: 1380, height: 900 });
await page.waitForTimeout(180);
check('and a resize does not refit that away (defect 7)',
  (await readTransform()) === walked, await readTransform());
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(180);

// ---- one attribute write per pan frame ----------------------------------------------
const writes = await page.evaluate(async () => {
  const scene = document.querySelector('.dscene');
  let n = 0;
  const obs = new MutationObserver(ms => { n += ms.length; });
  obs.observe(document.querySelector('.dcanvas'),
    { attributes: true, subtree: true, childList: true });
  const c = document.querySelector('.dcanvas').getBoundingClientRect();
  document.querySelector('.dcanvas').dispatchEvent(new PointerEvent('pointerdown',
    { bubbles: true, clientX: c.x + 300, clientY: c.y + 300, button: 0, pointerId: 7,
      pointerType: 'mouse' }));
  for (let i = 1; i <= 20; i++) {
    document.dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, clientX: c.x + 300 + i * 4, clientY: c.y + 300, pointerId: 7,
        pointerType: 'mouse' }));
  }
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
  await new Promise(r => setTimeout(r, 50));
  obs.disconnect();
  return { n, frames: 20, transform: scene.getAttribute('transform') };
});
check('a pan writes one attribute per frame (44 §4.7.1)',
  writes.n <= writes.frames + 2,
  writes.n + ' mutations over ' + writes.frames + ' move events');

// ---- theme, both ways ------------------------------------------------------------
await page.click('#tabTheme');
await page.click('#tabTheme');
await page.click('[data-dfit]');
const darkInk = await page.$eval('.dname', n => getComputedStyle(n).fill);
check('the picture repaints for the dark theme', darkInk !== 'rgb(20, 23, 26)', darkInk);
await page.screenshot({ path: OUT + '/2026-08-15-diagram-surface-dark.png' });
await page.click('#tabTheme');

// ---- egress, invariant 1 ------------------------------------------------------------
check('exactly one network request, the file itself',
  requests.length === 1 && requests[0] === FILE, requests.join(', '));
check('no page errors', errors.length === 0, errors.join(' | '));

await page.click('[data-drow]');
await page.screenshot({ path: OUT + '/2026-08-15-diagram-surface.png' });

await browser.close();

const failed = results.filter(r => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks pass');
if (failed.length) { console.log('FAILURES:'); failed.forEach(f => console.log('  ' + f.name + '  ' + (f.detail || ''))); }
process.exit(failed.length ? 1 : 0);
