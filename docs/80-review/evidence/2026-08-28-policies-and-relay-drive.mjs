// The 2026-08-28 widening, driven in a real browser, and the DHCP relay/BOOTP
// claim checked honestly rather than as instructed.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-28-policies-and-relay-drive.mjs [repo-root]
//
// Requires the artifact at target/artifact/fathom-dev.html.
//
// WHAT THIS FILE IS, AND WHY IT DOES NOT MATCH ITS OWN BRIEF IN ONE PLACE.
// The mission that produced this file asked for a single driver asserting
// four things: the policy band is non-empty and names a pasted policy, the
// description and domain-name are understood, the DHCP relay/bootp lines are
// NOT on the residue list, and the whole thing round-trips through an export
// and an import. Three of those four are real and are asserted below. The
// fourth is false on this tree: `WO-10-dhcp-relay-and-bootp.md` was NOT
// executed. The executing session (`wo10-build`, 2026-08-28) reached the
// order's own §10 item 3 stop-and-escalate trigger before writing anything —
// two independent, dated Juniper sources (the CLI Reference "helpers"
// statement page and the Junos DHCP User Guide's worked example, both
// re-confirmed by this prover via an independent web search on 2026-08-28,
// e.g. "server 172.16.0.3 routing-instance c3;") establish that
// `routing-instance` may qualify an individual `server` statement under
// `helpers bootp`, and `DhcpRelay` as spelled in §4 carries no edge for it —
// exactly the order's own escalation condition. No schema change, no
// dictionary file, and no `DhcpRelay` kind exist on this tree (confirmed:
// `grep -n DhcpRelay schema/schema.yaml` returns nothing, `git status` was
// clean before this file was added). So a `helpers bootp server` line is
// UNDERSTOOD BY NOBODY yet, and belongs on the residue list — asserting
// otherwise would be exactly the "green lie" the prover's brief forbids.
// Section 4 below asserts the honest fact: the relay/bootp lines DO appear
// on the residue list, named individually, not silently dropped — which is
// the correct behaviour for an unimplemented statement and is itself worth
// proving, because a residue line that vanished would be `14`'s governing
// rule broken.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

