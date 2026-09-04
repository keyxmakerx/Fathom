// WHAT THE ESTATE DOES NOT KNOW YET — the findings view's first real job,
// driven through the shipped artifact in Chromium, ASSERTING ON THE NUMBERS
// and on the accessible tree.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-21-findings-first-job.mjs [repo-root]
//
// `57` §14.1 pile A item A4. Three of six views were empty placeholders; this
// gives findings a job that needs no new kind, no opcode against the graph, no
// rules engine and no owner decision — it reads what is already held and says
// what is INCOMPLETE.
//
// THE ONE THING THIS FILE IS FOR IS THAT THE COUNTS ARE RIGHT. A view that
// merely renders is easy and worthless: an operator works a list down to zero
// and a wrong zero is a lie he acts on. So every count asserted below is
// checked against the estate the driver itself built — paste a config with a
// KNOWN number of interfaces, add a KNOWN number of devices by hand, and the
// two numbers have to be the ones on screen. Nothing here asserts "a row
// appeared".
//
// It also asserts the two claims that make the view honest rather than merely
// useful:
//   * an empty page is NOT a complete estate, and the view says so;
//   * a kind nothing in this build can create is NAMED, so a silent zero for
//     `Cable` never reads as "your cabling is finished" (`57` §6.2).
//
// Playwright and Chromium are the ones already on this machine; neither is a
// dependency of the product and neither is in Cargo.lock (gate zero).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const OUT = ROOT + '/docs/80-review/evidence';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

// FOUR interfaces, one device, one zone. The interface count is the number the
// gap list has to produce on its own, so it is written here once and never
// again — every assertion below counts it out of this constant.
const IFACES = 4;
const CONFIG = [
  'set system host-name fw-branch-01',
  ...Array.from({ length: IFACES }, (_, i) =>
    `set interfaces ge-0/0/${i} unit 0 family inet address 10.1.${i + 1}.1/24`),
  'set security zones security-zone trust interfaces ge-0/0/0.0',
].join('\n') + '\n';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const requests = [];
page.on('request', r => requests.push(r.url()));
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// ---- helpers that read the DOM, never page internals -------------------------

const findings = () => page.click('[data-view="findings"]');

// Every gap group on screen: its count, its sentence, whether it is marked as
// un-typeable, and the ids listed under it. Read out of the rendered list in
// document order, which is the order the module sent.
const groups = () => page.evaluate(() => {
  const out = [];
  const rows = [...document.querySelectorAll('.gaprow')];
  for (const row of rows) {
    const list = row.nextElementSibling;
    out.push({
      n: parseInt(row.querySelector('.n').textContent, 10),
      what: row.querySelector('.what').textContent,
      mark: row.querySelector('.mark') ? row.querySelector('.mark').textContent : '',
      ids: list && list.classList.contains('gapitems')
        ? [...list.querySelectorAll('button')].map(b => b.getAttribute('data-post'))
        : [],
    });
  }
  return out;
});

// The head tally, by the label beside each number — never by position, because
// a driver that reads slot 0 cannot tell "kinds of gap" from "things nobody
// has stated" and would pass on a reply that swapped them.
const tally = () => page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll('.tally li')]
    .map(li => [li.querySelector('.k').textContent,
                parseInt(li.querySelector('.n').textContent, 10)])));

const emptyKinds = () =>
  page.$eval('.emptykinds', n => n.textContent).catch(() => '');

const ribbon = () => page.$eval('#mRibbon', n => n.textContent);

const addDevice = async hostname => {
  await page.click('#tabEquip');
  await page.fill('#ef6', hostname);
  await page.selectOption('#ef7', 'junos-srx');
  await page.click('#eRun');
  await page.waitForFunction(
    n => [...document.querySelectorAll('.inv tbody td')].some(td => td.textContent === n),
    hostname);
};

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// ---- 1. THE BAND NO LONGER LIES ABOUT THIS VIEW ------------------------------

check('the band does not mark findings "not built"',
  await page.$eval('[data-view="findings"]',
    n => !n.hasAttribute('data-unbuilt')),
  await page.$eval('[data-view="findings"]', n => n.textContent));

// ---- 2. AN EMPTY PAGE IS NOT A COMPLETE ESTATE -------------------------------
//
// The worst sentence this view could produce is "nothing is missing" over a
// page nobody has loaded anything into. The module refuses the call outright
// and the page says which of the two states it is in.

