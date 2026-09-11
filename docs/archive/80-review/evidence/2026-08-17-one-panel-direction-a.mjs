// DIRECTION A — ONE PANEL, driven in Chromium against the shipped artifact.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-17-one-panel-direction-a.mjs [repo-root]
//
// The owner said three things and this file asserts all three:
//
//   "having that side bar, and then the diagram having another side bar is a
//    bit confusing. We may need it to be either or"
//   "is there anyway we can make it clear about the headers of stuff, and
//    selections, they are very confusing currently"
//   "they had animations still and like submenus that all make sense"
//
// The estate is a pasted SRX branch plus four machines typed in by hand, which
// is the shape of the owner's own lab: one firewall he pasted, four boxes he
// added. Nothing here is a fixture the product ships.
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
await page.click('#band [data-view="diagram"]');
await page.waitForSelector('.dcanvas');

// ---- 1. EITHER OR: there is one panel beside the picture, not two ----------
check('the meaning column is not on screen on this view',
  await page.$eval('.col.meaning', n => getComputedStyle(n).display) === 'none');
check('exactly one panel sits beside the picture',
  (await page.$$eval('.dpanel', n => n.length)) === 1 &&
  (await page.$$eval('.dsplit > *', n => n.length)) === 2);
check('and it renders no second copy of the editable fields',
  (await page.$$eval('.fedit', n => n.length)) === 0,
  'inputs while nothing is selected: ' + (await page.$$eval('.fedit', n => n.length)));

const canvasW = await page.$eval('.dcanvas', n => Math.round(n.getBoundingClientRect().width));
check('the picture took the width the third column gave back', canvasW >= 900,
  canvasW + ' CSS px at 1400 wide (762 before this change)');

// ---- 2. HEADERS: one idiom, and a tab is not a heading ---------------------
const idiom = await page.evaluate(() => {
  const head = document.querySelector('.col.fact .colhead');
  const tabObj = document.getElementById('doutHead');
  const cs = n => getComputedStyle(n);
  return {
    headText: head.querySelector('h2').textContent,
    headTick: cs(head).borderLeftWidth,
    headBg: cs(head).backgroundColor,
    tabRole: tabObj.getAttribute('role'),
    tabBg: cs(tabObj).backgroundColor,
    tabColor: cs(tabObj).color,
    inkBg: cs(document.body).color,      // --ink is the body's colour
    pageBg: cs(document.body).backgroundColor,
    // the third idiom is gone: no `.sh` heading inside the objects pane
    outlineSh: document.querySelectorAll('#dpaneObjects > .sh').length,
  };
});
check('the left column heading names what is under it, in plain words',
  idiom.headText === 'Network map', JSON.stringify(idiom.headText));
check('a HEADING carries the 4 px ink tick', idiom.headTick === '4px', idiom.headTick);
check('a TAB is a tab, and the live one is INVERTED — ink ground, page text',
  idiom.tabRole === 'tab' && idiom.tabBg === idiom.inkBg && idiom.tabColor === idiom.pageBg,
  idiom.tabBg + ' on ' + idiom.tabColor);
check('the third idiom is gone: no "Outline — every drawn object" sub-heading',
  idiom.outlineSh === 0);
check('the faces are no longer a peer of a heading',
  (await page.$$eval('.colhead .faces', n => n.length)) === 0);

// ---- 3. THE EMPTY STATE, SAID ---------------------------------------------
check('with nothing selected the OBJECTS tab is live',
  (await page.getAttribute('#doutHead', 'aria-selected')) === 'true' &&
  (await page.getAttribute('#dpaneDetailsTab', 'aria-selected')) === 'false');
check('and the DETAILS tab says so rather than going quiet',
  (await page.textContent('#dpaneDetailsTab')).trim() === 'Details none',
  await page.textContent('#dpaneDetailsTab'));
await page.click('#dpaneDetailsTab');
check('pressing it anyway does not open an empty pane',
  (await page.getAttribute('#doutHead', 'aria-selected')) === 'true');

// ---- 4. SELECTION: one thing, said in four places -------------------------
const swId = await page.evaluate(() => {
  const r = [...document.querySelectorAll('[data-drow]')].find(x => x.textContent.includes('sw-core-01'));
  return r && r.getAttribute('data-drow');
});
await page.click('[data-dpost="' + swId + '"] rect');
await page.waitForTimeout(300);