const HOST = 'pol-relay-01';
const CONFIG = [
  'set system host-name ' + HOST,
  'set system domain-name relay.example.net',
  'set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30',
  'set interfaces ge-0/0/0 description "WAN uplink"',
  'set security policies from-zone trust to-zone untrust policy p1 match source-address any',
  'set security policies from-zone trust to-zone untrust policy p1 match destination-address any',
  'set security policies from-zone trust to-zone untrust policy p1 then permit',
  'set forwarding-options helpers bootp server 172.16.0.3',
  'set forwarding-options dhcp-relay server-group DHCP-GRP 10.0.0.5',
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

// ---- helpers, the shape `2026-08-28-security-policies-drive.mjs` and
// `2026-08-22-inside-the-box.mjs` already established ------------------------

const objects = () => page.click('#doutHead').catch(() => {});

async function selectDevice(hostname) {
  await page.click('[data-view="diagram"]');
  await page.waitForTimeout(120);
  await objects();
  const row = await page.evaluate((h) => {
    const r = [...document.querySelectorAll('[data-drow]')]
      .find((x) => x.textContent.includes(h));
    return r ? r.getAttribute('data-drow') : null;
  }, hostname);
  if (row) await page.click('[data-drow="' + row + '"]');
  return row;
}

const bands = () => page.evaluate(() => {
  const out = {};
  for (const b of document.querySelectorAll('.iband')) {
    const title = b.querySelector('h3').textContent;
    out[title] = {
      heads: [...b.querySelectorAll('.iface')].map((h) => ({
        name: (h.childNodes[0] || {}).textContent
          ? h.childNodes[0].textContent.trim() : '',
        tok: (h.querySelector('.itok') || {}).textContent || '',
      })),
      items: [...b.querySelectorAll('.iitem')].map((i) => ({
        id: i.getAttribute('data-inpolicy') || '',
        name: (i.querySelector('.iname') || {}).textContent || '',
        tok: (i.querySelector('.itok') || {}).textContent || '',
      })),
      empties: [...b.querySelectorAll('.iempty')].map((e) => e.textContent.trim()),
    };
  }
  return out;
});

async function paste(text) {
  await page.click('#tabPaste');
  await page.waitForFunction(() => document.getElementById('pta') !== null);
  await page.fill('#pta', text);
  await page.click('#pRun');
  await page.waitForTimeout(400);
}

// ---- 1. THE PASTE -----------------------------------------------------------

console.log('\n1. PASTE');

await paste(CONFIG);

check('exactly one network request (the file itself)', requests.length === 1, requests.join(','));
check('no console or page errors', errors.length === 0, errors.join(' | '));

// The residue table lives on the paste sheet's own result view and is not
// retained once the tab is left and reopened (`2026-08-28-security-policies
// -drive.mjs` documented this first) — capture it here.
const pasteResultBody = await page.evaluate(() => document.body.innerText);

// ---- 2. THE POLICY BAND, NAMED --------------------------------------------

console.log('\n2. THE POLICY BAND NAMES A PASTED POLICY');

const row = await selectDevice(HOST);
check('the device landed as a box on the diagram', row !== null);

await page.click('[data-dinto]');
await page.waitForTimeout(250);
check('rung 4 opened', await page.locator('.dview').getAttribute('data-depth') === 'device');

const pb1 = (await bands())['policy sets'];
check('the policy band is non-empty', pb1.items.length > 0, JSON.stringify(pb1.items));
check('it names the pasted policy p1',
  pb1.items.some((i) => i.name.trim() === '0  p1'), JSON.stringify(pb1.items));
check('carrying the schema\'s own permit token',
  pb1.items.every((i) => i.tok === 'permit'), JSON.stringify(pb1.items.map((i) => i.tok)));

// ---- 3. DESCRIPTION AND DOMAIN-NAME ARE UNDERSTOOD, NOT RESIDUE -----------

console.log('\n3. DESCRIPTION AND DOMAIN-NAME');

// domain-name has no dedicated inventory column (`DEVICE_COLUMNS` is
// hostname/platform/os_version/role/premises/name_conformance) so the only
// observable proof it was understood is that it is ABSENT from the residue
// table — the same negative check `66` §3 uses to state a section's miss
// count.
check('the domain-name line is understood, not residue',
  !pasteResultBody.includes('set system domain-name relay.example.net'));

// The interface description DOES have a column (`INTERFACE_COLUMNS`), so
// check it lands there for real, on the actual inventory row.
await page.click('[data-view="inventory"]');
await page.waitForTimeout(200);
await page.click('[data-kind="3"]'); // Interface
await page.waitForTimeout(200);
const ifaceRow = await page.evaluate(() => {
  const tr = [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .find((r) => r.textContent.includes('ge-0/0/0'));
  return tr ? [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()) : null;
});
check('the interface row exists', ifaceRow !== null, JSON.stringify(ifaceRow));
check('and carries the pasted description',
  ifaceRow && ifaceRow.some((c) => c.includes('WAN uplink')), JSON.stringify(ifaceRow));
check('the description line is understood, not residue',
  !pasteResultBody.includes('set interfaces ge-0/0/0 description "WAN uplink"'));

// ---- 4. DHCP RELAY / BOOTP — HONEST RESULT, NOT THE BRIEF'S ASSUMPTION ----

console.log('\n4. DHCP RELAY / BOOTP — WO-10 WAS NOT BUILT, AND THE PAGE SAYS SO CORRECTLY');

check('the bootp server line is named on the residue list (WO-10 not built)',
  pasteResultBody.includes('set forwarding-options helpers bootp server 172.16.0.3'));
check('the dhcp-relay server-group line is named on the residue list (WO-10 not built)',
  pasteResultBody.includes('set forwarding-options dhcp-relay server-group DHCP-GRP 10.0.0.5'));
check('neither line was silently dropped — both are named, not just counted',
  /set forwarding-options helpers bootp server/.test(pasteResultBody) &&
  /set forwarding-options dhcp-relay server-group/.test(pasteResultBody));

// ---- 5. THE ROUND TRIP -----------------------------------------------------

console.log('\n5. EXPORT, RELOAD, IMPORT');

const [dl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#tabExport'),
]);
let exported = '';
for await (const c of await dl.createReadStream()) exported += c;

await page.reload();
await page.waitForFunction(() => document.getElementById('band') !== null &&
  document.querySelector('#band button') !== null);
await page.evaluate((text) => {
  const f = new File([text], 'w.fathom-journal.json', { type: 'application/json' });
  const dt = new DataTransfer();
  dt.items.add(f);
  const input = document.getElementById('importFile');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, exported);
await page.waitForTimeout(800);

const row2 = await selectDevice(HOST);
check('the device survives the round trip', row2 !== null);
await page.click('[data-dinto]');
await page.waitForTimeout(250);
const pb2 = (await bands())['policy sets'];
check('the policy set survives the round trip',
  pb2.items.some((i) => i.name.trim() === '0  p1'), JSON.stringify(pb2.items));

await page.click('[data-view="inventory"]');
await page.waitForTimeout(200);
await page.click('[data-kind="3"]');
await page.waitForTimeout(200);
const ifaceRow2 = await page.evaluate(() => {
  const tr = [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .find((r) => r.textContent.includes('ge-0/0/0'));
  return tr ? [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()) : null;
});
check('the description survives the round trip',
  ifaceRow2 && ifaceRow2.some((c) => c.includes('WAN uplink')), JSON.stringify(ifaceRow2));

check('no page errors across the whole run', errors.length === 0, errors.join(' | '));

await page.screenshot({
  path: ROOT + '/docs/80-review/evidence/2026-08-28-policies-and-relay-drive.png',
  fullPage: true,
});

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + results.length + ' checks, ' + failed.length + ' failed');
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? '   ' + f.detail : ''));
  process.exit(1);
}