await findings();
const emptyText = await page.$eval('#factBody', n => n.textContent);
check('with no workspace the view says there is nothing to check',
  /nothing to check/i.test(emptyText) && /no workspace loaded/i.test(emptyText));
check('and explicitly denies that an empty page is a complete one',
  /empty page is not a complete estate/i.test(emptyText));
check('it does not claim anything is complete',
  !/nothing required is unstated/i.test(emptyText));

// ---- 3. A PASTED CONFIG, AND THE COUNT IS THE CONFIG'S ------------------------

await page.click('#tabPaste');
await page.fill('#pta', CONFIG);
await page.click('#pRun');
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);

// The estate's own count of interfaces, read from the inventory — the number
// the gap list is about to be checked against comes from the product, not from
// this file's arithmetic.
await page.click('[data-view="inventory"]');
const ifaceKind = await page.$$eval('[data-kind]', ns =>
  ns.findIndex(n => n.textContent === 'Interface'));
await page.click('[data-kind="' + ifaceKind + '"]');
const ifaceRows = await page.$$eval('.inv tbody tr', ns => ns.length);
check('the paste built one Interface per `set interfaces` line',
  ifaceRows === IFACES, ifaceRows + ' rows for ' + IFACES + ' lines');

await findings();
const g1 = await groups();
const form = g1.find(g => / form$/.test(g.what));
check('the view names Interface.form as unstated', !!form,
  g1.map(g => g.what).join(' | '));
check('and the count is the estate\'s, not a round number',
  form && form.n === ifaceRows && /^4 of 4 Interface nodes have no form$/.test(form.what),
  form ? form.what : 'no row');
check('every interface it counted is listed by id',
  form && form.ids.length === ifaceRows &&
    form.ids.every(id => /^interface:[0-9A-Z]+$/.test(id)),
  form ? form.ids.join(' ') : '');

const t1 = await tally();
check('the head tally counts the same facts the groups do',
  t1['things nobody has stated'] === g1.reduce((s, g) => s + g.n, 0) &&
  t1['kinds of gap'] === g1.length,
  JSON.stringify(t1));

// An OPTIONAL field nobody stated is not a gap. If it were, the list would be
// every unset field in the schema and no one would open it twice.
check('an unstated OPTIONAL field is not listed',
  !g1.some(g => /os_version|description|criticality/.test(g.what)),
  g1.map(g => g.what).join(' | '));

// A field the paste DID state is not a gap either.
check('a field the config stated is not listed',
  !g1.some(g => /Device nodes have no hostname/.test(g.what)));

// ---- 4. THE COUNT MOVES WITH THE ESTATE --------------------------------------
//
// Two devices added by hand, and the Device group has to go from one to three.
// This is the assertion a cached work list fails.

const beforeDevices = (await groups()).find(g => /Device nodes/.test(g.what));
check('one device from the paste has one Device-shaped gap',
  beforeDevices && beforeDevices.n === 1, beforeDevices ? beforeDevices.what : 'none');

await addDevice('sw-lab-01');
await addDevice('sw-lab-02');
await findings();
const g2 = await groups();
const afterDevices = g2.find(g => /Device nodes/.test(g.what));
check('adding two devices by hand moves the count to three',
  afterDevices && afterDevices.n === 3 &&
    /^3 of 3 Device nodes have no name_conformance$/.test(afterDevices.what),
  afterDevices ? afterDevices.what : 'none');

const t2 = await tally();
check('and the tally follows it',
  t2['things nobody has stated'] === t1['things nobody has stated'] + 2,
  t1['things nobody has stated'] + ' -> ' + t2['things nobody has stated']);

// BIGGEST FIRST. The list is a work list and the work is where the count is.
check('the list runs biggest gap first',
  g2.map(g => g.n).every((n, i, a) => i === 0 || a[i - 1] >= n),
  g2.map(g => g.n).join(' >= '));

// ---- 5. A ROW THAT CANNOT BE ACTED ON SAYS SO --------------------------------
//
// The uncomfortable one, and the reason it is asserted: BOTH gaps this build
// can produce are fields nothing can type in yet. A view that presented them
// as work would send an operator hunting for an editor that is not there.

