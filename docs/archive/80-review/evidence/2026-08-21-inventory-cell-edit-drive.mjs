// THE INVENTORY BECOMES EDITABLE, driven through the shipped artifact in
// Chromium, asserting on the DOM and on the accessible tree.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-21-inventory-cell-edit-drive.mjs [repo-root]
//
// `52` §3.7 has said since it was written that the inventory "lets you change
// field values, in place, in the cell", and until today it did not. The reason
// was never that the store could not take a correction — `OP_FIELD_SET` has
// been able to write one field of one element since 2026-08-11. It was that the
// only door to it was whatever form somebody had remembered to build, so four
// fields on the equipment sheet could be corrected and the rest of the schema
// could not.
//
// WHY THIS IS A BROWSER DRIVER AND NOT A UNIT TEST. This project has a written
// record of defects that were invisible to every unit test because the module
// was correct at both ends and the PAGE was what guessed — a click handler that
// pre-confirmed a paste, a chooser that drew a link when asked to cut one.
// Every claim below is about what a person sitting in front of the artifact
// sees and reaches, so every one of them is asserted here.
//
// **NOTHING IS PASTED.** The lab is typed in from an empty page, which is also
// the state the owner starts from.
//
// Playwright and Chromium are the ones already on this machine; neither is a
// dependency of the product and neither is in Cargo.lock (gate zero).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const OUT = ROOT + '/docs/80-review/evidence';
const JOURNAL = '/tmp/claude-0/-home-user-Fathom/6b99fe87-c207-5a7a-a276-aace66402f90/scratchpad/cell-edit.json';

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

// --- reading the table, always from the DOM -------------------------------

// One row's cells as the page renders them, by hostname. `textContent` of the
// <td> rather than of the button, so a cell holding an editor reads as whatever
// the editor holds and a cell holding a value reads as the value.
const rowCells = (hostname) => page.evaluate((h) => {
  const tr = [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .find(r => r.querySelector('td') && r.querySelector('td').textContent.trim() === h);
  return tr ? [...tr.querySelectorAll('td')].map(td => td.textContent.trim()) : null;
}, hostname);

// The cell button at (hostname, column), described. Null when that cell is
// currently an editor rather than a button.
const cellInfo = (hostname, col) => page.evaluate(([h, c]) => {
  const tr = [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .find(r => r.querySelector('td') && r.querySelector('td').textContent.trim() === h);
  if (!tr) return null;
  const b = tr.querySelector('td button[data-icol="' + c + '"]');
  if (!b) return null;
  return {
    text: b.textContent,
    label: b.getAttribute('aria-label'),
    editable: b.hasAttribute('data-iedit'),
    key: b.getAttribute('data-iedit'),
    marked: b.classList.contains('icell'),
    post: b.getAttribute('data-post'),
  };
}, [hostname, String(col)]);

// What has focus, said in the terms this table is built from.
const focused = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return { tag: 'BODY' };
  return {
    tag: a.tagName,
    cls: a.className || '',
    icol: a.getAttribute ? a.getAttribute('data-icol') : null,
    post: a.getAttribute ? a.getAttribute('data-post') : null,
    value: a.value === undefined ? null : a.value,
  };
});

// Add one box through the real equipment form. `ef6` is `Device.hostname`,
// `ef7` `Device.platform`, `ef9` `Device.role` — the ids are built from the
// schema's own wire keys, which is why they are numbers.
async function addBox(hostname, role, want) {
  await page.click('#tabEquip');
  await page.waitForFunction(() => document.querySelector('#eform select') !== null);
  await page.fill('#ef6', hostname);
  await page.selectOption('#ef7', 'junos-srx');
  await page.selectOption('#ef9', role);
  await page.click('#eRun');
  await page.waitForFunction(
    n => document.querySelectorAll('.inv tbody tr').length === n, want);
}

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

check('the page starts with no estate at all',
  (await page.$$('.inv tbody tr')).length === 0);

await addBox('fw-lab-01', 'firewall', 1);
await addBox('sw-lab-01', 'switch', 2);

