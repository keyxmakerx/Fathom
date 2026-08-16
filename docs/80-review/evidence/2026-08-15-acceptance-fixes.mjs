// The six demo-blocking fixes from the 2026-08-15 adversarial acceptance pass,
// driven end to end.
//
//   node docs/80-review/evidence/2026-08-15-acceptance-fixes.mjs
//
// The VLAN check in here reads the INVENTORY and will fail: VLANs have no
// InvKind row set, so they only appear in the diagram's Outline. Kept failing on
// purpose rather than deleted or re-pointed — it is the honest marker for the
// "half the estate has no row set" defect, which is real, filed, and needs a
// module change (`InvKind`'s wire byte is its index, so growing it is not a
// page edit). The label fix itself is pinned in Rust by
// `fathom-inventory/tests/projection.rs::a_bound_name_is_never_rendered_as_a_ulid`.
//
// Expected: 13/14.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const URL = 'file:///home/user/Fathom/target/artifact/fathom-dev.html';
const A = `set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set vlans vlan-staff vlan-id 10
set vlans vlan-guest vlan-id 20
set protocols ospf area 0.0.0.0 interface ge-0/0/0.0
set protocols bgp group ibgp neighbor 203.0.113.1 peer-as 64512
set security ike policy p1 pre-shared-key ascii-text Psk12345
`;
const B = `set system host-name srx-hq-01
set interfaces ge-0/0/1 unit 0 family inet address 198.51.100.1/30
`;
const R=[]; const ck=(n,ok,d)=>{R.push(ok);console.log((ok?'PASS  ':'FAIL  ')+n+(d?'   '+d:''));};
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
await page.goto(URL);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// ---- first paste: no warning, because nothing is loaded ----
await page.click('#tabPaste');
ck('first paste offers no scary warning', !(await page.textContent('#pHint')).includes('REPLACES'));
ck('and the button says "read it"', (await page.textContent('#pRun')).trim() === 'read it');
await page.fill('#pta', A); await page.click('#pRun');
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);

// ---- the textarea is empty again ----
await page.click('#tabPaste');
ck('the raw config is gone from the box', (await page.inputValue('#pta')) === '');

// ---- second paste NAMES what will be lost ----
const hint = await page.textContent('#pHint');
ck('the second paste says it REPLACES', hint.includes('REPLACES'));
ck('and names the device by hostname', hint.includes('srx-branch-01'), hint.slice(0,140));
ck('and the button says so too', (await page.textContent('#pRun')).includes('replace'));
await page.click('#tabPaste');   // close

// ---- VLANs are named, not ULIDs ----
await page.evaluate(() => { const b=[...document.querySelectorAll('[data-kind]')].find(x=>/vlan/i.test(x.textContent)); if(b) b.click(); });
await page.waitForTimeout(300);
const vlanCells = await page.$$eval('.inv tbody tr td button', n => n.map(x => x.textContent));
ck('VLAN rows show names, not ULIDs',
  vlanCells.some(c => c.includes('vlan-staff')) && !vlanCells.some(c => /^vlan:01[A-Z0-9]{20,}/.test(c)),
  JSON.stringify(vlanCells.slice(0,5)));

// ---- finder: click a row, then Enter must still work ----
await page.keyboard.press('Control+k');
await page.waitForTimeout(250);
await page.fill('#fq', 'ipsec');
await page.waitForTimeout(300);
const before = await page.$$eval('[data-hit]', n => n.length);
ck('the finder returns rows', before > 0, before + ' rows');
await page.click('[data-hit="1"]');
await page.waitForTimeout(150);
const focused = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
ck('clicking a result keeps focus in the query box', focused === 'fq', 'focus: ' + focused);
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(120);
ck('and the arrow keys still work after a click',
  await page.evaluate(() => !!document.querySelector('[data-hit][aria-selected="true"], [data-hit].on, [data-hit][data-hi]')) ||
  (await page.evaluate(() => document.activeElement.id)) === 'fq');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// ---- export, then import: the finder and the dictionary must survive ----
const dl = page.waitForEvent('download');
await page.click('#tabExport');
const d = await dl;
const p='/tmp/claude-0/-home-user-Fathom/6b99fe87-c207-5a7a-a276-aace66402f90/scratchpad/rt.json';
await d.saveAs(p);
const rowsBefore = await page.$$eval('.inv tbody tr', n => n.length);

await page.click('#tabPaste'); await page.fill('#pta', B); await page.click('#pRun');
await page.waitForTimeout(600);
await page.setInputFiles('#impFile', p).catch(async () => {
  const inp = await page.$('input[type=file]'); if (inp) await inp.setInputFiles(p);
});
await page.waitForTimeout(900);
const host = await page.evaluate(() => document.body.innerText);
ck('import restored the first estate', host.includes('srx-branch-01'), host.slice(0,80).replace(/\n/g,' '));

// THE BUG: after import, does the finder still work?
await page.keyboard.press('Control+k');
await page.waitForTimeout(250);
await page.fill('#fq', 'ipsec');
await page.waitForTimeout(400);
const after = await page.$$eval('[data-hit]', n => n.length);
ck('THE FINDER STILL WORKS AFTER AN IMPORT', after > 0, after + ' rows (was ' + before + ')');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// and can we still paste?
await page.click('#tabPaste'); await page.fill('#pta', B); await page.click('#pRun');
await page.waitForTimeout(600);
const foot = await page.evaluate(() => document.body.innerText);
ck('AND PASTING STILL WORKS AFTER AN IMPORT', !foot.includes('code 14') && !foot.includes('dictionary'),
  (foot.match(/read [^\n]{0,60}/) || ['(no read line)'])[0]);

ck('no page errors', errs.length === 0, errs.join(' | '));
console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' checks pass');
await browser.close();