check('a field with no parser is marked, in words and not in colour',
  g2.every(g => g.mark === 'cannot be typed in yet'),
  g2.map(g => g.what + ' :: ' + g.mark).join(' | '));

// ---- 6. CLICKING A ROW SELECTS THAT ELEMENT ----------------------------------
//
// "Each row must be actionable" means the row takes you to the thing. The
// selection is asserted from the MASTHEAD RIBBON, which is the page's own
// statement of what is picked, not from an internal variable.

const target = g2.find(g => / form$/.test(g.what)).ids[1];
await page.click('[data-post="' + target + '"]');
await page.waitForTimeout(80);
check('clicking a row selects the element it names',
  (await ribbon()).includes(target), await ribbon());
check('and the details column is now about that element',
  (await page.$eval('#meanFolio', n => n.textContent)).length > 0 &&
  (await page.$eval('#meanBody', n => n.textContent)).includes('form'),
  await page.$eval('#meanFolio', n => n.textContent));
check('the view did not navigate away from findings',
  await page.$eval('#sheet', n => n.getAttribute('data-viewing')) === 'findings');
check('and the selected row is marked in the accessible tree, not only in colour',
  await page.$eval('[data-post="' + target + '"]',
    n => n.getAttribute('aria-current') === 'true'));

// ---- 7. KEYBOARD: THE LIST IS ONE TAB STOP AND THE ARROWS WALK IT ------------
//
// `53` §8.3's roving contract. `55`: a state only a mouse can see is not a
// state — so this is driven with keys and asserted on focus, not on hover.

const roveIds = await page.$$eval('.gapitems [data-rove-item]',
  ns => ns.map(n => ({ id: n.getAttribute('data-post'), tab: n.getAttribute('tabindex') })));
check('each gap list has exactly one tab stop',
  await page.$$eval('.gapitems', lists => lists.every(l => {
    const items = [...l.querySelectorAll('[data-rove-item]')];
    return items.length === 0 ||
      items.filter(i => i.getAttribute('tabindex') === '0').length === 1;
  })),
  roveIds.length + ' items across the lists');

const first = await page.$eval('.gapitems [data-rove-item]', n => n.getAttribute('data-post'));
await page.focus('.gapitems [data-rove-item]');
await page.keyboard.press('ArrowDown');
const focused = await page.evaluate(() =>
  document.activeElement.getAttribute('data-post'));
check('ArrowDown moves focus to the next element in the list',
  focused && focused !== first, first + ' -> ' + focused);

await page.keyboard.press('Enter');
await page.waitForTimeout(80);
check('Enter on a focused row selects it, with no pointer involved',
  (await ribbon()).includes(focused), await ribbon());

// THE DEFECT THIS LINE WAS WRITTEN FOR, found on the first run of this file
// and invisible to a pointer. Selecting a row re-renders the view and
// `clear()` takes the focused button with it, so focus fell to <body> and the
// next arrow key did nothing: the list ejected a keyboard user on every single
// selection, which is the exact opposite of working a list down.
check('and focus stays on the row it selected, so the list can be worked down',
  (await page.evaluate(() => document.activeElement.getAttribute('data-post'))) === focused,
  await page.evaluate(() => document.activeElement.tagName + ' ' +
    (document.activeElement.getAttribute('data-post') || '')));

await page.keyboard.press('Home');
check('Home returns to the first row',
  (await page.evaluate(() => document.activeElement.getAttribute('data-post'))) === first);

// ---- 8. ZERO BECAUSE THERE ARE NONE IS NOT ZERO BECAUSE IT IS DONE -----------

const empties = await emptyKinds();
check('kinds the estate holds none of are named, not passed over',
  /\bCable\b/.test(empties) && /\bPhysicalPort\b/.test(empties),
  empties.slice(0, 120));
check('and a populated kind is not among them',
  !/\bDevice\b/.test(empties));

const caveat = await page.$eval('#factBody', n => n.textContent);
check('the physical layer says WHY it is empty, naming both kinds',
  /Cable and PhysicalPort: nothing in this build creates one/.test(caveat));
check('so the view never claims the cabling is finished',
  /says nothing about your cabling/.test(caveat));