check('clicking a box turns the panel to DETAILS — "I clicked a thing, now tell me about it"',
  (await page.getAttribute('#dpaneDetailsTab', 'aria-selected')) === 'true' &&
  (await page.$eval('#dpaneObjects', n => n.hidden)) === true);
check('the DETAILS tab carries the selected object\'s name, in both panes',
  (await page.textContent('#dpaneDetailsTab')).includes('sw-core-01'));
check('the details heading says whose details these are',
  (await page.textContent('#ddetHead')).trim() === 'sw-core-01');
check('the masthead says it in words a person owns, and still carries the id',
  (await page.textContent('#mRibbon')).includes('sw-core-01') &&
  (await page.textContent('#mRibbon')).includes(swId));
const mark = await page.evaluate(id => {
  const g = document.querySelector('[data-dpost="' + CSS.escape(id) + '"]');
  const bar = g.querySelector('line.dselbar');
  const ring = document.querySelector('.dring');
  const cs = getComputedStyle(bar);
  return { cls: g.getAttribute('class'), barStroke: cs.stroke, barWidth: cs.strokeWidth,
           ink: getComputedStyle(document.body).color,
           ring: ring.getAttribute('visibility') };
}, swId);
check('the box is marked in the picture: the same 4 px ink bar the row and the headings use',
  mark.cls.includes('dsel') && mark.barStroke === mark.ink && mark.barWidth === '4px' &&
  mark.ring === 'visible',
  mark.barStroke + ' at ' + mark.barWidth + ' / ring ' + mark.ring);
await page.click('#doutHead');
const rowMark = await page.evaluate(id => {
  const r = document.querySelector('[data-drow="' + CSS.escape(id) + '"]');
  const cs = getComputedStyle(r.querySelector('.doname'));
  return { sel: r.getAttribute('aria-selected'), bg: cs.backgroundColor, fg: cs.color,
           tick: getComputedStyle(r, '::before').transform,
           ink: getComputedStyle(document.body).color,
           page: getComputedStyle(document.body).backgroundColor };
}, swId);
check('and the row is marked in the list: the name INVERTED, and the tick scaled in',
  rowMark.sel === 'true' && rowMark.bg === rowMark.ink && rowMark.fg === rowMark.page &&
  rowMark.tick !== 'matrix(1, 0, 0, 0, 0, 0)',
  'name ' + rowMark.bg + ' on ' + rowMark.fg + ' · tick ' + rowMark.tick);

// ---- 5. ONE KEY AND ONE CLICK BACK ----------------------------------------
await page.click('[data-dpost="' + swId + '"] rect');
await page.waitForTimeout(250);
await page.click('.dback');
check('one click back: the "back to objects" control returns to the list',
  (await page.getAttribute('#doutHead', 'aria-selected')) === 'true' &&
  (await page.$eval('#dpaneDetails', n => n.hidden)) === true);
check('and the selection SURVIVES going back — the tab still names it',
  (await page.textContent('#dpaneDetailsTab')).includes('sw-core-01'));

await page.click('#dpaneDetailsTab');
await page.waitForTimeout(250);
await page.keyboard.press('Escape');
check('one key back: Escape unwinds exactly one level, to the list',
  (await page.getAttribute('#doutHead', 'aria-selected')) === 'true' &&
  (await page.textContent('#dpaneDetailsTab')).includes('sw-core-01'));
const afterEsc = await page.evaluate(() => document.activeElement.id);
check('and never strands focus on <body> (55 §5.6)', afterEsc === 'doutHead', afterEsc);
await page.keyboard.press('Escape');
check('a second Escape clears the selection, which is the rung below',
  (await page.$$eval('.dsel', n => n.length)) === 0 &&
  (await page.textContent('#dpaneDetailsTab')).trim() === 'Details none');

// ---- 6. THE KEYBOARD KEEPS ITS PLACE IN THE LIST --------------------------
await page.click('#doutHead');
await page.keyboard.press('Tab');
const inTree = await page.evaluate(() => !!document.activeElement.getAttribute('data-drow'));
check('Tab from the tab strip lands in the object list', inTree);
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
const held = await page.evaluate(() => ({
  onRow: !!document.activeElement.getAttribute('data-drow'),
  pane: document.getElementById('doutHead').getAttribute('aria-selected'),
  named: document.getElementById('dpaneDetailsTab').textContent,
}));
check('Enter on a row selects WITHOUT hiding the row focus is standing on',
  held.onRow === true && held.pane === 'true', JSON.stringify(held));
