// Rung 4 — inside the box, driven in a real browser (`57` §7, §14.1 item A2).
//
// `57` §7 is titled "THE GAP: nobody designed the inside of a box". Rung 3 is a
// FACEPLATE — `Chassis → PhysicalPort`, the outside — and the path THROUGH the
// box appeared in all five trace designs only as a list in a side panel.
//
// WHAT THIS FILE IS FOR, beyond the usual. `57` §14.4 ends with "nothing in
// this file has been driven in a browser, which is the standard this project
// holds every other claim to". This is that. And the reason it matters more
// here than on most surfaces is the one `CLAUDE.md` records three times in a
// week: the module has been correct at both ends and THE PAGE was what guessed.
// `crates/fathom-wasm/tests/inside.rs` holds the projection; nothing but a
// browser holds the sentence on the screen.
//
// THE ASSERTION THIS FILE EXISTS FOR is section 5. `57` §6.3: Fathom does not
// evaluate policy, it never says permitted or denied, and the one way to get
// this view wrong is to overclaim. Section 5 reads the rendered text and holds
// it to that — including the half the schema CANNOT record, which the view has
// to say out loud rather than leave a reader to infer from two bands sitting
// side by side.
//
//   node 2026-08-22-inside-the-box.mjs [repo-root]
//
// Requires the artifact at target/artifact/fathom-dev.html.

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const OUT = ROOT + '/docs/80-review/evidence';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

// The estate, written once. Every count below is derived from THIS and never
// from a number typed into an assertion — a driver that hard-codes `4` cannot
// tell a correct count from a coincidence.
//
// Everything in it is a statement `corpus/dict/junos-srx` declares. ge-0/0/2
// carries a description and no unit on purpose: an interface that carries no
// traffic yet is a fact about the estate and must survive to the picture.
const HOST = 'srx-branch-01';
const CONFIG = [
  'set system host-name ' + HOST,
  'set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30',
  'set interfaces ge-0/0/1 unit 0 family inet address 10.0.0.1/24',
  'set interfaces ge-0/0/1 unit 10 family inet address 10.0.10.1/24',
  'set interfaces ge-0/0/2 description spare',
  'set interfaces st0 unit 0 family inet address 10.255.0.1/30',
  'set security ike proposal ike-prop authentication-method pre-shared-keys',
  'set security ike policy ike-pol proposals ike-prop',
  'set security ike gateway gw-hq ike-policy ike-pol',
  'set security ike gateway gw-hq address 198.51.100.10',
  'set security ipsec proposal ipsec-prop protocol esp',
  'set security ipsec policy ipsec-pol proposals ipsec-prop',
  'set security ipsec vpn hq-vpn ike gateway gw-hq',
  'set security ipsec vpn hq-vpn bind-interface st0.0',
  'set security zones security-zone trust interfaces ge-0/0/1.0',
  'set security zones security-zone untrust interfaces ge-0/0/0.0',
  'set security zones security-zone vpn interfaces st0.0',
  'set protocols ospf area 0.0.0.0 interface ge-0/0/1.0',
  'set protocols ospf area 0.0.0.0 interface ge-0/0/0.0',
].join('\n') + '\n';

// What the config says, as data — so section 3 checks the picture against the
// CONFIG rather than against itself.
const EXPECT_IFACES = ['ge-0/0/0', 'ge-0/0/1', 'ge-0/0/2', 'st0'];
const EXPECT_ZONES = { 'ge-0/0/0.0': 'untrust', 'ge-0/0/1.0': 'trust',
                       'ge-0/0/1.10': '', 'st0.0': 'vpn' };

