// ADR-0037 driven through the shipped artifact, in Chromium, ASSERTING ON THE
// DOM and on the ACCESSIBLE TREE. The screenshots beside this file are not the
// evidence; these assertions are.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-16-server-role-drive.mjs [repo-root]
//
// The question this file exists to answer is the owner's, and it is half of one
// sentence: *"as long as I could design my network AND SERVERS for my home lab
// as a example that's all that matters."* Before ADR-0037 `Device.role` had five
// variants and none of them was `server`, so every server, NAS, hypervisor and
// wireless access point in a lab was `other` — a taxonomy that collapses half a
// lab into one bucket is not a taxonomy.
//
// **NOTHING IS PASTED HERE.** The whole point is the empty page: this driver
// opens the artifact and builds a small home lab by hand — a firewall, a switch,
// an access point, a NAS host and a hypervisor — the way the owner would. If any
// of it required a config to exist first, the feature would not be the one asked
// for.
//
// Playwright and Chromium are the ones already on this machine; neither is a
// dependency of the product and neither is in Cargo.lock (gate zero).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const OUT = ROOT + '/docs/80-review/evidence';

// The lab. `platform` is junos-srx on every row and that is NOT a modelling
// claim about these boxes — it is the honest state of the gap ADR-0037 §5
// names: `Device.platform` is card 1 and a foreign key into
// `schema/platforms.yaml`, which registers no general-purpose host, so a
// hand-added server must borrow a platform today. Naming it here rather than
// quietly picking one is the difference between a known gap and a hidden one.
const LAB = [
  ['opnsense-fw', 'firewall'],
  ['sw-core-01', 'switch'],
  ['ap-loft', 'access_point'],
  ['truenas-01', 'server'],
  ['proxmox-01', 'server'],
];

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

// Add one box through the real form: open the sheet, fill the inputs, press the
// button. `ef9` is the role field — the ids are built from the schema's own wire
// keys (EQUIP_FIELDS), and 9 is `Device.role`.
async function addBox(hostname, role, want) {
  await page.click('#tabEquip');
  await page.waitForFunction(() => document.querySelector('#eform select') !== null);
  await page.fill('#ef6', hostname);
  await page.selectOption('#ef7', 'junos-srx');
  if (role) await page.selectOption('#ef9', role);
  await page.click('#eRun');
  // Wait on the row count reaching `want`, never on a timeout. A sleep here
  // would turn a refused add into a slow one and the failure would surface
  // several boxes later as a wrong total.
  await page.waitForFunction(
    n => document.querySelectorAll('.inv tbody tr').length === n, want);
}

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// ---- THE DROPDOWN OFFERS THEM ------------------------------------------------
// A role nobody can pick is not a feature. This is the check that would have
// failed the day `server` landed in `schema/` and nowhere else.
await page.click('#tabEquip');
await page.waitForFunction(() => document.querySelector('#eform select') !== null);
const offered = await page.$$eval('#ef9 option', os =>
  os.map(o => o.value).filter(v => v !== ''));
check('the equipment form offers every declared role',
  JSON.stringify(offered) === JSON.stringify(
    ['firewall', 'router', 'switch', 'load_balancer', 'server', 'access_point', 'other']),
  offered.join(', '));
check('`server` is one of them, which is the whole of ADR-0037',
  offered.includes('server'));
check('and `access_point` is too',
  offered.includes('access_point'));
check('`other` still reads last, because it is the escape hatch and not a peer',
  offered[offered.length - 1] === 'other');
await page.click('#tabEquip');

// ---- BUILD THE LAB FROM AN EMPTY PAGE ----------------------------------------
check('the page starts with no estate at all',
  (await page.$$('.inv tbody tr')).length === 0);

for (const [i, [hostname, role]] of LAB.entries()) await addBox(hostname, role, i + 1);

const rows = await page.$$eval('.inv tbody tr', trs =>
  trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())));
check('all five boxes are in the inventory', rows.length === LAB.length,
  rows.length + ' rows');

// The role column. DEVICE_COLUMNS is hostname, platform, os version, role, so
// the role is cell 3 — read by POSITION here on purpose, because the driver is
// asserting what a person sees in that column, not what the module sent.
const byName = Object.fromEntries(rows.map(r => [r[0], r[3]]));
check('the inventory names each one by its role',
  LAB.every(([h, r]) => byName[h] === r),
  JSON.stringify(byName));
check('and NONE of them fell back to `other`',
  !Object.values(byName).includes('other'),
  Object.values(byName).join(', '));

await page.screenshot({ path: OUT + '/2026-08-16-home-lab-inventory.png' });

// ---- THE PICTURE SAYS SO TOO --------------------------------------------------
await page.click('[data-view="diagram"]');
await page.waitForFunction(() => document.querySelector('.dbox') !== null);

const drawn = await page.$$eval('.dbox', gs => gs.map(g => ({
  kind: (g.querySelector('.dkind') || {}).textContent || '',
  name: (g.querySelector('.dname') || {}).textContent || '',
  role: (g.querySelector('.drole') || {}).textContent || '',
})));
const roles = drawn.filter(d => d.role).map(d => d.role).sort();
check('every box in the picture carries its role',
  roles.join(',') === 'access_point,firewall,server,server,switch',
  roles.join(', '));