// ---- WHICH CELLS OFFER AN EDITOR, AND WHICH DO NOT --------------------------
// The answer is the module's. `fathom_inventory::column_keys` sends one record
// per reply saying which columns are the row's own typeable fields; the page
// renders what it is told and forms no opinion. DEVICE_COLUMNS is hostname,
// platform, os_version, role, premises, name_conformance.
const offered = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('.invwrap table.inv thead th')]
    .map(th => th.textContent.trim());
  const tr = document.querySelector('.invwrap table.inv tbody tr');
  return [...tr.querySelectorAll('td button[data-icol]')]
    .filter(b => b.hasAttribute('data-iedit'))
    .map(b => heads[Number(b.getAttribute('data-icol'))]);
});
check('the editable Device columns are its own typeable fields',
  JSON.stringify(offered) === JSON.stringify(['hostname', 'platform', 'os_version', 'role']),
  offered.join(', '));

// `premises` is the case worth naming. It renders exactly like any other cell
// and it is a TRAVERSAL — Device -> Site -> Premises label — so there is no
// field of this row behind it and nothing a typed value could be written to.
// A page that decided by column name would have offered it.
const prem = await cellInfo('fw-lab-01', 4);
check('`premises` is a walk, so it is never offered as editable',
  prem !== null && prem.editable === false, JSON.stringify(prem));
// `name_conformance` is the other reason a column stays read-only: it IS a
// field of this row, and its declared type is one `author.rs` cannot parse from
// text yet. A cell that looked editable and refused every value would be worse
// than one that never offered.
const conf = await cellInfo('fw-lab-01', 5);
check('a field whose type cannot be typed in is not offered either',
  conf !== null && conf.editable === false, JSON.stringify(conf));

// ---- THE MARK IS IN THE ACCESSIBLE TREE, NOT ONLY UNDER THE PIXELS ---------
// `55` §1.4 lists "content hidden behind hover" among the defects this design
// cannot have, and `55` §5 is keyboard-only operation. The hairline under an
// editable value has no screen-reader equivalent, so the cell says it in its
// own name.
const role0 = await cellInfo('sw-lab-01', 3);
check('an editable cell is marked for the eye',
  role0.marked === true, 'class icell');
check('and says so in its accessible name',
  /— editable$/.test(role0.label || '') && role0.label.indexOf('role: switch') === 0,
  role0.label);
// The mark itself: the page's own quiet-control span, the one `.utils button
// .u` already wears, so this is a re-used idiom rather than a new one.
check('the mark is the page\'s existing quiet-control underline',
  await page.evaluate((p) => {
    const b = document.querySelector('.invwrap table.inv td button[data-post="' + p + '"][data-icol="3"]');
    const u = b && b.querySelector('span.u');
    if (!u) return false;
    const s = getComputedStyle(u);
    return s.borderBottomStyle === 'dotted' && u.textContent === 'switch';
  }, role0.post));
// An unset cell must not say "role: — — editable", which is not a sentence.
check('an unset editable cell names itself in words',
  ((await cellInfo('sw-lab-01', 2)) || {}).label === 'os_version: unset — editable',
  ((await cellInfo('sw-lab-01', 2)) || {}).label);
check('and carries the schema wire key, not a field name',
  /^[0-9]+$/.test(role0.key || ''), role0.key);

// ---- THE KEYBOARD PATH, WALKED --------------------------------------------
// Not simulated with .focus(): Tab is pressed until this cell has focus, so the
// assertion is that a person with no pointer can actually get here. A cell you
// can only reach with a mouse would fail `55` in the other direction.
await page.evaluate(() => document.body.focus());
let tabs = 0, landed = false;
while (tabs < 80 && !landed) {
  await page.keyboard.press('Tab');
  tabs++;
  const f = await focused();
  landed = f.post === role0.post && f.icol === '3';
}
check('Tab alone reaches the role cell of the second row', landed, tabs + ' presses');

// Enter on a focused <button> IS a click, which is why the pointer path and the
// keyboard path are one path here and cannot drift apart.
//
// TWO PRESSES, NOT ONE, since the merge on 2026-08-22. Selecting a row and
// editing a cell both live on the same button, and selecting has to win the
// first press or Direction A's core gesture — pick a row, the panel turns to
// DETAILS — is gone. So the idiom is the one every file manager has used for
// thirty years: the first press selects the row, the second edits the cell you
// are on. The pointer path does exactly the same, which is the point.
await page.keyboard.press('Enter');   // selects the row, turns the panel
await page.waitForTimeout(200);
await page.keyboard.press('Enter');   // now edits the cell
await page.waitForSelector('.invwrap table.inv .iedit');
let f = await focused();
check('Enter opens the editor and focus is inside it',
  f.tag === 'INPUT' && /iedit/.test(f.cls), JSON.stringify(f));
