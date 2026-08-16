// Drive the real page against ONE config carrying BOTH dictionary widenings,
// and ASSERT ON THE DOM. This is the reconciliation's end-to-end evidence: the
// two slices were built and reviewed separately, and the question a merged tree
// has to answer is whether they still work TOGETHER in a browser.
//
// It asserts three things, in the owner's priority order:
//
//   SECURITY   every credential in the paste is destroyed -- the OSPF plaintext
//              password that regressed, the BGP TCP-MD5 key at all three
//              documented levels, the IKE pre-shared key, the SNMP community.
//              Checked against the whole rendered page, not just the capture.
//   FIDELITY   no phantom row. A legal Junos RIP line shaped exactly like the
//              BGP one must not put a peer in the estate of record.
//   FUNCTION   RoutingProtocol and ProtocolAdjacency populate, and the zone and
//              VLAN work from the other slice still populates beside them.
//
//   cargo run --locked -p fathom-artifact          # build the artifact first
//   node scripts/drive-reconciled-paste.mjs
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
// Playwright is NOT a repo dependency and must not become one (ADR-0032 gate
// zero); it is reached by absolute path from the machine.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pw = await import(
  process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js'
);
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARTIFACT = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const SHOTS = ROOT + '/docs/80-review/evidence/';

// Every credential below is a canary: distinctive, and it must appear nowhere
// in the rendered page. The OSPF simple-password is the one that regressed --
// documented at [edit protocols ospf area <id> interface <name>], destroyed at
// adbb590, stored verbatim once the OSPF entries landed, destroyed again now.
const SECRETS = [
  'FATHOMDRIVEospfSimplePw0123456789',
  'FATHOMDRIVEbgpKeyBare',
  'FATHOMDRIVEbgpKeyGroup',
  'FATHOMDRIVEbgpKeyNeighbour',
  'FATHOMDRIVEikePreShared0123456789',
  'FATHOMDRIVEsnmpCommunity',
];

const PASTE = `set system host-name srx-reconciled-01
set system time-zone America/New_York
set system ntp server 192.0.2.30
set routing-options router-id 10.0.0.9
set protocols ospf reference-bandwidth 100000000000
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 metric 100
set protocols ospf area 0.0.0.0 interface ge-0/0/2.0 passive
set protocols ospf area 0.0.0.1 interface st0.0 interface-type p2p
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 authentication simple-password FATHOMDRIVEospfSimplePw0123456789
set protocols bgp local-as 65001
set protocols bgp authentication-key FATHOMDRIVEbgpKeyBare
set protocols bgp group ISP-EDGE authentication-key FATHOMDRIVEbgpKeyGroup
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 peer-as 64512
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 authentication-key FATHOMDRIVEbgpKeyNeighbour
set protocols rip group RIP-GRP neighbor ge-0/0/9.0
set vlans guests vlan-id 20
set vlans guests l3-interface irb.20
set interfaces ge-0/0/4 disable
set interfaces ge-0/0/6 unit 0 vlan-id 100
set security flow tcp-mss ipsec-vpn mss 1350
set security zones security-zone trust host-inbound-traffic protocols all
set security zones security-zone untrust tcp-rst
set security ike policy ike-pol pre-shared-key ascii-text FATHOMDRIVEikePreShared0123456789
set snmp community FATHOMDRIVEsnmpCommunity authorization read-only
`;

const fails = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) fails.push(name);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
const requests = [];
page.on('request', (r) => requests.push(r.url()));
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

await page.goto(ARTIFACT);
await page.waitForTimeout(400);
await page.click('#tabPaste');
await page.waitForTimeout(150);
await page.fill('#pta', PASTE);
await page.click('#pRun');
await page.waitForTimeout(1000);

check('exactly one network request (the file itself)', requests.length === 1, requests.join(','));
check('no console errors', errs.length === 0, errs.join(' | '));

// ---------------------------------------------------------------------------
// SECURITY FIRST. Against the full serialised page, not the capture pane only:
// a credential that reached a field, a row, a tooltip or a title attribute is
// just as stored as one left in the capture.
// ---------------------------------------------------------------------------
const html = await page.content();
const text = await page.evaluate(() => document.body.innerText);
for (const secret of SECRETS) {
  check('destroyed, nowhere in the page: ' + secret, !html.includes(secret));
}
check('the page still shows it read the paste', /understood/.test(text), text.slice(0, 120));