check('the boxes still say `Device` for their KIND — a role is not a kind',
  drawn.filter(d => d.role).every(d => d.kind === 'Device'),
  drawn.map(d => d.kind).join(', '));
check('a box with no role draws no role label',
  drawn.some(d => !d.role) ? drawn.filter(d => !d.role).every(d => d.role === '') : true,
  drawn.filter(d => !d.role).length + ' boxes have none');

// THE ACCESSIBLE TREE, not the DOM. The <svg> is aria-hidden, so the labels
// above are announced to nobody; the Outline row is the only place a screen
// reader can learn this. Asking Chromium for the accessible tree is the bar
// `2026-08-15-diagram-aggregation-ax.mjs` set after a whole disclosure contract
// was declared on SVG nodes and announced to no one.
const ax = await page.accessibility.snapshot({ interestingOnly: false });
const flat = [];
(function walk(n) { if (!n) return; flat.push(n); (n.children || []).forEach(walk); })(ax);
const treeitems = flat.filter(n => n.role === 'treeitem').map(n => n.name || '');
check('the ACCESSIBLE TREE carries the role, because the <svg> does not',
  treeitems.some(n => /proxmox-01/.test(n) && /server/.test(n)),
  treeitems.filter(n => /proxmox-01/.test(n))[0] || 'not found');
check('and the access point is announced as one',
  treeitems.some(n => /ap-loft/.test(n) && /access_point/.test(n)),
  treeitems.filter(n => /ap-loft/.test(n))[0] || 'not found');
check('the role is read AFTER the kind, never instead of it',
  treeitems.some(n => /Device[^a-z]*server/.test(n.replace(/\s+/g, ' '))),
  treeitems.filter(n => /proxmox-01/.test(n))[0] || 'not found');

await page.screenshot({ path: OUT + '/2026-08-16-home-lab-diagram.png' });

// ---- A ROLE THE TAXONOMY REFUSED ----------------------------------------------
// `nas` is the most likely thing a person types, and ADR-0037 deliberately folds
// it into `server`. The dropdown is a closed list, so the page cannot even offer
// it — which is the refusal working at the earliest possible point rather than
// as an error message after the fact.
check('`nas` is not offered, because a NAS is a server',
  !offered.includes('nas'));
check('nor `pdu`, `camera` or `hypervisor` — see ADR-0037 §4 for each',
  !offered.some(o => ['pdu', 'ups', 'camera', 'printer', 'hypervisor', 'storage']
    .includes(o)),
  offered.join(', '));

// ---- THE RECORD, NOT THE PAINT -------------------------------------------------
// A role you can see is worth nothing if closing the page loses it. `OP_EQUIP_ADD`
// was already journalled with an import arm, so this is a regression check on
// that rather than a new claim — but it is the claim that matters for hand-drawn
// work, where there is no paste that can rebuild what was lost.
const download = await Promise.all([
  page.waitForEvent('download'),
  page.click('#tabExport'),
]).then(r => r[0]);
const saved = await download.path();
const doc = JSON.parse(readFileSync(saved, 'utf8'));
const equipOps = doc.ops.filter(o => o.op === 'equip');
check('the export carries all five hand-added boxes', equipOps.length === LAB.length,
  equipOps.length + ' equip ops of ' + doc.ops.length);
const exported = JSON.stringify(doc);
check('and the role travels in the file, not only in the page',
  LAB.every(([, r]) => exported.includes(r)),
  'server/access_point/firewall/switch all present: ' +
  LAB.map(([, r]) => r + '=' + exported.includes(r)).join(' '));

// A REAL RELOAD. Not a soft reset: the document, the WebAssembly instance and
// every scrap of page state go away, which is the only honest way to ask whether
// the role lives in the record or in a variable.
await page.goto('about:blank');
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
check('after a reload the estate is gone, as it always was',
  (await page.$$('.inv tbody tr')).length === 0);

await page.setInputFiles('#importFile', saved);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
const reopened = await page.$$eval('.inv tbody tr', trs =>
  Object.fromEntries(trs.map(tr => {
    const td = [...tr.querySelectorAll('td')].map(x => x.textContent.trim());
    return [td[0], td[3]];
  })));
check('EVERY ROLE SURVIVED THE EXPORT AND THE IMPORT',
  LAB.every(([h, r]) => reopened[h] === r),
  JSON.stringify(reopened));

await page.click('[data-view="diagram"]');
await page.waitForFunction(() => document.querySelector('.dbox') !== null);
const redrawn = await page.$$eval('.dbox', gs =>
  gs.map(g => (g.querySelector('.drole') || {}).textContent || '').filter(Boolean).sort());
check('and the picture draws them again after the round trip',
  redrawn.join(',') === 'access_point,firewall,server,server,switch',
  redrawn.join(', '));

// ---- the invariants that hold whatever this feature does ---------------------
check('exactly one network request, the file itself, both loads',
  requests.filter(u => u !== 'about:blank').every(u => u === FILE),
  requests.length + ' requests');
check('no page errors', errors.length === 0, errors.join(' | '));

await page.screenshot({ path: OUT + '/2026-08-16-home-lab-reimported.png' });
await browser.close();

const failed = results.filter(r => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks pass');
if (failed.length) {
  console.log('FAILURES:');
  failed.forEach(f => console.log('  ' + f.name + '  ' + (f.detail || '')));
}
process.exit(failed.length ? 1 : 0);
