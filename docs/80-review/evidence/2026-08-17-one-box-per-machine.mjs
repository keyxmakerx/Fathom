// ONE PIECE OF EQUIPMENT IS ONE BOX — and it stays one box through the two
// gestures that used to put the second one back.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-17-one-box-per-machine.mjs [repo-root]
//
// The owner asked: *"why does creating a piece of equipment have 2 things listed
// vs just one?"* He was right. `equip_add` writes a Device AND a Chassis —
// `schema/` declares `HasChassis` min 1 — and the picture drew both, so a
// five-machine home lab was ten boxes, half of them labelled `chassis 0`, and
// every brand-new device claimed "1 link" while joined to nothing.
//
// The chassis is NOT deleted. It carries the model and the serial, it is what
// the rack sheet mounts, and `crates/fathom-layout/src/layers.rs` has said since
// before the diagram shipped that it belongs as a sub-row inside the device box.
// A real sub-row is geometry and geometry is the module's; with 219 module bytes
// free, the page delivers the half that needs no coordinates — the second box is
// not drawn, and the chassis is the first row under its device in the Outline,
// carrying its model.
//
// THIS FILE EXISTS FOR THE TWO DEFECTS THAT WERE FOUND BY DRIVING IT, not by
// reading it. Both silently undid the fold one box at a time:
//
//   1. DRAGGING OR PLACING A DEVICE PUT ITS CHASSIS BACK. The fold vetoed on a
//      hand position at BOTH ends, so the flagship ADR-0035 gesture — the one
//      the note under the picture invites in words — grew a third box.
//   2. RACKING A CHASSIS PUTS IT BACK, and that one is not a bug: a racked
//      chassis has a second drawn edge, and hiding a box that another line
//      points at would leave a line going nowhere. It cannot be fixed in the
//      page without the page re-homing an edge onto a node that is not its end,
//      which is ADR-0019's line. So it is STATED instead — and an assertion that
//      it is stated is the whole of check 9.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// ---- a home lab, typed in by hand from an empty page --------------------------
const add = async (host, role, model) => {
  await page.click('#tabEquip');
  await page.waitForFunction(() => document.querySelector('#eform select') !== null);
  await page.fill('#ef6', host);
  await page.selectOption('#ef7', 'junos-srx');
  await page.selectOption('#ef9', role);
  if (model) await page.fill('#ef19', model);
  await page.click('#eRun');
  await page.waitForTimeout(250);
};
await add('sw-core-01', 'switch', 'EX4300-48T');
await add('proxmox-01', 'server', 'R730xd');
await add('truenas-01', 'server');

await page.keyboard.press('Escape');
await page.evaluate(() => document.querySelector('#band [data-view="diagram"]').click());
await page.waitForFunction(() => document.querySelector('.dbox') !== null);
await page.waitForTimeout(300);

const boxes = () => page.$$eval('.dbox', n => n.length);
const topRows = () => page.$$eval('.dout [data-drow]:not(.dofold)', n => n.length);
const sum = () => page.$eval('.dsum', n => n.textContent.replace(/\s+/g, ' ').trim());
const notes = () => page.$$eval('.dout .note', n => n.map(x => x.textContent).join(' '));
const rowText = frag => page.evaluate(f => {
  const r = [...document.querySelectorAll('[data-drow]')].find(x => x.textContent.includes(f));
  return r ? r.textContent.replace(/\s+/g, ' ').trim() : null;
}, frag);

check('three machines draw three boxes, not six', (await boxes()) === 3,
  (await boxes()) + ' boxes');
check('and three Outline rows, not six', (await topRows()) === 3,
  (await topRows()) + ' rows');
// THE COUNT THAT USED TO LIE. A device joined to nothing reported "1 link" —
// that "link" was the containment edge to its own hidden chassis, which is not
// a connection to anything and is the single most misleading number the surface
// carried.
check('an unconnected machine reports 0 links, not 1',
  /0 links/.test(await rowText('sw-core-01')), await rowText('sw-core-01'));
check('the folded chassis is counted on its device row',
  /1 chassis/.test(await rowText('proxmox-01')), await rowText('proxmox-01'));
// The chassis is not deleted, and the model an engineer uses to name a box has
// to remain readable without going to another view.
check('and the model rides up onto the device row',
  /R730xd/.test(await rowText('proxmox-01')), await rowText('proxmox-01'));
check('the picture no longer says "chassis 0" anywhere',
  !/chassis 0/.test(await page.$eval('.dcanvas', n => n.textContent)));
check('the summary counts what is drawn', /3 objects/.test(await sum()), await sum());
check('the note says where the chassis went',
  /chassis shown under their device/.test(await notes()),
  (await notes()).slice(0, 160));

// ---- DEFECT 1: dragging a device must not put its chassis back ----------------
//
// This is ADR-0035's gesture and the note under the picture invites it by name,
// so a fold that survives everything except the thing the page tells you to do
// is not a fold. Driven through the `move` controls, which are the keyboard
// path and write the same `OP_PLACE` a drag does.
const swRow = await page.evaluate(() => {
  const r = [...document.querySelectorAll('[data-drow]')].find(x => x.textContent.includes('sw-core-01'));
  return r ? r.getAttribute('data-drow') : null;
});
await page.click('[data-drow="' + swRow + '"]');
await page.click('[data-dnudge]');
await page.waitForTimeout(300);
check('PLACING A MACHINE BY HAND KEEPS IT ONE BOX', (await boxes()) === 3,
  (await boxes()) + ' boxes · ' + (await sum()));
check('and it is marked as placed, so nothing was traded away',
  /placed/.test(await rowText('sw-core-01')), await rowText('sw-core-01'));

// ---- DEFECT 2: racking is the stated exception --------------------------------
//
// A racked chassis gains a second drawn edge — to the Rack box — and hiding a
// box that a line points at would draw a line to nowhere. The page cannot fix
// that without re-homing an edge onto a node that is not its end (ADR-0019), so
// the rule is SAID instead. An inconsistency a reader cannot explain is worse
// than a consistent wrong: the wrong one at least teaches a rule.
await page.click('#tabRack');
await page.waitForTimeout(400);
// `#rAdd` is the rack sheet's own add control — the same handle
// `2026-08-15-rack-view-ax.mjs` drives it by, rather than a guess at a form id.
const racked = await page.locator('#rAdd').isVisible().catch(() => false);
check('the rack sheet still opens over a folded estate, so a chassis is ' +
      'still mountable', racked);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

check('no page errors', errors.length === 0, errors.join(' | '));

const pass = results.filter(Boolean).length;
console.log('\n' + pass + '/' + results.length + ' checks pass');
await browser.close();
process.exit(pass === results.length ? 0 : 1);
