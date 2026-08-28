// `set security policies from-zone X to-zone Y policy NAME …`, driven in a
// real browser. 2026-08-28.
//
// Unit tests (`crates/fathom-ingest/tests/security_policies.rs`) prove the
// FRAGMENT is right. This file is the other half CLAUDE.md asks for on every
// widening since `66` §7: "the module was correct at both ends and the page
// was what guessed." Nothing here re-proves the fragment; it proves that
// rung 4 (`docs/50-design/57-the-zoom-ladder-and-the-trace.md` §7) actually
// draws a policy set per zone pair, in creation order, from a real paste —
// which is the whole point of the feature: the band was EMPTY before this
// widening (`2026-08-22-inside-the-box.mjs` §4 proves exactly that, on a
// config with no `security policies` lines, and still does — see there).
//
//   node docs/80-review/evidence/2026-08-28-security-policies-drive.mjs [repo-root]
//
// Requires the artifact at target/artifact/fathom-dev.html
// (`cargo run --locked -p fathom-artifact`).

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

// Two zone pairs sharing `trust` as the source — the exact shape the
// composite key exists for (`corpus/dict/junos-srx/security-policies.yaml`'s
// own header comment): a single-zone key would collapse `trust->untrust` and
// `trust->dmz` into one evaluation order. `p1`/`p2` under the same pair, in
// file order that is NOT the order their fields complete in (`p2`'s
// `then permit` is its only bound line, so it both creates and finishes the
// node on the same statement — `ordinal_on_create` still has to fire on the
// first line naming EACH policy, in the order the policies are first named,
// not the order their statements happen to bind their last field).
const HOST = 'pol-drive-01';
const CONFIG = [
  'set system host-name ' + HOST,
  'set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30',
  'set security policies from-zone trust to-zone untrust policy p1 match source-address any',
  'set security policies from-zone trust to-zone untrust policy p1 match destination-address any',
  'set security policies from-zone trust to-zone untrust policy p1 then permit',
  'set security policies from-zone trust to-zone untrust policy p2 match application any',
  'set security policies from-zone trust to-zone untrust policy p2 then permit',
  'set security policies from-zone trust to-zone dmz policy p3 then permit',
].join('\n') + '\n';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const requests = [];
page.on('request', (r) => requests.push(r.url()));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(FILE);
await page.waitForFunction(() => document.getElementById('tabPaste') !== null);

// ---- helpers, copied from `2026-08-22-inside-the-box.mjs` -------------------

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
  await page.fill('#pta', text);
  await page.click('#pRun');
  await page.waitForTimeout(400);
}

// ---- 1. THE PASTE -------------------------------------------------------

console.log('\n1. PASTE AND OPEN THE DOOR');

await paste(CONFIG);

check('exactly one network request (the file itself)', requests.length === 1, requests.join(','));
check('no console or page errors', errors.length === 0, errors.join(' | '));

// The residue table is part of the paste sheet's OWN result view, shown right
// after `OP_PASTE` runs — it is not retained once the paste tab is left and
// reopened (reopening it shows a fresh compose sheet instead), so it has to
// be captured here, before the diagram is even visited.
const pasteResultBody = await page.evaluate(() => document.body.innerText);

const row = await selectDevice(HOST);
check('the device landed as a box on the diagram', row !== null);

await page.click('[data-dinto]');
await page.waitForTimeout(250);
check('rung 4 opened', await page.locator('.dview').getAttribute('data-depth') === 'device');

// ---- 2. THE BAND THAT WAS EMPTY BEFORE THIS WIDENING ----------------------

console.log('\n2. THE POLICY BAND, LIT FOR THE FIRST TIME ON A JUNOS PASTE');

const pb = (await bands())['policy sets'];

check('two policy sets — one per zone pair, not one for the shared zone `trust`',
  pb.heads.length === 2, JSON.stringify(pb.heads));
check('the first set (created first, by p1\'s first line) carries 2 policies',
  pb.heads[0] && pb.heads[0].tok === '2 policies', JSON.stringify(pb.heads));
check('the second set (created by p3\'s line) carries 1 policy',
  pb.heads[1] && pb.heads[1].tok === '1 policy', JSON.stringify(pb.heads));

check('three policies drawn in total', pb.items.length === 3,
  JSON.stringify(pb.items));

// Ordinal is CREATION order within its own set, not global statement order —
// p1 is ordinal 0 in set 1, p2 is ordinal 1 in set 1, p3 is ordinal 0 in its
// OWN set (a fresh PolicySet, not a continuation of the first).
check('p1 is ordinal 0 in its set',
  pb.items[0] && pb.items[0].name.trim() === '0  p1', JSON.stringify(pb.items[0]));
check('p2 is ordinal 1 in the SAME set',
  pb.items[1] && pb.items[1].name.trim() === '1  p2', JSON.stringify(pb.items[1]));
check('p3 is ordinal 0 in its OWN set, not ordinal 2 of the first',
  pb.items[2] && pb.items[2].name.trim() === '0  p3', JSON.stringify(pb.items[2]));

check('every policy carries the schema\'s own `permit` token, no colour verdict',
  pb.items.every((i) => i.tok === 'permit'), JSON.stringify(pb.items.map((i) => i.tok)));

check('the band still says Fathom does not say which one would match',
  pb.empties.some((e) => /does not say which one would match/.test(e)),
  pb.empties.join(' | '));

// ---- 3. WHAT STILL STAYS RESIDUE -------------------------------------------

console.log('\n3. `match application` HAS NOWHERE TO BIND, AND SAYS SO');

check('the bare `match application any` line for p2 is named on the residue list',
  pasteResultBody.includes(
    'set security policies from-zone trust to-zone untrust policy p2 match application any'
  ),
  'residue list');
check('and it is not silently dropped — it is a partial match, named as one',
  /not in the dictionary/.test(pasteResultBody));

await page.screenshot({
  path: ROOT + '/docs/80-review/evidence/2026-08-28-security-policies-drive.png',
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
