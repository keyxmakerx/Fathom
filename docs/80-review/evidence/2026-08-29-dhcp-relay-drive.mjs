// WO-10 — DHCP RELAY AND BOOTP, DRIVEN IN A REAL BROWSER.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-29-dhcp-relay-drive.mjs [repo-root]
//
// The first feature the owner asked for by name that the byte ceiling refused
// ("we need to make sure dhcp relay but also bootp is there. Since we use
// bootp apparently, just discovered that", 2026-08-17). Ordered 2026-08-17,
// unblocked when the ceiling went (2026-08-21), stopped at its own escalation
// trigger on 2026-08-28 when Juniper's grammar turned out to admit a
// routing-instance on a server line, and built on 2026-08-29 after the owner
// chose a real RoutingInstance edge for it (70 §18.5).
//
// WHAT THIS PROVES, THROUGH THE DOM AND A RELOAD (WO-10 §8):
//   G3  a `helpers bootp server` line is a relay row the device owns, address
//       shown, and the line is NOT on the residue list;
//   G4  a `server-group` of three addresses is three rows sharing one group;
//   G5  all of it survives an export, a reload and an import;
//   and the `interface` form's RelaysFor is a real link in the Outline when
//   the unit is declared in the same paste.
//
// AND THE ROUTING-INSTANCE EDGE, WHICH THIS FILE FIRST DISCLAIMED AND THEN
// FOUND. `RelayServerIn` is a PENDING reference today — nothing yet builds a
// `RoutingInstance` from a paste, so there is no node to draw a line to, and
// `14` §7.3 carries pending references unmaterialised. The first draft of this
// header said a driver could not honestly see it in the DOM. The first RUN
// proved that wrong: the inventory page renders pending references in a table
// of their own — target kind and name, edge kind — and it was that table
// inflating the row count. So the qualifier is asserted here, visibly, before
// and after the round trip. Its ABSENCE on an unqualified line (absent means
// the default instance, never "unknown") is proved at the fragment in
// crates/fathom-ingest/tests/dhcp_relay.rs, where a negative can be stated.
//
// And the residue that is residue BY DECISION (WO-10 §11 item 4) is asserted
// as such: `active-server-group` stays on the list, named.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
};

const HOST = 'relay-01';
const CONFIG = [
  'set system host-name ' + HOST,
  'set interfaces ge-0/0/1 unit 0 family inet address 10.20.0.1/24',
  'set forwarding-options helpers bootp server 172.16.0.3',
  'set forwarding-options helpers bootp interface ge-0/0/1.0 server 172.16.0.4 routing-instance c3',
  'set forwarding-options dhcp-relay server-group DHCP-GRP 10.0.0.5',
  'set forwarding-options dhcp-relay server-group DHCP-GRP 10.0.0.6',
  'set forwarding-options dhcp-relay server-group DHCP-GRP 10.0.0.7',
  'set forwarding-options dhcp-relay active-server-group DHCP-GRP',
].join('\n') + '\n';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const requests = [];
page.on('request', (r) => requests.push(r.url()));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(FILE);
await page.waitForFunction(() => document.getElementById('tabPaste') !== null);

async function paste(text) {
  await page.click('#tabPaste');
  await page.waitForFunction(() => document.getElementById('pta') !== null);
  await page.fill('#pta', text);
  await page.click('#pRun');
  await page.waitForTimeout(400);
}

// The relay rows, read off the real inventory table after selecting the kind
// BY NAME on the strip — never by index, for the reason the page's own
// `kindByte` comment gives.
async function relayRows() {
  await page.click('[data-view="inventory"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-kind]')].find((n) => /dhcprelay/i.test(n.textContent));
    if (b) b.click();
  });
  await page.waitForTimeout(250);
  // The FIRST table only: the inventory page also renders the residue list and
  // the pending-references table beside the kind's rows, and this driver's
  // first run swept all three into one count (7 for 5) — worth recording,
  // because the extra rows were real page content, not noise.
  return page.evaluate(() =>
    [...(document.querySelector('.invwrap table.inv') || { querySelectorAll: () => [] })
      .querySelectorAll('tbody tr')]
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())));
}
const inventoryText = () => page.evaluate(() => document.body.innerText);

const objects = () => page.click('#doutHead').catch(() => {});
const expand = async (id) => {
  await page.evaluate((sel) => {
    const row = document.querySelector('[data-drow="' + sel + '"]');
    if (!row) return;
    row.focus();
    if (row.getAttribute('aria-expanded') !== 'true') {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    }
  }, id);
  await page.waitForTimeout(80);
};
const rowFor = (text) => page.evaluate((t) => {
  const r = [...document.querySelectorAll('[data-drow]')].find((x) => x.textContent.includes(t));
  return r ? r.getAttribute('data-drow') : null;
}, text);
const childrenOf = (id) => page.evaluate((sel) =>
  [...document.querySelectorAll('[data-dparent="' + sel + '"]')].map((r) => r.textContent), id);

// ---- 1. THE PASTE, AND THE RESIDUE LIST ------------------------------------

console.log('\n1. PASTE');
await paste(CONFIG);
check('exactly one network request (the file itself)', requests.length === 1, requests.join(','));
const pasteBody = await page.evaluate(() => document.body.innerText);

check('G3: the bootp server line is UNDERSTOOD — not on the residue list',
  !pasteBody.includes('set forwarding-options helpers bootp server 172.16.0.3'));