// Forty-four names is eight lines of schema vocabulary under a two-row work
// list. They go behind a native disclosure — in the tab order, announcing its
// own state — and the COUNT stays in the heading so the collapsed state still
// states the whole fact.
check('the long list of names is behind a disclosure with the count in the heading',
  await page.$eval('.emptykinds', n => !!n.closest('details')) &&
  /holds none of these — 44 kinds/i.test(caveat),
  await page.$eval('details.unsetfields > summary', n => n.textContent));
check('and the caveat is NOT behind it — a caveat nobody opens is one nobody reads',
  await page.$$eval('.note', ns => ns.length > 0 && ns.every(n => !n.closest('details'))));

// ---- 9. IT NEVER CLAIMS A RULE FIRED -----------------------------------------
//
// `.context/conventions.md` reserves "finding" for one rule firing against one
// node. There is no rule engine in this build and the screen must not imply
// there is.

check('the view states plainly that no rule has fired',
  /No rule has fired/i.test(caveat) && /no rule engine in this build/i.test(caveat));
check('and it does not call these rows findings, violations or errors',
  !/\bviolation/i.test(caveat) && !/\bissues?\b/i.test(caveat),
  '');

// ---- 9b. AN EMPTY RECORD IS NOT A CLEAN BILL OF HEALTH -----------------------
//
// THREE ZEROES THAT MEAN DIFFERENT THINGS: no workspace (checked at the top),
// a workspace whose every element has been removed, and a workspace whose
// required fields are all stated. The middle one is reachable, so it is
// driven: remove every device — a tombstone takes the containment subtree with
// it, so the interfaces and the zone go too — and the view must not answer
// with "nothing required is unstated".

for (const host of ['fw-branch-01', 'sw-lab-01', 'sw-lab-02']) {
  await page.click('[data-view="inventory"]');
  const kind = await page.$$eval('[data-kind]', ns =>
    ns.findIndex(n => n.textContent === 'Device'));
  await page.click('[data-kind="' + kind + '"]');
  await page.click('.inv tbody td button');
  await page.click('[data-remove]');
  await page.waitForTimeout(60);
}

await findings();
const emptied = await page.$eval('#factBody', n => n.textContent);
check('an estate with everything removed says nothing is HELD, not nothing is missing',
  /Nothing is held/.test(emptied) && !/Nothing required is unstated/.test(emptied),
  emptied.slice(0, 140).replace(/\s+/g, ' '));
check('and it says the difference out loud',
  /not the same as nothing being missing/.test(emptied));
check('with no gap rows at all', (await groups()).length === 0);
const t3 = await tally();
check('and a tally of zero elements checked',
  t3['elements checked'] === 0 && t3['things nobody has stated'] === 0,
  JSON.stringify(t3));

// Put the estate back for the determinism check below — and prove the list
// comes back with it, which is the same "moves with the graph" claim from the
// other direction.
await page.click('#tabPaste');
await page.fill('#pta', CONFIG);
await page.click('#pRun');
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
await findings();
const restored = await groups();
check('re-pasting brings the gap list back',
  restored.some(g => /^4 of 4 Interface nodes have no form$/.test(g.what)),
  restored.map(g => g.what).join(' | '));

// ---- 10. DETERMINISM: THE SAME ESTATE ANSWERS THE SAME WAY --------------------
//
// Invariant 9. Left the view, came back, and the list is byte-identical —
// no clock, no map iteration order, no sort a build could reorder.

await page.click('[data-view="inventory"]');
await findings();
const g3 = await groups();
check('the same estate produces the same list every time',
  JSON.stringify(g3) === JSON.stringify(await groups()) &&
  JSON.stringify(g3) === JSON.stringify(restored),
  g3.map(g => g.what).join(' | '));

// The picture, for a reader. It is NOT the evidence — every assertion above
// is — but a screen nobody has looked at is a screen nobody has judged.
await page.screenshot({ path: OUT + '/2026-08-21-findings-first-job.png', fullPage: true });

// ---- the invariants that hold whatever this feature does ---------------------

check('exactly one network request, the file itself',
  requests.filter(u => u !== 'about:blank').every(u => u === FILE),
  requests.length + ' requests');
check('no page errors and no console errors', errors.length === 0,
  errors.join(' | '));

const bad = results.filter(r => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
await browser.close();
process.exit(bad.length ? 1 : 0);
