// DIRECTION A ON THE INVENTORY — driven in Chromium against the shipped artifact.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-21-inventory-direction-a.mjs [repo-root]
//
// The owner found this one himself, in a build he had just rebuilt:
//
//   "which PR/build was the one where when you are looking at equipment and
//    click on it, you have like 3 pages opened, it was too much and you
//    couldn't see anything"
//
// He was describing the INVENTORY, and Direction A had landed on the diagram
// only — `57` §16. This file asserts that the same rearrangement is now on both
// views, that it is the same rearrangement rather than a lookalike, and that
// the three things `55` and `53` require of any panel are true of this one:
// a keyboard path to every gesture, one Escape rung back, and no state that
// only a mouse can see.
//
// The estate is a pasted SRX branch plus four machines typed in by hand, which
// is the shape of the owner's own lab and is the same estate the diagram's
// Direction A driver uses, so the two views are measured over one graph.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';

const CFG = [
  'set system host-name fw-lab-01',
  'set interfaces ge-0/0/0 unit 0 family inet address 192.168.1.1/24',
  'set interfaces ge-0/0/1 unit 0 family inet address 10.0.0.1/24',
  'set security zones security-zone trust interfaces ge-0/0/1.0',
].join('\n');
const LAB = [
  ['sw-core-01', 'switch'], ['ap-loft', 'access_point'],
  ['truenas-01', 'server'], ['proxmox-01', 'server'],
];

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

await page.goto(FILE);
await page.waitForFunction(() => !!document.getElementById('band').children.length);
await page.click('#tabPaste');
await page.fill('#pta', CFG);
await page.click('#pRun');
await page.keyboard.press('Escape');
for (const [name, role] of LAB) {
  await page.click('#tabEquip');
  await page.fill('#ef6', name);
  await page.selectOption('#ef7', 'junos-srx');
  await page.selectOption('#ef9', role);
  await page.click('#eRun');
  await page.keyboard.press('Escape');
}
await page.click('#band [data-view="inventory"]');
await page.waitForSelector('table.inv');

// THE HELPER `57` §16.3 ASKED FOR, and it is three lines. A driver that picks a
// row leaves the panel showing DETAILS; anything that then wants the row set's
// own pane has to say so, in the same way a person would — by pressing ABOUT.
// It is here so no assertion below is ever weakened into "whatever is on
// screen".
const toAbout = () => page.click('[data-ipane="about"]');
const livePane = () => page.$eval('.ipanel .ptabs [aria-selected="true"]',
  n => n.getAttribute('data-ipane'));

// ---- 1. THREE REGIONS ARE NOW TWO -----------------------------------------
check('the meaning column is not on screen on this view',
  await page.$eval('.col.meaning', n => getComputedStyle(n).display) === 'none');
const ledgerCols = await page.$eval('#ledger', n => getComputedStyle(n).gridTemplateColumns);
check('the ledger is one column here, exactly as it is on the diagram',
  ledgerCols.trim().split(/\s+/).length === 1, ledgerCols);
check('one panel sits beside the table, and the split holds exactly those two',
  (await page.$$eval('.ipanel', n => n.length)) === 1 &&
  (await page.$$eval('.isplit > *', n => n.length)) === 2);
check('and no second copy of the editable fields is in the document',
  (await page.$$eval('.fedit', n => n.length)) === 0,
  'inputs while nothing is selected: ' + (await page.$$eval('.fedit', n => n.length)));

const tableW = await page.$eval('table.inv', n => Math.round(n.getBoundingClientRect().width));
const factW = await page.$eval('#factBody', n => Math.round(n.getBoundingClientRect().width));
check('the table took the width the third column gave back', tableW >= 730,
  tableW + ' CSS px at 1400 wide (688 before this change)');
check('the fact column is the whole sheet now, not 62% of it', factW >= 1100,
  factW + ' CSS px (712 before)');