check('and the DETAILS tab relabels itself, so the keyboard is told what it picked',
  held.named.trim() !== 'Details none', held.named);

// ---- 7. MOTION, AND ITS GUARD ---------------------------------------------
// The whole of the meaning is the SIGN of the translate: list -> details comes
// from the right, back comes from the left. Both are asserted, because an
// animation that plays the same way in both directions says nothing.
await page.click('[data-dpost="' + swId + '"] rect');
const fwd = await page.evaluate(() => {
  const d = document.getElementById('dpaneDetails');
  return { dir: d.getAttribute('data-dir'), name: getComputedStyle(d).animationName,
           dur: getComputedStyle(d).animationDuration };
});
check('the details pane arrives from the RIGHT — the direction you moved',
  fwd.name === 'pane-fwd' && fwd.dur === '0.15s', JSON.stringify(fwd));
await page.waitForTimeout(250);
await page.click('.dback');
const backAnim = await page.evaluate(() =>
  getComputedStyle(document.getElementById('dpaneObjects')).animationName);
check('and the list comes back from the LEFT', backAnim === 'pane-back', backAnim);
await page.click('[data-dpost="' + swId + '"] rect');
const motion = await page.evaluate(() => {
  const r = document.querySelector('.dring');
  const row = document.querySelector('.dorow');
  const tabs = document.querySelector('.ptabs');
  return { ringCls: r.getAttribute('class'),
           ringTrans: getComputedStyle(r).transitionProperty,
           rowTrans: getComputedStyle(row, '::before').transitionDuration,
           tabsAnim: getComputedStyle(tabs).animationName,
           tabsTrans: getComputedStyle(tabs).transitionDuration };
});
check('a pointer selection makes the ring TRAVEL to where it went',
  motion.ringCls === 'dring dtravel' && motion.ringTrans.includes('x') &&
  motion.rowTrans !== '0s', JSON.stringify(motion));
// The same element is the focus indicator for the Outline walk, and a focus
// indicator that arrives 150 ms late is motion doing harm.
await page.click('#doutHead');
await page.keyboard.press('Tab');
await page.keyboard.press('ArrowDown');
const kbRing = await page.evaluate(() => {
  const r = document.querySelector('.dring');
  return { cls: r.getAttribute('class'), dur: getComputedStyle(r).transitionDuration };
});
check('a KEYBOARD walk does not: the focus ring is instant, every step',
  kbRing.cls === 'dring' && kbRing.dur === '0s', JSON.stringify(kbRing));
check('NOTHING A PERSON IS ABOUT TO PRESS EVER MOVES: the tab strip is static',
  motion.tabsAnim === 'none' && motion.tabsTrans === '0s', JSON.stringify(motion));

const reduced = await browser.newContext({
  viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
const rp = await reduced.newPage();
await rp.goto(FILE);
await rp.waitForFunction(() => !!document.getElementById('band').children.length);
await rp.click('#band [data-view="diagram"]');
const guard = await rp.evaluate(() => {
  const row = document.querySelector('.dorow');
  const r = document.querySelector('.dring');
  return { row: row ? getComputedStyle(row, '::before').transitionDuration : '0s',
           ring: r ? getComputedStyle(r).transitionDuration : '0s' };
});
check('and every one of them is zero under prefers-reduced-motion',
  guard.row === '0s' && guard.ring.split(',').every(s => s.trim() === '0s'),
  JSON.stringify(guard));
await reduced.close();

// ---- 8. 390 AND 320 -------------------------------------------------------
for (const w of [390, 320]) {
  await page.setViewportSize({ width: w, height: w === 390 ? 844 : 800 });
  await page.waitForTimeout(250);
  const m = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    tabs: [...document.querySelectorAll('.ptabs button')].map(b => Math.round(b.getBoundingClientRect().height)),
    rows: document.querySelectorAll('[data-drow]').length,
    panelW: Math.round(document.querySelector('.dpanel').getBoundingClientRect().width),
  }));
  check(w + ' px: the page never scrolls sideways', m.overflow === false);
  check(w + ' px: both tabs are on screen at a real touch height',
    m.tabs.length === 2 && m.tabs.every(h => h >= 24), JSON.stringify(m.tabs));
  check(w + ' px: every drawn box still has a row', m.rows > 0, m.rows + ' rows');
}

check('one network request, the file itself (invariant 1)', requests.length === 1,
  requests.length + ': ' + requests.join(' '));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const bad = results.filter(r => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
process.exit(bad.length ? 1 : 0);