check('the editor opens holding the value that was in the cell',
  f.value === 'switch', f.value);
// `53` §13's failure 1: say the less obvious behaviour rather than trust it to
// be guessed. "Leaving the box does not save" is the least obvious thing here.
check('the editor says which keys do what, beside the caret',
  (await page.textContent('.invwrap table.inv .cellhint'))
    === 'Enter saves. Escape abandons. Leaving the box does not.',
  await page.textContent('.invwrap table.inv .cellhint'));

await page.screenshot({ path: OUT + '/2026-08-21-cell-editor-open.png' });

// ---- A REFUSAL IS VISIBLE AND KEEPS WHAT WAS TYPED -------------------------
// `frewall` is a typo a real person makes. The parse happens in the module, by
// the same grammar that reads a pasted config, and its refusal must arrive at
// the operator intact.
await page.fill('.invwrap table.inv .iedit', 'frewall');
await page.keyboard.press('Enter');
await page.waitForSelector('.invwrap table.inv .cellerr');
const refusal = await page.textContent('.invwrap table.inv .cellerr');
check('a bad value is refused IN THE CELL, not swallowed',
  (refusal || '').length > 0, refusal);
check('and the refusal names what the schema would have accepted',
  /firewall/.test(refusal) && /access_point/.test(refusal) && /server/.test(refusal),
  refusal);
check('the refusal is announced, not merely drawn',
  (await page.getAttribute('.invwrap table.inv .cellerr', 'role')) === 'alert');
f = await focused();
check('the text that caused it is still in the box',
  f.value === 'frewall', JSON.stringify(f));
check('and the caret is still in the box, so it can be corrected in place',
  f.tag === 'INPUT' && /iedit/.test(f.cls), JSON.stringify(f));
check('the editor is marked invalid for a screen reader',
  (await page.getAttribute('.invwrap table.inv .iedit', 'aria-invalid')) === 'true');
check('the footer says so too, where a refusal is read from',
  /refused/.test(await page.textContent('#fMsg')),
  await page.textContent('#fMsg'));
// Whether the graph changed cannot honestly be read off this cell while the
// cell IS the editor — its text is what is being typed. It is read one check
// down, after Escape puts the cell back: if `frewall` had been written, that is
// what the module would render there.

await page.screenshot({ path: OUT + '/2026-08-21-cell-refused.png' });

// ---- ESCAPE ABANDONS, AND FOCUS IS NOT DROPPED ON THE FLOOR ----------------
// `53` §13's failure 7: a focused element removed from the DOM sends focus to
// <body>, which dumps a keyboard user at the top of the document.
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('.invwrap table.inv .iedit') === null);
const afterEsc = await rowCells('sw-lab-01');
check('Escape abandons, and the refusal wrote NOTHING — the cell reads switch',
  afterEsc[3] === 'switch', afterEsc.join(' | '));
f = await focused();
check('and focus is back on the cell, never on <body>',
  f.tag === 'BUTTON' && f.icol === '3' && f.post === role0.post, JSON.stringify(f));

// ---- A GOOD VALUE COMMITS, AND IT IS THE GRAPH THAT CHANGED ----------------
await page.keyboard.press('Enter');
await page.waitForSelector('.invwrap table.inv .iedit');
await page.fill('.invwrap table.inv .iedit', 'router');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('.invwrap table.inv .iedit') === null);
const committed = await rowCells('sw-lab-01');
check('Enter commits and the cell reads the new value',
  committed[3] === 'router', committed.join(' | '));
check('the other cells of the row are untouched',
  committed[0] === 'sw-lab-01' && committed[1] === 'junos-srx', committed.join(' | '));
f = await focused();
check('and focus survives the rebuild the commit caused',
  f.tag === 'BUTTON' && f.icol === '3' && f.post === role0.post, JSON.stringify(f));

// The picture is the second reader of the same graph. If the write had only
// landed in the table, this is where it would show.
await page.click('[data-view="diagram"]');
await page.waitForFunction(() => document.querySelector('.dbox') !== null);
const drawn = await page.$$eval('.dbox', gs => gs.map(g => ({
  name: (g.querySelector('.dname') || {}).textContent || '',
  role: (g.querySelector('.drole') || {}).textContent || '',
})));
const sw = drawn.find(d => d.name === 'sw-lab-01');
check('the diagram draws the corrected role, so the write reached the graph',
  sw && sw.role === 'router', JSON.stringify(sw));