// The kind strip is a CONTROL strip and stays out of the panel — the diagram
// keeps `.dstrip` above the picture for the same reason. What it gains is the
// full width, which is one fewer wrapped row and that row's height back.
const stripH = await page.$eval('#factBody .strip', n => Math.round(n.getBoundingClientRect().height));
const tableTop = await page.$eval('table.inv', n => Math.round(n.getBoundingClientRect().top));
check('the kind strip wraps one row less at full width', stripH <= 80,
  stripH + ' px tall (104 before), table starts at y=' + tableTop + ' (350 before)');

// ---- 2. IT IS THE SAME IDIOM, NOT A LOOKALIKE ------------------------------
// `57` §16's finding is that the two views had stopped agreeing. The test of
// agreement is that they share the RULES, so this reads the computed style of
// both tab strips and requires them to match.
await page.click('table.inv tbody tr:first-child button');
const invTab = await page.$eval('.ipanel .ptabs [aria-selected="true"]', n => {
  const s = getComputedStyle(n);
  return { bg: s.backgroundColor, fg: s.color, tt: s.textTransform, radius: s.borderTopLeftRadius };
});
await page.click('#band [data-view="diagram"]');
await page.waitForSelector('.dcanvas');
const dgTab = await page.$eval('.dpanel .ptabs [aria-selected="true"]', n => {
  const s = getComputedStyle(n);
  return { bg: s.backgroundColor, fg: s.color, tt: s.textTransform, radius: s.borderTopLeftRadius };
});
check('the live tab is styled identically on both views',
  JSON.stringify(invTab) === JSON.stringify(dgTab),
  'inventory ' + JSON.stringify(invTab));
check('and it is inverted — a tab is a box you press, never a heading',
  invTab.bg !== 'rgba(0, 0, 0, 0)' && invTab.radius === '0px');
await page.click('#band [data-view="inventory"]');
await page.waitForSelector('table.inv');

// ---- 3. PICKING A ROW TURNS THE PANEL, EXACTLY AS PICKING A BOX DOES -------
await toAbout();
check('the panel rests on ABOUT with nothing to detail', await livePane() === 'about');
check('and ABOUT says what row set this is and how big it is',
  /\b5 rows in this set\b/.test(await page.$eval('#ipaneAbout', n => n.textContent)),
  await page.$eval('#ipaneAbout p.prose', n => n.textContent.trim()));

await page.click('table.inv tbody tr:nth-child(2) button');
check('picking a row turns the panel to DETAILS', await livePane() === 'details');
check('and the details are that row, named on the tab in the reader\'s own words',
  (await page.$eval('#ipaneDetailsTab', n => n.textContent)).indexOf('sw-core-01') >= 0,
  await page.$eval('#ipaneDetailsTab', n => n.textContent.trim()));
check('the heading names the object and the folio names its kind',
  await page.$eval('#idetHead .dname2', n => n.textContent) === 'sw-core-01' &&
  await page.$eval('#ipaneDetails .colhead .folio', n => n.textContent) === 'Device');
check('the row it came from is marked in the table',
  await page.$eval('table.inv tr[data-tier="primary"] button', n => n.textContent) === 'sw-core-01');

// THE TRAP `57` §16.3 PREDICTED, TESTED RATHER THAN ASSUMED. On the diagram the
// list lives IN the panel, so DETAILS hides it and a driver must come back. On
// this view the list is the TABLE and the table never leaves — so the next row
// is still there, and this is the assertion that says so out loud rather than
// leaving the difference to be rediscovered.
check('the table is still fully on screen while DETAILS is open',
  (await page.$$eval('table.inv tbody tr', rs => rs.filter(r => {
    const b = r.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= window.innerHeight;
  }).length)) === 5);
await page.click('table.inv tbody tr:nth-child(3) button');
check('so a second row can be picked without going back first',
  await page.$eval('#idetHead .dname2', n => n.textContent) === 'ap-loft');

// ---- 4. ONE KEY BACK, AND THE LADDER IS THE DIAGRAM'S ---------------------
await page.keyboard.press('Escape');
check('Escape closes the details and KEEPS the selection', await livePane() === 'about' &&
  await page.$eval('#mRibbon', n => n.textContent).then(t => t.indexOf('ap-loft') >= 0));