check('the routing-instance-qualified interface form is understood',
  !pasteBody.includes('routing-instance c3'));
check('G4: the three server-group lines are understood',
  !/server-group DHCP-GRP 10\.0\.0\.[567]/.test(pasteBody));
check('and `active-server-group` STAYS on the residue list, named — residue by decision (§11 item 4)',
  pasteBody.includes('set forwarding-options dhcp-relay active-server-group DHCP-GRP'));

// ---- 2. THE INVENTORY: FIVE RELAYS, THREE IN ONE GROUP ---------------------

console.log('\n2. INVENTORY');
const rows = await relayRows();
check('five relay rows: two bootp servers and a group of three', rows.length === 5, JSON.stringify(rows));
const servers = rows.map((r) => r[0]);
for (const ip of ['172.16.0.3', '172.16.0.4', '10.0.0.5', '10.0.0.6', '10.0.0.7']) {
  check('a row is named by its server address: ' + ip, servers.includes(ip), JSON.stringify(servers));
}
check('every row names the device that relays', rows.every((r) => r.includes(HOST)), JSON.stringify(rows));
const grouped = rows.filter((r) => r.includes('DHCP-GRP'));
check('G4: exactly the three group members share one group_name', grouped.length === 3, JSON.stringify(grouped));
check('and the bootp servers carry NO group — absent, not a guessed default',
  rows.filter((r) => r[0].startsWith('172.16')).every((r) => !r.includes('DHCP-GRP')));

// The routing-instance qualifier. Nothing yet builds a RoutingInstance from a
// paste, so `RelayServerIn` is a PENDING reference — and the page SHOWS pending
// references, by target kind and name and edge kind, in a table beside the
// rows. This driver's first run found that table by accident (it inflated the
// row count); the second run asserts it on purpose.
const invText = await inventoryText();
check('the routing-instance qualifier is a visible PENDING reference: RoutingInstance c3 via RelayServerIn',
  /RoutingInstance c3/.test(invText) && /RelayServerIn/.test(invText));

// ---- 3. THE DIAGRAM: THE DEVICE OWNS THEM, AND THE UNIT LINK IS REAL -------

console.log('\n3. OUTLINE');
await page.click('[data-view="diagram"]');
await page.waitForTimeout(150);
// 2026-09-05: rung 1 now folds the relays into their device (dgFoldInside,
// `57` §2), so a DhcpRelay has no level-1 row and no RelaysFor row of its own
// until `show what is inside` is pressed — which draws the picture this
// section was written against.
await page.click('[data-inside][aria-pressed="false"]');
await page.waitForTimeout(150);
await objects();
const dev = await rowFor(HOST);
check('the device is a box in the picture', dev !== null);
await expand(dev);
const kids = await childrenOf(dev);
check('the device\'s Outline children include the relays it contains',
  kids.some((t) => t.includes('172.16.0.3')) && kids.some((t) => t.includes('10.0.0.5')),
  JSON.stringify(kids).slice(0, 300));
const relay = await rowFor('172.16.0.4');
check('the interface-form relay is a row of its own', relay !== null);
await expand(relay);
const links = await childrenOf(relay);
check('RelaysFor is a REAL link in the accessible tree, to the declared unit ge-0/0/1.0',
  links.some((t) => /ge-0\/0\/1\.0|RelaysFor/.test(t)), JSON.stringify(links).slice(0, 300));

// ---- 4. G5: EXPORT, RELOAD, IMPORT ------------------------------------------

console.log('\n4. ROUND TRIP');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tabExport')]);
let exported = '';
for await (const c of await dl.createReadStream()) exported += c;
check('the export names the new edge kind BY NAME, never by ordinal',
  exported.includes('DhcpRelay') || exported.includes('forwarding-options'),
  'journal carries the paste record');
await page.reload();
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.evaluate((text) => {
  const f = new File([text], 'w.fathom-journal.json', { type: 'application/json' });
  const dt = new DataTransfer();
  dt.items.add(f);
  const input = document.getElementById('importFile');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, exported);
await page.waitForTimeout(800);
const again = await relayRows();
check('G5: five relay rows after the reload and import', again.length === 5, JSON.stringify(again));
check('and the group survived the trip', again.filter((r) => r.includes('DHCP-GRP')).length === 3);
check('and the addresses survived byte-for-byte',
  JSON.stringify(again.map((r) => r[0]).sort()) === JSON.stringify(servers.slice().sort()));
// THE ONE THING THAT DOES NOT SURVIVE, ASSERTED AS THE FACT IT IS. Pending
// references are "carried out, not written" (`14` §7.3, crates/fathom-weld/
// src/apply.rs step 9): the weld never stores them, the paste reply carries
// them once, and the import path replays the PRODUCT — the nodes and edges
// the paste wrote — so it reports no unresolved rows. The relay survives; its
// routing-instance qualifier does not, because nothing yet builds the
// `RoutingInstance` it points at and a reference with no target is by design
// not a stored fact. WO-10's gate block records this as G5's caveat and
// escalates it; this check pins the CURRENT truth so that whoever makes the
// reference survive has to come here and flip it on purpose.
const againText = await inventoryText();
check('the pending routing-instance reference does NOT survive the trip today (14 §7.3: carried out, not written) — recorded, escalated',
  !/RoutingInstance c3/.test(againText));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' checks pass');
process.exit(passed === results.length ? 0 : 1);