// ---------------------------------------------------------------------------
// FIDELITY. The `where:` constraint, seen from the browser.
// ---------------------------------------------------------------------------
async function openKind(name) {
  const ok = await page.evaluate((want) => {
    const els = Array.from(document.querySelectorAll('button,li,div'));
    const hit = els.find((b) => b.innerText && b.innerText.trim().toUpperCase() === want);
    if (!hit) return false;
    hit.click();
    return true;
  }, name);
  await page.waitForTimeout(400);
  return ok;
}
// SCOPED to the inventory table. `table tr` also scoops the residue table and
// the unresolved-names table, and the residue list legitimately QUOTES the RIP
// line -- so an unscoped selector reports the phantom-row check as failing when
// what it actually found was the residue list doing its job. Caught by driving
// it; the first version of this script had exactly that bug.
async function rows() {
  return page.evaluate(() => {
    const t = document.querySelector('table.inv:not(.resid)');
    if (!t) return [];
    return Array.from(t.rows).map((tr) =>
      Array.from(tr.cells).map((c) => c.innerText.trim()).join(' | ')
    );
  });
}

check('the RoutingProtocol kind is selectable', await openKind('ROUTINGPROTOCOL')
  || await openKind('ROUTING PROTOCOL'));
const rp = (await rows()).join('\n');
console.log('--- RoutingProtocol rows ---\n' + rp);
check('a bgp RoutingProtocol row exists', /bgp/i.test(rp));
check('an ospf RoutingProtocol row exists', /ospf/i.test(rp));
check('the local AS 65001 is on the row', rp.includes('65001'));
check('the router id 10.0.0.9 is on the row', rp.includes('10.0.0.9'));
// The phantom the unconstrained `$proto` minted: one legal RIP line used to put
// a `rip` protocol row here.
check('NO rip RoutingProtocol row (the `where:` constraint)', !/\brip\b/i.test(rp), rp);

check('the ProtocolAdjacency kind is selectable', await openKind('PROTOCOLADJACENCY')
  || await openKind('PROTOCOL ADJACENCY'));
const adj = (await rows()).join('\n');
console.log('--- ProtocolAdjacency rows ---\n' + adj);
check('the BGP peer 203.0.113.1 is a row', adj.includes('203.0.113.1'));
check('its peer AS 64512 is on the row', adj.includes('64512'));
check('OSPF area 0.0.0.0 renders as a dotted quad', adj.includes('0.0.0.0'));
check('the OSPF cost 100 is on the row', adj.includes('100'));
// The empty phantom row: the RIP interface name is correctly refused as an
// IpAddr, so the row it used to mint had no fields at all.
check('NO row naming the RIP interface ge-0/0/9.0', !adj.includes('ge-0/0/9.0'), adj);
const blank = (await rows()).filter((r) => /^(—|-|\s|\|)+$/.test(r));
check('no all-empty ProtocolAdjacency row', blank.length === 0, blank.join(' / '));

// ---------------------------------------------------------------------------
// FUNCTION. The other slice still works in the same paste.
// ---------------------------------------------------------------------------
check('the Zone kind is selectable', await openKind('ZONE'));
const zones = (await rows()).join('\n');
check('zone trust is in the estate', zones.includes('trust'));
check('zone untrust is in the estate', zones.includes('untrust'));

// `Vlan` has NO inventory row set -- there is no VLAN button in the kind list.
// That is pre-existing and outside this reconciliation (`00-ROUTE-TO-WORKABLE`
// §2 counts the inventory kinds against the kinds a paste builds), and it is
// asserted here rather than worked around, so that the day a Vlan row set lands
// this check fails and someone strengthens it.
const kinds = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button')).map((b) => (b.innerText || '').trim())
);
check('recorded: there is still no Vlan inventory kind', !kinds.includes('VLAN'));
// So the VLAN half of the widening is evidenced where it IS visible: the two
// `vlans` lines bound, and a line that binds is not on the residue list.
check('set vlans guests vlan-id 20 bound (absent from residue)',
  !text.includes('set vlans guests vlan-id 20'));
check('set vlans guests l3-interface irb.20 bound (absent from residue)',
  !text.includes('set vlans guests l3-interface irb.20'));
check('the unit vlan-id line bound (absent from residue)',
  !text.includes('set interfaces ge-0/0/6 unit 0 vlan-id 100'));

// The RIP line must be VISIBLE as residue rather than silently dropped: that is
// the whole difference between "we do not model this" and "we lost it".
check('the RIP line is named on the residue list',
  text.includes('set protocols rip group RIP-GRP neighbor ge-0/0/9.0'));

await page.screenshot({ path: SHOTS + '2026-08-15-reconciled-paste.png', fullPage: true });
await browser.close();

console.log(fails.length ? '\nFAILURES: ' + fails.join('\n          ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