await page.keyboard.press('Escape');
check('a second Escape clears the selection — one level per press',
  (await page.$eval('#mRibbon', n => n.textContent.trim())) === '' &&
  (await page.$$eval('table.inv tr[data-tier="primary"]', n => n.length)) === 0);
check('and DETAILS is not a destination with nothing to detail',
  await livePane() === 'about');
await page.click('[data-ipane="details"]');
check('pressing the DETAILS tab with nothing selected does not strand the reader',
  await livePane() === 'about');

// ---- 5. THE KEYBOARD PATH, WHICH IS NOT OPTIONAL (`55`) -------------------
// Every gesture above was a click. Each one is repeated here from the keyboard,
// because "a state only a mouse can see is not a state".
await page.$eval('table.inv tbody [data-rove-item]', n => n.focus());
await page.keyboard.press('ArrowDown');
check('the table is one tab stop and the arrows walk it',
  await page.evaluate(() => document.activeElement.textContent) === 'sw-core-01');
await page.keyboard.press('Enter');
check('Enter on a row selects it and turns the panel', await livePane() === 'details' &&
  await page.$eval('#idetHead .dname2', n => n.textContent) === 'sw-core-01');
check('and focus stayed on the row, because the table did not go anywhere',
  await page.evaluate(() => document.activeElement.getAttribute('data-post') !== null &&
                            document.activeElement.textContent === 'sw-core-01'));

await page.$eval('#ipaneDetailsTab', n => n.focus());
await page.keyboard.press('ArrowLeft');
check('the tab strip is one tab stop and the arrows walk it too',
  await page.evaluate(() => document.activeElement.id) === 'iaboutHead');
await page.keyboard.press('Enter');
check('and Enter on ABOUT switches the pane', await livePane() === 'about');

// Escape from inside the pane must land somewhere: `55` §5.6, never stranded.
await page.$eval('#ipaneDetailsTab', n => n.focus());
await page.keyboard.press('Enter');
await page.$eval('#idetHead', n => n.focus());
await page.keyboard.press('Escape');
check('Escape from inside DETAILS lands on the ABOUT tab, not on <body>',
  await page.evaluate(() => document.activeElement.id) === 'iaboutHead');

// ---- 6. THE THINGS THAT MOVED, AND THE ONE THAT DID NOT -------------------
// `52` §3.7.1 requires the opinions column to be always visible and always
// honest that no rule engine is behind it. Its note explains a COLUMN, so it
// stayed under the column; the row-set notes explain the ROW SET, so they went
// into the pane that says what the row set is.
check('the Opinions note is still under the table, not in the panel',
  await page.evaluate(() => {
    const notes = [...document.querySelectorAll('.note b')].filter(b => b.textContent === 'Opinions');
    return notes.length === 1 && !document.querySelector('.ipanel').contains(notes[0]);
  }));
await page.click('[data-kind="12"]');   // Chassis
await toAbout();
check('the chassis note moved into ABOUT, where a reader who picked Chassis is',
  await page.evaluate(() => {
    const n = [...document.querySelectorAll('.ipanel .note b')]
      .find(b => b.textContent.indexOf('chassis is a part of a device') >= 0);
    return !!n;
  }));
await page.click('[data-kind="0"]');    // back to Device

// ---- 7. THE EDITING PATH SURVIVED THE MOVE --------------------------------
// The fields moved into a pane. If the move broke the commit, the product lost
// the only way it has to correct a fact — so it is driven, not assumed.
await page.click('table.inv tbody tr:nth-child(4) button');
check('the face control is inside DETAILS and both faces are offered',
  (await page.$$eval('#ipaneDetails .faces [data-face]', n => n.length)) === 2);
await page.click('#ipaneDetails [data-face="equipment"]');
check('the equipment face renders in the panel',
  (await page.$eval('#ipaneDetails', n => n.textContent)).indexOf('truenas-01') >= 0);