await page.click('[data-view="inventory"]');
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length === 2);

// ---- THE POINTER PATH IS THE SAME PATH -------------------------------------
// And it is the same TWO-PRESS path, which is the whole reason it is worth
// driving separately: a pointer that opened an editor in one click while the
// keyboard needed two would be two grammars for one gesture. First click
// selects the row, second click on the same cell edits it.
const cell2 = '.invwrap table.inv tbody tr:nth-child(1) td button[data-icol="2"]';
await page.click(cell2);
await page.waitForTimeout(200);
await page.click(cell2);
await page.waitForSelector('.invwrap table.inv .iedit');
check('clicking an editable cell opens the same editor',
  (await focused()).tag === 'INPUT');
await page.fill('.invwrap table.inv .iedit', '21.4R3-S5.4');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('.invwrap table.inv .iedit') === null);
const fw = await rowCells('fw-lab-01');
check('and a value typed with the mouse commits the same way',
  fw[2] === '21.4R3-S5.4', fw.join(' | '));

// A cell that is not editable still does what it always did: it selects the
// row. That is the round trip to the diagram, and it must not depend on which
// column somebody happened to click.
await page.click('.invwrap table.inv tbody tr:nth-child(1) td button[data-icol="4"]');
check('a walk cell still selects its row and opens no editor',
  (await page.$$('.invwrap table.inv .iedit')).length === 0 &&
  (await page.$$eval('tr[data-tier="primary"] button[data-post]',
    ns => ns.length)) > 0);

// ---- BLUR IS NOT A COMMIT ---------------------------------------------------
// An estate of record must never gain a claim because somebody moved the focus.
await page.click('.invwrap table.inv tbody tr:nth-child(1) td button[data-icol="0"]');
await page.waitForSelector('.invwrap table.inv .iedit');
await page.fill('.invwrap table.inv .iedit', 'never-typed-this');
await page.click('[data-kind="0"]');            // the kind strip — anywhere else
await page.waitForFunction(() => document.querySelector('.invwrap table.inv .iedit') === null);
const unchanged = await rowCells('fw-lab-01');
check('moving the focus away writes nothing',
  unchanged !== null && unchanged[0] === 'fw-lab-01', JSON.stringify(unchanged));

await page.screenshot({ path: OUT + '/2026-08-21-cell-edit-committed.png' });

// ---- THE EDIT IS JOURNALLED LIKE ANY OTHER OP ------------------------------
// The whole claim of the feature is "the change is journalled like any other
// op". The only honest proof is the file an operator actually keeps: export it,
// reload the page to nothing, import it, and see whether the corrections come
// back.
const dl = page.waitForEvent('download');
await page.click('#tabExport');
await (await dl).saveAs(JOURNAL);

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
check('the reloaded page holds nothing',
  (await page.$$('.inv tbody tr')).length === 0);

await page.setInputFiles('#importFile', JOURNAL);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length === 2);
const backSw = await rowCells('sw-lab-01');
const backFw = await rowCells('fw-lab-01');
check('the role corrected in a cell survives an export and an import',
  backSw[3] === 'router', backSw.join(' | '));
check('and so does the os_version typed into another',
  backFw[2] === '21.4R3-S5.4', backFw.join(' | '));
check('the value the blur did NOT commit is absent from the record',
  backFw[0] === 'fw-lab-01', backFw.join(' | '));
check('and the reimported cells are editable again',
  (await cellInfo('sw-lab-01', 3)).editable === true);

await page.screenshot({ path: OUT + '/2026-08-21-cell-edit-reimported.png' });

// ---- the invariants that hold whatever this feature does -------------------
check('exactly one network request, the file itself, both loads',
  requests.filter(u => u !== 'about:blank').every(u => u === FILE),
  requests.length + ' requests');
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();

const failed = results.filter(r => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks pass');
if (failed.length) {
  console.log('FAILURES:');
  failed.forEach(f => console.log('  ' + f.name + '  ' + (f.detail || '')));
}
process.exit(failed.length ? 1 : 0);