// A second box, from a second grammar, because the policy band is EMPTY on a
// Junos paste — `corpus/dict/junos-srx` has no `security policies` entry — and
// a view whose most important band is never exercised is a view nobody has
// tested. Sequences are 1, 11, 21, 31 and the rows are deliberately NOT in that
// order in the file, so section 6 is testing a sort.
const RULES_CSV = [
  '@uuid;enabled;sequence;action;interface;direction;protocol;description;source_net;destination_net;destination_port',
  'd40b7c98-5e33-41aa-b0c7-6a2e1f8d9c07;1;31;reject;lan;out;UDP;Reject v6 DNS;any;any;53',
  '8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;1;1;pass;lan;in;any;Default allow LAN to any;lan;any;',
  '2c772765-4c1e-4c61-9f34-0b7926bbf8db;0;21;pass;opt2;in;any;Disabled Plex rule;192.168.210.0/24;any;',
  'b3a55e21-77f2-4c19-8de1-2f0c4b9a7e55;1;11;block;wan;in;TCP;Block inbound RDP;any;192.168.1.0/24;3389',
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

await page.goto(FILE);
await page.waitForFunction(() => document.getElementById('tabPaste') !== null);

// ---- helpers that read the DOM, never page internals -------------------------

const depth = () => page.locator('.dview').getAttribute('data-depth');

// The four bands, by their headings, with every item's rendered text and every
// state flag. Read out of the document in document order, which is the order
// the module sent — never out of a JS variable.
const bands = () => page.evaluate(() => {
  const out = {};
  for (const b of document.querySelectorAll('.iband')) {
    const title = b.querySelector('h3').textContent;
    out[title] = {
      // READ AS STRUCTURE, NOT AS A STRING. The kind token is a floated span
      // with no whitespace before it, so `textContent` yields `st0TunnelInterface`
      // — which is exactly right on screen and useless to split on. The heading's
      // own text node is the name; the span is the token.
      heads: [...b.querySelectorAll('.iface')].map(h => ({
        name: (h.childNodes[0] || {}).textContent
          ? h.childNodes[0].textContent.trim() : '',
        tok: (h.querySelector('.itok') || {}).textContent || '',
      })),
      items: [...b.querySelectorAll('.iitem')].map(i => ({
        id: i.getAttribute('data-inway') || i.getAttribute('data-inzone') ||
            i.getAttribute('data-inpolicy') || i.getAttribute('data-inproto') ||
            i.getAttribute('data-intunnel') || '',
        name: (i.querySelector('.iname') || {}).textContent || '',
        // EVERY meta line, not the first. A policy row carries the operator's
        // description AND, when the export says so, that it is disabled — and a
        // reader that took `querySelector` would silently test one of them.
        meta: [...i.querySelectorAll('.imeta')].map(m => m.textContent).join(' · '),
        tok: (i.querySelector('.itok') || {}).textContent || '',
        pressed: i.getAttribute('aria-pressed'),
        on: i.getAttribute('data-ion') === '1',
        off: i.getAttribute('data-ioff') === '1',
        tag: i.tagName,
      })),
      empties: [...b.querySelectorAll('.iempty')].map(e => e.textContent.trim()),
    };
  }
  return out;
});

const notes = () => page.$$eval('#ibody .inote', ns => ns.map(n => n.textContent.trim()));

// The three-line helper every diagram driver needs since Direction A merged the
// Outline and the details into ONE panel with two tabs: clicking a row turns
// the panel to DETAILS, which HIDES the Outline, so the next row is not merely
// unfound — it is present in the DOM and not visible, and Playwright waits
// thirty seconds for it. `2026-08-16-hand-link-drive.mjs` is where this was
// first written down. `#doutHead` is the OBJECTS tab.
const objects = () => page.click('#doutHead').catch(() => {});

// Select a device box by its Outline row, then open the door. Two steps and not
// one, because that IS the interaction: a rack descends on selection, a device
// does not — see `dgDetails`'s note on why the door is explicit.
async function selectDevice(hostname) {
  await page.click('[data-view="diagram"]');
  await page.waitForTimeout(120);
  await objects();
  const row = await page.evaluate((h) => {
    const r = [...document.querySelectorAll('[data-drow]')]
      .find(x => x.textContent.includes(h));
    return r ? r.getAttribute('data-drow') : null;
  }, hostname);
  if (row) await page.click('[data-drow="' + row + '"]');
  return row;
}

// Any other box on the picture, selected the same way.
async function selectRow(row) {
  await objects();
  await page.click('[data-drow="' + row + '"]');
}

// Escape until the ladder is back at the whole diagram. A LOOP AND NOT A FIXED
// NUMBER OF PRESSES, because the ladder has several rungs (`53` §3.7 unwinds
// exactly one level per press) and a driver that assumes a count is asserting
// the ladder's depth by accident every time it is used. Capped, so a rung that
// stops working fails here instead of hanging.
async function climbOut() {
  for (let i = 0; i < 6 && await depth() !== 'site'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(180);
  }
}

async function paste(text) {
  await page.click('#tabPaste');
  await page.fill('#pta', text);
  await page.click('#pRun');
  await page.waitForTimeout(400);
}

// ---- 1. THE PASTE, AND THE DOOR ---------------------------------------------

console.log('\n1. THE DOOR: A DEVICE IS SOMEWHERE YOU CAN GO INTO');

await paste(CONFIG);
await selectDevice(HOST);

check('the details pane opens on the device that was clicked',
  (await page.locator('#ddetHead').textContent()).includes(HOST),
  await page.locator('#ddetHead').textContent());
check('and it offers a way in', await page.locator('[data-dinto]').count() === 1);
check('the door names the box it opens, not the current selection',
  await page.locator('[data-dinto]').getAttribute('data-dinto') !== null);

// The door is a DEVICE's. Nothing else on this picture offers one — an
// interface, a zone and a tunnel are all drawn as boxes too.
const otherRow = await page.evaluate(() => {
  const r = [...document.querySelectorAll('[data-drow]')]
    .find(x => /Zone|Interface|IpsecVpn/.test(x.textContent));
  return r ? r.getAttribute('data-drow') : null;
});
if (otherRow) {
  await selectRow(otherRow);
  check('a box that is not a device offers no way in',
    await page.locator('[data-dinto]').count() === 0);
  await selectDevice(HOST);
} else {
  check('a box that is not a device offers no way in', false,
    'no non-device box was drawn, so this was not exercised');
}

// ---- 2. THE DESCENT IS THE SAME VERB AS THE RACK'S ---------------------------

console.log('\n2. THE LADDER: THE CHART AREA SWAPS, EVERYTHING ELSE STAYS PUT');

// `57` §2's load-bearing claim: "the band, the masthead and the side panel stay
// put". Read them BEFORE and compare AFTER, because a rung that rebuilds the
// furniture is a mode and not a rung.
const before = await page.evaluate(() => ({
  strip: !!document.querySelector('.dstrip'),
  panel: !!document.querySelector('.dpanel'),
  band: !!document.querySelector('.dband'),
  masthead: (document.querySelector('.mast') || {}).textContent || '',
  layers: [...document.querySelectorAll('[data-dlayer]')].length,
}));

check('before the descent the picture is the whole diagram',
  await depth() === 'site', await depth());

await page.click('[data-dinto]');
await page.waitForTimeout(250);

check('the depth axis says which rung, and it is a new value of the same attribute',
  await depth() === 'device', await depth());
check('the canvas is off screen, not destroyed',
  await page.locator('.dcanvas').count() === 1 &&
  !(await page.locator('.dcanvas').isVisible()));
check('rung 4 is drawn in the chart area', await page.locator('#ibody').count() === 1);
check('the rack elevation is NOT drawn', await page.locator('#rbody').count() === 0);

const after = await page.evaluate(() => ({
  strip: !!document.querySelector('.dstrip'),
  panel: !!document.querySelector('.dpanel'),
  band: !!document.querySelector('.dband'),
  masthead: (document.querySelector('.mast') || {}).textContent || '',
  layers: [...document.querySelectorAll('[data-dlayer]')].length,
}));
check('the strip, the panel and the band stay put',
  after.strip && after.panel && after.band, JSON.stringify(after));
check('the masthead is untouched', after.masthead === before.masthead);
check('the layer toggles are still there', after.layers === before.layers,
  before.layers + ' -> ' + after.layers);

// The breadcrumb, which is the ladder's own answer to "where am I".
const crumb = await page.locator('.dladder').textContent();
check('the breadcrumb names the box by its hostname, never by a ULID',
  crumb.includes(HOST) && !/:[0-9A-HJKMNP-TV-Z]{20,}/.test(crumb), crumb);
check('and it offers the rung out',
  await page.locator('[data-ddepth="site"]').count() === 1);
check('the rung you are ON is a text node with aria-current, not a pressed button',
  await page.locator('.dladder .dhere[aria-current="true"]').count() === 1);

// The band, `56` §5.2's release valve, says which rung it is describing.
check('the band says you are inside a box, not inside a rack',
  /inside a box/.test(await page.locator('.dband').textContent()),
  await page.locator('.dband').textContent());

// ---- 3. THE BANDS ARE THE CONFIG ---------------------------------------------

console.log('\n3. WHAT IS DRAWN IS WHAT WAS PASTED');

const b = await bands();
check('four bands, left to right, in the order the sentence runs',
  Object.keys(b).join(' | ') === 'way in and out | zones | policy sets | how it leaves',
  Object.keys(b).join(' | '));

const ways = b['way in and out'];
check('every interface in the config is a heading, in name order',
  ways.heads.map(h => h.name).join(',') === EXPECT_IFACES.join(','),
  ways.heads.map(h => h.name).join(' | '));
check('the interface with no unit is drawn and says so',
  ways.empties.some(e => /no unit recorded/.test(e)), ways.empties.join(' | '));
// The token marks the EXCEPTION. `st0` is a TunnelInterface and says so; the
// three plain interfaces carry no token, because a column of the same word four
// times marks nothing. Nothing is lost — the kind is on the Outline row.
check('a tunnel interface is marked as one, and a plain interface is not',
  ways.heads.filter(h => h.tok === 'TunnelInterface').length === 1 &&
  ways.heads.filter(h => h.name !== 'st0').every(h => h.tok === ''),
  ways.heads.map(h => h.name + '[' + h.tok + ']').join(' | '));

const unitNames = ways.items.map(i => i.name);
check('one item per logical unit, `.0` before `.10`',
  unitNames.join(',') === Object.keys(EXPECT_ZONES).join(','), unitNames.join(','));

// The zone of each unit, read off the picture and compared with the config.
for (const [unit, zone] of Object.entries(EXPECT_ZONES)) {
  const it = ways.items.find(i => i.name === unit);
  const said = /zone ([^\s·]+)/.exec(it.meta.replace('no zone recorded', ''));
  check('`' + unit + '` is drawn ' + (zone ? 'in zone ' + zone : 'in no zone'),
    zone ? (said && said[1] === zone) : /no zone recorded/.test(it.meta), it.meta);
}
check('the address on a unit is the address in the config',
  ways.items.find(i => i.name === 'ge-0/0/0.0').meta.includes('203.0.113.2/30'),
  ways.items.find(i => i.name === 'ge-0/0/0.0').meta);

const zones = b['zones'];
check('every zone the config names is a row',
  zones.items.map(i => i.name).sort().join(',') === 'trust,untrust,vpn',
  zones.items.map(i => i.name).join(','));
check('the unit no zone claims is COUNTED rather than left as a blank cell',
  zones.empties.some(e => /1 unit is in no zone/.test(e)), zones.empties.join(' | '));

const leaves = b['how it leaves'];
check('the tunnel names the unit it binds',
  leaves.items.some(i => i.name === 'hq-vpn' && /bound to st0\.0/.test(i.meta)),
  leaves.items.map(i => i.name + ' ' + i.meta).join(' | '));
check('and the unit names the tunnel back',
  /tunnel hq-vpn/.test(ways.items.find(i => i.name === 'st0.0').meta),
  ways.items.find(i => i.name === 'st0.0').meta);
check('ospf is drawn with the number of adjacencies the config states',
  leaves.items.some(i => i.name === 'ospf' && /2 adjacencies/.test(i.meta)),
  leaves.items.map(i => i.name + ' ' + i.meta).join(' | '));
check('the routing band says what has NOT been read, so its silence is not a claim',
  leaves.empties.some(e => /has not read a static route/.test(e)),
  leaves.empties.join(' | '));

// ---- 4. THE HONEST EMPTY STATE ON AN SRX -------------------------------------

console.log('\n4. THE BAND THAT IS EMPTY, AND SAYS WHY');

const sets = b['policy sets'];
check('an SRX paste draws no policy set', sets.items.length === 0);
check('and the band says nothing reads `set security policies` rather than going quiet',
  sets.empties.some(e => /set security policies/.test(e)), sets.empties.join(' | '));
check('it does not read as "this device has no policies"',
  sets.empties.some(e => /even when its config has hundreds/.test(e)),
  sets.empties.join(' | '));

// ---- 5. THE SENTENCE THIS VIEW EXISTS UNDER ---------------------------------
//
// `57` §6.3. The one way to get this view wrong is to overclaim, and this
// section is the assertion the whole file is for.

console.log('\n5. FATHOM DOES NOT EVALUATE POLICY');

const note = (await notes()).join(' ');
check('the standing sentence is on the screen',
  /Fathom does not evaluate policy/.test(note), note.slice(0, 90));
check('it says permitted and denied are things it never says',
  /never says permitted or denied/i.test(note));
check('and it names what it CAN say exactly',
  /which zone an interface is in/i.test(note) &&
  /in the order the device reads them/i.test(note));

// THE HALF THE SCHEMA CANNOT RECORD. `PolicySet.scope` is typed `PolicyScope`
// and `fathom_ir::value::PolicyScope` is a unit struct — it carries no zone ids
// at all — so `57` §6.3's middle clause, "which policy set governs that pair",
// is not answerable in this build. Two bands side by side with nothing between
// them read as connected unless something says otherwise.
check('the missing middle clause is stated, not left to be inferred',
  /not recorded/.test(note) && /no line is drawn between the zones and the policy sets/i.test(note),
  note.slice(-220));

// And no line IS drawn. Nothing in the chart area joins the bands.
check('no edge is rendered between the zones band and the policy band',
  await page.locator('#ibody svg, #ibody .iedge').count() === 0);

// EVERY ROW IN EVERY BAND, read as text, must contain no verdict. `permit`,
// `deny` and `reject` are the schema's own tokens for what a RULE DECLARES and
// are legitimate on a row; the words below would be Fathom's judgement of a
// packet and must appear nowhere a reader could take them for one.
//
// SCOPED TO THE ROWS AND NOT TO THE WHOLE RUNG, and the first draft of this
// check was not — it read `#ibody` entire and failed on the disclaimer's own
// "never says permitted or denied". That is the sentence promising the thing
// this test is checking, so a test that forbids it forbids the fix. The
// disclaimer is asserted positively three checks up; this one is about rows.
const rows = (await page.locator('#ibody .iitem').allTextContents())
  .join(' \u001f ').toLowerCase();
for (const word of ['permitted', 'denied', 'allowed', 'blocked', 'would match',
                    'this traffic', 'evaluat', 'safe', 'risk']) {
  check('no row in the rung says `' + word + '`', !rows.includes(word), rows.slice(0, 120));
}

// `51`'s three risk colours are RESERVED for ReadOnly / ChangesConfig /
// Disruptive. A green permit beside a red deny would spend them on a different
// axis and read as a verdict. Checked as COMPUTED colour, because a class name
// is not what a reader sees.
const risky = await page.evaluate(() => {
  const wash = ['--safe', '--caution', '--danger'].map(
    v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  const hit = [];
  for (const n of document.querySelectorAll('#ibody *')) {
    const c = getComputedStyle(n).color;
    if (wash.some(w => w && c === w)) hit.push(n.className);
  }
  return hit;
});
check('no item in the rung is painted in a reserved risk colour',
  risky.length === 0, risky.join(','));

// ---- 6. THE NARROWING, WHICH IS THE FEATURE ---------------------------------

console.log('\n6. THE NARROWING: FOUR HUNDRED BECOME THE ONES POINTING THIS WAY');

const st0 = (await bands())['way in and out'].items.find(i => i.name === 'st0.0');
await page.click('[data-inway="' + st0.id + '"]');
await page.waitForTimeout(120);

const nb = await bands();
const nWays = nb['way in and out'].items;
check('the unit chosen is marked pressed — a state a screen reader can read',
  nWays.find(i => i.name === 'st0.0').pressed === 'true');
check('and every other way in is dimmed, not hidden',
  nWays.filter(i => i.name !== 'st0.0').every(i => i.off) &&
  nWays.length === Object.keys(EXPECT_ZONES).length,
  nWays.map(i => i.name + (i.off ? '(off)' : '')).join(','));

const nZones = nb['zones'].items;
check('the zone that unit is in is the one put in play',
  nZones.find(i => i.name === 'vpn').on &&
  nZones.filter(i => i.name !== 'vpn').every(i => i.off),
  nZones.map(i => i.name + (i.on ? '(on)' : i.off ? '(off)' : '')).join(','));
check('the tunnel bound to that unit is put in play too',
  nb['how it leaves'].items.find(i => i.name === 'hq-vpn').on);

const nnote = (await notes()).join(' ');
check('the narrowing says what it did', /Narrowed to st0\.0/.test(nnote), nnote.slice(-260));
check('and says what it did NOT touch, rather than letting it look like a filter',
  /nothing in the design connects a unit to either of them/.test(nnote));
check('the band carries the narrowing too, so it survives scrolling the bands away',
  /narrowed to st0\.0/.test(await page.locator('.dband').textContent()),
  await page.locator('.dband').textContent());
check('and there is a way back', await page.locator('[data-inclear]').count() === 1);

// A unit no zone claims: choosing it must put NOTHING in play and say so,
// rather than quietly dimming everything and looking broken.
const ten = nWays.find(i => i.name === 'ge-0/0/1.10');
await page.click('[data-inway="' + ten.id + '"]');
await page.waitForTimeout(120);
const zb = await bands();
check('a unit in no zone puts no zone in play',
  zb['zones'].items.every(i => !i.on), zb['zones'].items.map(i => i.name).join(','));
check('and the view says that is a fact about the design, not about the device',
  /is a fact about the design rather than about the device/.test((await notes()).join(' ')));

// Pressing the one already in play clears it — which is what aria-pressed
// promises, and a toggle that only ever turns on is a lie in the accessible
// tree.
await page.click('[data-inway="' + ten.id + '"]');
await page.waitForTimeout(120);
check('pressing the way in that is already in play clears the narrowing',
  await page.locator('[data-inclear]').count() === 0 &&
  (await bands())['way in and out'].items.every(i => !i.off));

// ---- 7. THE KEYBOARD, WALKED ------------------------------------------------
//
// `55`: "a state only a mouse can see is not a state". Every gesture above is
// walked here with keys and nothing else.

console.log('\n7. THE KEYBOARD PATH, WALKED');

// ONE press, deliberately not a loop. The descent closes the details pane (see
// `dgDescend`), so with no narrowing in play the rung out is the FIRST rung on
// the ladder and one Escape is the whole journey. This assertion is what found
// the defect: before the fix the pane was still open, so the first press closed
// it and rung 4 needed two.
await page.keyboard.press('Escape');
await page.waitForTimeout(220);
check('one escape climbs out of rung 4', await depth() === 'site', await depth());

// Back in, by keyboard alone: focus the door and press Enter.
await selectDevice(HOST);
await page.focus('[data-dinto]');
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
check('enter on the door descends', await depth() === 'device', await depth());
check('and a keyboard descent lands focus on the rung out, never on <body>',
  await page.evaluate(() => document.activeElement &&
    document.activeElement.getAttribute('data-ddepth') === 'site'),
  await page.evaluate(() => document.activeElement.outerHTML.slice(0, 80)));

// Walk into the bands and narrow with the keyboard. `data-rove` gives each band
// one tab stop and arrows inside it, which is this page's pattern everywhere.
await page.focus('#ibody [data-inway]');
check('the first way in is the band\'s tab stop',
  await page.evaluate(() => document.activeElement.getAttribute('tabindex') === '0'));
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
const walked = await page.evaluate(() =>
  document.activeElement.querySelector('.iname').textContent);
check('arrow keys walk the ways in, in the order they are drawn',
  walked === unitNames[2], walked + ' vs ' + unitNames[2]);
await page.keyboard.press('Enter');
await page.waitForTimeout(120);
check('enter narrows to the way in under the cursor',
  await page.evaluate(() => document.activeElement.getAttribute('aria-pressed') === 'true'));

// The Escape ladder, one rung at a time and most-recent first (`53` §3.7).
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('the first escape clears the narrowing and stays inside the box',
  await depth() === 'device' && await page.locator('[data-inclear]').count() === 0,
  await depth());
check('and focus is not stranded on <body>',
  await page.evaluate(() => document.activeElement !== document.body &&
    document.activeElement.tagName !== 'BODY'),
  await page.evaluate(() => document.activeElement.tagName));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('the second escape climbs out to the whole diagram',
  await depth() === 'site', await depth());

// ---- 8. THE POLICY BAND, ON AN ESTATE THAT HAS ONE --------------------------
//
// A second box from a second grammar. `OP_PASTE` is additive since 2026-08-21,
// so this joins the SRX rather than replacing it.

console.log('\n8. THE POLICIES, IN THE ORDER THE DEVICE READS THEM');

await climbOut();
await paste(RULES_CSV);

await page.click('[data-view="diagram"]');
await page.waitForTimeout(150);
await objects();
const fw = await page.evaluate(() => {
  const r = [...document.querySelectorAll('[data-drow]')]
    .find(x => /Device/.test(x.textContent) && !x.textContent.includes('srx-branch-01'));
  return r ? r.getAttribute('data-drow') : null;
});
check('the rules export became a second box', fw !== null);
await page.click('[data-view="diagram"]');
await page.waitForTimeout(150);
await selectRow(fw);
await page.click('[data-dinto]');
await page.waitForTimeout(250);

const pb = (await bands())['policy sets'];
check('the policy set is drawn with its policies',
  pb.items.length === 4, pb.items.length + ' items');
check('IN THE ORDER THE DEVICE READS THEM — 1, 11, 21, 31, not file order',
  pb.items.map(i => i.name.trim().split(/\s+/)[0]).join(',') === '1,11,21,31',
  pb.items.map(i => i.name.trim()).join(' | '));
check('each policy carries the schema\'s own action token',
  pb.items.map(i => i.tok).join(',') === 'permit,deny,permit,reject',
  pb.items.map(i => i.tok).join(','));
check('the rule the export marks disabled says so and is still drawn',
  /disabled on the device/.test(pb.items[2].meta), pb.items[2].meta);
check('and the enabled ones carry no claim about it',
  pb.items.filter((_, n) => n !== 2).every(i => !/disabled|enabled/.test(i.meta)),
  pb.items.map(i => i.meta).join(' | '));
// The rule is named by its uuid on the device and DESCRIBED by a person. Both
// are shown: the uuid identifies it in the config, the description says what it
// is for, and a band of uuids alone is a band nobody can read.
check('each policy shows what the operator wrote about it, beside its uuid',
  pb.items[0].meta.includes('Default allow LAN to any') &&
  pb.items[1].meta.includes('Block inbound RDP') &&
  pb.items[3].meta.includes('Reject v6 DNS'),
  pb.items.map(i => i.meta).join(' | '));
check('and the uuid is still there, because that is what identifies it on the box',
  pb.items[1].name.includes('b3a55e21-77f2-4c19-8de1-2f0c4b9a7e55'),
  pb.items[1].name);
check('the set says which zones it governs is NOT RECORDED',
  pb.empties.some(e => /which zones it governs is not recorded/.test(e)),
  pb.empties.join(' | '));
check('and the band repeats that Fathom does not say which one would match',
  pb.empties.some(e => /does not say which one would match/.test(e)),
  pb.empties.join(' | '));

// The picture, for a reader. Not the evidence — every assertion above is — but
// a screen nobody has looked at is a screen nobody has judged.
await page.screenshot({ path: OUT + '/2026-08-22-inside-the-box-policies.png', fullPage: true });

// ---- 9. THE RACK RUNG IS UNTOUCHED ------------------------------------------
//
// Two rungs on one ladder. Rung 4 must not have changed rung 2, and the way to
// know is to use it.

console.log('\n9. RUNG 2 STILL WORKS');

await climbOut();
check('the ladder is back at the whole diagram before rung 2 is used',
  await depth() === 'site', await depth());

// A BOX ADDED THROUGH THE FORM, because the chassis picker on the placement
// form lists `Chassis` nodes and `equip_add` is what builds one — a pasted
// config does not. Leaving this out is how this section first failed, with an
// empty picker and the sheet stuck open over the page.
await page.click('#tabEquip');
await page.waitForTimeout(80);
await page.fill('#ef6', 'lab-sw-01');
await page.selectOption('#ef7', 'junos-srx');
await page.click('#eRun');
await page.waitForTimeout(250);

await page.click('#tabEquip');
await page.waitForTimeout(80);
await page.click('#rAdd');
await page.waitForTimeout(120);
const map = await page.locator('#mform label').evaluateAll(
  ls => Object.fromEntries(ls.map(
    l => [l.textContent.replace(/ — required$/, '').trim(), l.getAttribute('for')])));
await page.fill('#' + map['rack name'], 'R12');
await page.fill('#' + map['rack height in units'], '10');
await page.selectOption('#' + map['unit numbering'], 'ascending');
await page.fill('#' + map['position — lowest unit the box occupies'], '3');
// The chassis is REQUIRED and the form will refuse without it — the same
// refusal the rack driver's own helper works around, and leaving it out is how
// this section first failed with the sheet still open over the page.
const opts = await page.locator('#mfChassis option').evaluateAll(
  os => os.map(o => ({ v: o.value, t: o.textContent })));
check('the placement form offers the box that was just added', opts.length > 0,
  opts.map(o => o.t).join(' | '));
await page.selectOption('#mfChassis',
  (opts.find(o => o.t.includes('lab-sw-01')) || opts[opts.length - 1]).v);
await page.click('#mRun');
await page.waitForTimeout(400);

check('placing a box still descends into its rack', await depth() === 'rack', await depth());
check('and it is the RACK rung, named as one, not rung 4 wearing its clothes',
  await page.locator('.dview[data-depth="rack"]').count() === 1);
check('the rack elevation is drawn and rung 4 is not',
  await page.locator('#rbody').count() === 1 &&
  await page.locator('#ibody').count() === 0);
check('the breadcrumb still says `rack`',
  /rack R12/.test(await page.locator('.dladder').textContent()),
  await page.locator('.dladder').textContent());
check('the band still says you are inside a rack',
  /inside a rack/.test(await page.locator('.dband').textContent()),
  await page.locator('.dband').textContent());
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.waitForTimeout(220);
check('and escape still comes back out of it', await depth() === 'site', await depth());

// ---- 10. DETERMINISM --------------------------------------------------------
//
// Invariant 9. Leave the rung, come back, and the bands are byte-identical.

console.log('\n10. THE SAME ESTATE DRAWS THE SAME BANDS');

await climbOut();
await selectDevice(HOST);
await page.click('[data-dinto]');
await page.waitForTimeout(250);
const once = JSON.stringify(await bands());
await page.screenshot({ path: OUT + '/2026-08-22-inside-the-box.png', fullPage: true });
await climbOut();
await selectDevice(HOST);
await page.click('[data-dinto]');
await page.waitForTimeout(250);
check('the same estate draws the same bands every time',
  once === JSON.stringify(await bands()));

// ---- the invariants that hold whatever this feature does ---------------------

check('exactly one network request, the file itself',
  requests.filter(u => u !== 'about:blank').every(u => u === FILE),
  requests.length + ' requests');
check('no page errors and no console errors', errors.length === 0, errors.join(' | '));

const bad = results.filter(r => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
await browser.close();
process.exit(bad.length ? 1 : 0);