await page.click('#ipaneDetails [data-face="meaning"]');
// The unset fields are behind a `<details>` that states its own count. Opening
// it from the keyboard is the point — it is in the tab order and toggles on
// Enter — so it is opened that way here.
await page.$eval('#ipaneDetails details.unsetfields summary', n => n.focus());
await page.keyboard.press('Enter');
const keyInput = await page.$('#ipaneDetails .fedit[aria-label="os_version"]');
check('an unset field is reachable and editable from the panel', !!keyInput);
if (keyInput) {
  await keyInput.fill('24.2R1');
  await keyInput.press('Enter');
  await page.waitForTimeout(150);
  check('and Enter commits it — the cell in the table says so',
    (await page.$eval('table.inv tr[data-tier="primary"]', n => n.textContent)).indexOf('24.2R1') >= 0,
    await page.$eval('table.inv tr[data-tier="primary"]', n => n.textContent.trim()));
  check('the panel is still on DETAILS after a commit, not thrown back to ABOUT',
    await livePane() === 'details');
}

// ---- 7b. A KIND SWITCH DOES NOT CHANGE THE SELECTION ----------------------
// "A view switch never changes the selection — it changes how it is drawn",
// and the same is true of a row set. The panel must not quietly drop the
// element the masthead still says is selected.
await page.click('[data-kind="3"]');    // Interface
check('switching row set keeps the selection and the pane that shows it',
  await livePane() === 'details' &&
  await page.$eval('#idetHead .dname2', n => n.textContent) === 'truenas-01' &&
  await page.$eval('.ipanel [data-ipane="about"] .pcnt', n => n.textContent) === 'Interface');
await page.click('[data-kind="0"]');

// ---- 7c. REMOVING FROM THE PANEL ------------------------------------------
const before = await page.$$eval('table.inv tbody tr', r => r.length);
await page.click('#ipaneDetails [data-remove]');
await page.waitForTimeout(150);
check('remove still works from inside the panel, and the row goes',
  (await page.$$eval('table.inv tbody tr', r => r.length)) === before - 1);
check('and the panel falls back to ABOUT, because there is nothing to detail',
  await livePane() === 'about' &&
  (await page.$eval('#ipaneDetailsTab', n => n.textContent)).indexOf('none') >= 0);

// ---- 8. NARROW: THE PANEL GOES UNDER THE TABLE ---------------------------
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(120);
const stacked = await page.evaluate(() => {
  const t = document.querySelector('.icol').getBoundingClientRect();
  const p = document.querySelector('.ipanel').getBoundingClientRect();
  return { under: p.top >= t.top, sameWidth: Math.abs(p.width - t.width) < 2 };
});
check('at 390 px the panel is under the table, full width, not beside it',
  stacked.under && stacked.sameWidth, JSON.stringify(stacked));
check('and nothing on this view scrolls the document sideways',
  await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(120);

// ---- 9. THE INVARIANTS -----------------------------------------------------
// The reason `renderMeaning` returns early on this view now: two live inputs
// carrying the same wire key, one of them in a `display:none` column, is a form
// that can write a field from a surface nobody can see. Asked with a row picked,
// because with nothing picked there are no inputs and the question is vacuous.
await page.click('table.inv tbody tr:first-child button');
check('no duplicate editable field in the document — one `data-key` each',
  await page.evaluate(() => {
    const keys = [...document.querySelectorAll('.fedit[data-key]')]
      .map(n => n.getAttribute('data-key'));
    return keys.length > 0 && keys.length === new Set(keys).size;
  }));
check('one network request, the file itself (invariant 1)',
  requests.filter(u => !u.startsWith('file://')).length === 0,
  requests.length + ' request(s), all file://');
check('no page errors through the whole drive', errors.length === 0, errors.join(' | '));

// Let the pane finish travelling before the shot: a screenshot taken inside
// `--m-pane` is a picture of the transition, not of the layout it is evidence
// for, and this file is cited for the layout.
await page.waitForTimeout(500);
await page.screenshot({ path: ROOT + '/docs/80-review/evidence/2026-08-21-inventory-direction-a.png' });
await browser.close();

const bad = results.filter(r => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
process.exit(bad.length ? 1 : 0);
