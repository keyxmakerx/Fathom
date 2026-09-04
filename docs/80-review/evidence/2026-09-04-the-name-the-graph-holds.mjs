// THE NAME THE GRAPH HOLDS IS THE NAME THE OPERATOR SEES — driven in Chromium
// against the shipped artifact, over the documented SRX branch fixture, through
// a real export → reload → import.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-09-04-the-name-the-graph-holds.mjs [repo-root]
//
// WHAT WAS SEEN, 2026-09-04. After pasting
// `crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt`, the
// findings view listed "4 of 4 PolicySet nodes have no scope" and every row
// under it read the ULID twice — as the label and as the id. That LOOKED like
// the 2026-08-10 defect (a bound name shown as a ULID) and on that kind it is
// not: the zone pair a `PolicySet` is keyed on is an ingest dedup key, dropped
// with the fragment; `PolicySet.scope` is a unit struct; no `PolicySet → Zone`
// edge is declared. The graph holds nothing to name it by, so the row that
// says it has no scope and the ULID under it are the same fact stated twice.
//
// The SAME sweep found the real one beside it: `SecurityPolicy.name` is
// `card: "1"`, the dictionary has bound it since 2026-08-28, rung 4 read it
// directly and was fine — and the inspector heading over a policy picked from
// the inventory said `security-policy:01M1…`. `display_name` had no arm.
// Fifteen more kinds were in the same state. The fix asks the generated field
// table for a bound `name`/`label`/`hostname` instead of adding a seventeenth
// arm; this file proves it on the surfaces a person actually reads.
//
// THE CHECK THAT FAILED BEFORE THE FIX is §2: pick each of the four policies in
// the inventory and read the DETAILS heading. Before, all four headings were
// `security-policy:<ulid>`. §3 walks every kind the paste produced and holds
// each heading to the same rule; §4 pins the findings view — named where a
// name exists, the ULID over `PolicySet` deliberately; §5 does the whole thing
// again after a real reload, from the exported journal, because a name that
// is right only until the page is closed is not a name the graph holds.
//
// Playwright and Chromium are the ones already on this machine; neither is a
// dependency of the product and neither is in Cargo.lock (gate zero).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const FIXTURE = readFileSync(
  ROOT + '/crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt', 'utf8');

// `<kind-lower>:<26 Crockford chars>` — the Display form of a node id
// (ADR-0005). A heading that matches this is the fall-through arm firing.
const ULID_FORM = /^[a-z-]+:[0-9A-HJKMNP-TV-Z]{26}$/;
// The four policies the fixture declares (lines 84–104), by the name Junos
// gives each; written once, and every assertion below counts out of it.
const POLICIES = ['guests-to-untrust', 'trust-to-contractors', 'trust-to-untrust', 'trust-to-vpn'];
// `InvKind::ALL`'s index for `SecurityPolicy` — the kind strip's `data-kind`
// is that index (`2026-08-21-inventory-direction-a.mjs` clicks 12 for Chassis
// the same way).
const KIND_SECURITY_POLICY = 14;

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
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const requests = [];
page.on('request', r => requests.push(r.url()));

// ---- helpers that read the DOM, never page internals -------------------------

const heading = () => page.$eval('#idetHead .dname2', n => n.textContent.trim());
const detailsTab = () => page.$eval('#ipaneDetailsTab', n => n.textContent.trim());
// THE FIRST `table.inv` ONLY. After a paste the sheet's residue table — every
// line the dictionary did not bind — is still in the document and is also
// `table.inv`, so an unscoped `table.inv tbody tr` counted 60 rows over four
// policies on the first run of this file. The model driver's `nth-child`
// click already resolves to the first table; the counts have to as well.
const rowCount = () => page.$eval('table.inv', t => t.querySelectorAll('tbody tr').length).catch(() => 0);
const pickRow = i => page.click('table.inv tbody tr:nth-child(' + i + ') button');
const kinds = () => page.$$eval('#kindstrip [data-kind], .kstrip [data-kind], [data-kind]',
  ns => [...new Set(ns.map(n => n.getAttribute('data-kind')))]);

// Every gap group on screen with the NAME and ID of each item under it —
// read out of the rendered list, in document order.
const groups = () => page.evaluate(() => {
  const out = [];
  for (const row of document.querySelectorAll('.gaprow')) {
    const list = row.nextElementSibling;
    out.push({
      n: parseInt(row.querySelector('.n').textContent, 10),
      what: row.querySelector('.what').textContent,
      items: list && list.classList.contains('gapitems')
        ? [...list.querySelectorAll('button')].map(b => ({
            id: b.querySelector('.idw').textContent.trim(),
            name: b.firstChild.textContent.trim(),
          }))
        : [],
    });
  }
  return out;
});

const pasteFixture = async () => {
  await page.click('#tabPaste');
  await page.fill('#pta', FIXTURE);
  await page.click('#pRun');
  await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
  await page.keyboard.press('Escape');
};

// Pick every policy row in turn and read what the inspector calls it.
const policyHeadings = async () => {
  await page.click('#band [data-view="inventory"]');
  await page.waitForSelector('table.inv');
  await page.click('[data-kind="' + KIND_SECURITY_POLICY + '"]');
  await page.waitForFunction(n => {
    const t = document.querySelector('table.inv');
    return !!t && t.querySelectorAll('tbody tr').length === n;
  }, POLICIES.length);
  const got = [];
  for (let i = 1; i <= POLICIES.length; i++) {
    await pickRow(i);
    got.push({ heading: await heading(), tab: await detailsTab() });
  }
  return got;
};

await page.goto(FILE);
await page.waitForFunction(() => !!document.getElementById('band').children.length);

// ---- 1. THE FIXTURE, PASTED ---------------------------------------------------

await pasteFixture();
check('the documented SRX branch fixture pasted and the inventory has rows',
  (await rowCount()) > 0);

// ---- 2. THE CHECK THAT FAILED BEFORE THE FIX ----------------------------------
//
// Four policies, four inspector headings. Before 2026-09-04 every one of them
// was `security-policy:<ulid>` with `trust-to-untrust` bound on the node.

const first = await policyHeadings();
check('the inventory lists exactly the four policies the fixture declares',
  first.length === POLICIES.length, first.length + ' rows');
check('NO policy heading is a ULID (the fall-through arm) — this failed before the fix',
  first.every(h => !ULID_FORM.test(h.heading)),
  JSON.stringify(first.map(h => h.heading)));
check('every heading is a policy name the config actually carries',
  first.map(h => h.heading).sort().join(',') === POLICIES.join(','),
  first.map(h => h.heading).sort().join(','));
check('and the DETAILS tab names the policy in the same words',
  first.every(h => h.tab.indexOf(h.heading) >= 0),
  JSON.stringify(first.map(h => h.tab)));

// ---- 3. EVERY KIND THE PASTE PRODUCED, HELD TO THE SAME RULE -------------------
//
// Nothing here names a kind it expects: it walks the strip, and for each kind
// with rows picks the first and reads the heading. A composed name (`peer
// 203.0.113.1`, `ge-0/0/0.0`) is fine; the Display form of an id is not.

const strip = await kinds();
check('the kind strip is on screen and addressable', strip.length >= 10, strip.length + ' kinds');
const walked = [];
for (const k of strip) {
  await page.click('[data-kind="' + k + '"]');
  const n = await rowCount();
  if (n === 0) continue;
  await pickRow(1);
  walked.push({ kind: k, rows: n, heading: await heading() });
}
check('at least eight kinds carried rows from this paste', walked.length >= 8,
  walked.map(w => w.kind + ':' + w.rows).join(' '));
check('no first-row heading of any kind is a bare ULID',
  walked.every(w => !ULID_FORM.test(w.heading)),
  JSON.stringify(walked.map(w => w.heading)));

// ---- 4. THE FINDINGS VIEW — NAMED WHERE A NAME EXISTS, HONEST WHERE NOT ----------

await page.click('#band [data-view="findings"]');
await page.waitForSelector('.gaprow');
const gs = await groups();
const scope = gs.find(g => /PolicySet nodes have no scope$/.test(g.what));
check('the view still says the four policy sets have no scope (the fact behind the ULID)',
  !!scope && scope.n === 4 && scope.items.length === 4,
  scope ? scope.what + ' / ' + scope.items.length + ' items' : 'no such row');
check('each PolicySet row is its id — deliberately: the zone pair is not in the graph',
  !!scope && scope.items.every(it => it.name === it.id && ULID_FORM.test(it.id)),
  scope ? JSON.stringify(scope.items.map(it => it.name)) : '');
const others = gs.filter(g => !/PolicySet nodes/.test(g.what));
check('every other gap row exists to be checked', others.length >= 1,
  others.map(g => g.what).join(' | '));
check('and no item under any of them is listed by its ULID',
  others.every(g => g.items.every(it => it.name !== it.id && !ULID_FORM.test(it.name))),
  JSON.stringify(others.map(g => g.items.map(it => it.name))));

// ---- 5. THE REAL RELOAD: EXPORT → BLANK → RELOAD → IMPORT → THE SAME NAMES -------
//
// A name that survives only until the tab closes is a name the PAGE holds.
// The exported journal is the file an operator keeps; the names have to come
// back out of it.

const download = await Promise.all([
  page.waitForEvent('download'),
  page.click('#tabExport'),
]).then(r => r[0]);
const saved = await download.path();
await page.keyboard.press('Escape');

await page.goto('about:blank');
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
check('after a reload the estate is gone, as it always was', (await rowCount()) === 0);

await page.setInputFiles('#importFile', saved);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
const again = await policyHeadings();
check('after the round trip the four policies are still headed by their names',
  again.length === POLICIES.length && again.every(h => !ULID_FORM.test(h.heading)) &&
  again.map(h => h.heading).sort().join(',') === POLICIES.join(','),
  JSON.stringify(again.map(h => h.heading)));

// ---- 6. THE INVARIANTS ---------------------------------------------------------

check('one network request, the file itself (invariant 1)',
  requests.filter(u => !u.startsWith('file://')).length === 0,
  requests.length + ' request(s), all file://');
check('no page errors through the whole drive', errors.length === 0, errors.join(' | '));

// The picture is the fixed surface after the round trip: a policy picked from
// the inventory, named in the heading and on the tab.
await page.waitForTimeout(400);
await page.screenshot({ path: ROOT + '/docs/80-review/evidence/2026-09-04-the-name-the-graph-holds.png' });
await browser.close();

const bad = results.filter(r => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
process.exit(bad.length ? 1 : 0);
