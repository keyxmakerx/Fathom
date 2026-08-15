// 2026-08-15 — the OPNsense firewall-rules CSV, driven through the shipped
// artifact in a real browser.
//
// Not a unit test in a wrapper. It opens `target/artifact/fathom-dev.html` from
// `file://` with a clean profile, types a realistic Migration-assistant export
// into the paste sheet, presses the button, and then asserts on **the DOM the
// operator would be looking at** — the tally, the residue list, and the rows in
// the SecurityPolicy kind. Every assertion below is a thing an engineer could
// check by eye; the point of the driver is that nobody has to.
//
// Three things it proves that the Rust tests cannot:
//   1. The dictionary sniff happens on the real `OP_PASTE` frame, so the page
//      reads a table as a table without being told.
//   2. The rules reach a face. A parser with no row set is a parser nobody can
//      see the output of, which is how `RoutingProtocol` sat empty for months.
//   3. The page opens with **one** network request — its own file. Invariant 1.
//
// Run: node docs/80-review/evidence/2026-08-15-opnsense-csv-in-the-page.mjs

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const artifact = `file://${root}/target/artifact/fathom-dev.html`;
const csv = readFileSync(
  resolve(root, 'crates/fathom-ingest/tests/fixtures/opnsense-rules-export.csv'),
  'utf8',
);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext();
const page = await context.newPage();

// Invariant 1: count every request the page makes, before anything else runs.
const requests = [];
page.on('request', (r) => requests.push(r.url()));

await page.goto(artifact);
await page.waitForFunction(() => document.querySelector('#band') !== null);

// ---------------------------------------------------------------------------
// 1. Paste the export.
// ---------------------------------------------------------------------------
await page.click('#tabPaste');
await page.waitForSelector('#pta', { state: 'visible' });
await page.fill('#pta', csv);
await page.click('#pRun');
await page.waitForFunction(
  () => document.querySelector('#psheet')?.hasAttribute('hidden') === true,
  null,
  { timeout: 10000 },
);

const err = await page.textContent('#pErr').catch(() => '');
ok('the paste was not refused', !(await page.locator('#pErr').isVisible()), err);

// ---------------------------------------------------------------------------
// 2. The tally — what the module says it understood.
// ---------------------------------------------------------------------------
// The masthead, the folio, the band and the footer all take their words from
// one function, so all four are checked at once. Until 2026-08-15 that function
// returned the literal string `junos-srx`, so an OPNsense export was parsed
// correctly and then labelled as a Juniper box everywhere on the page.
const masthead = (await page.textContent('#mSub')) ?? '';
eq('the masthead names the real platform', masthead.trim(), 'dev artifact · pasted config · opnsense');
const folio = (await page.textContent('#factFolio')) ?? '';
ok('and so does the folio', /opnsense/.test(folio) && !/junos/.test(folio), folio);
const footer = (await page.textContent('#fMsg')) ?? '';
ok('the footer counts what was not read without calling cells lines', !/lines? not read/.test(footer), footer);

// ---------------------------------------------------------------------------
// 3. The rules reached a face.
// ---------------------------------------------------------------------------
const strip = await page.locator('.strip button').allTextContents();
ok('the kind strip offers SecurityPolicy', strip.includes('SecurityPolicy'), strip.join(', '));

await page.click('.strip button:text-is("SecurityPolicy")');
await page.waitForFunction(
  () => document.querySelectorAll('table.inv:not(.resid) tbody tr').length > 0,
  null,
  { timeout: 10000 },
);

// `:not(.resid)` because the residue list is also a `table.inv` — the paste
// tally renders one below the inventory, and an unscoped selector silently
// merged 44 residue rows into the row count.
const headers = await page.locator('table.inv:not(.resid) thead th').allTextContents();
eq(
  'the columns are the six the schema declares plus opinions',
  headers.join('|'),
  'ordinal|action|enabled|any source|any dest|description|opinions',
);

const rows = await page.$$eval('table.inv:not(.resid) tbody tr', (trs) =>
  trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())),
);
eq('four rows, one per record in the file', rows.length, 4);

const byOrdinal = Object.fromEntries(rows.map((r) => [r[0], r]));
eq('rule 1 permits', byOrdinal['1']?.[1], 'permit');
eq('rule 2 denies (OPNsense `block`)', byOrdinal['2']?.[1], 'deny');
eq('rule 4 rejects', byOrdinal['4']?.[1], 'reject');
eq('rule 1 is enabled', byOrdinal['1']?.[2], 'true');
eq('rule 3 is DISABLED, as the file says', byOrdinal['3']?.[2], 'false');
eq('rule 2 matches any source', byOrdinal['2']?.[3], 'true');
eq(
  'rule 1 does not claim to match any source — its source_net is `lan`',
  byOrdinal['1']?.[3],
  '—',
);
eq('rule 1 matches any destination', byOrdinal['1']?.[4], 'true');
eq(
  "the operator's own sentence survived the quoted delimiter",
  byOrdinal['4']?.[5],
  'Reject v6 DNS; see change CHG-4471',
);

// ---------------------------------------------------------------------------
// 4. The residue list — every cell the IR cannot hold, named at its own bytes.
// ---------------------------------------------------------------------------
const residue = (await page.textContent('#ledger')) ?? '';
for (const cell of ['192.168.1.0/24', '3389', 'TCP', 'wan', 'in', '192.168.210.0/24', '53']) {
  ok(`residue names \`${cell}\``, residue.includes(cell));
}
ok(
  'the residue says why, in words',
  /not in the dictionary/.test(residue),
  residue.slice(0, 300),
);

// ---------------------------------------------------------------------------
// 5. Nothing focusable was hidden inside the picture, and nothing leaked.
// ---------------------------------------------------------------------------
eq('exactly one network request — the file itself', requests.length, 1);
ok('and it is the artifact', requests[0] === artifact, requests[0]);

const tree = await page.accessibility.snapshot();
const flat = [];
(function walk(n) {
  if (!n) return;
  flat.push(`${n.role}:${n.name ?? ''}`);
  (n.children ?? []).forEach(walk);
})(tree);
ok(
  'the SecurityPolicy button is in the accessible tree, not only the DOM',
  // Case-insensitive: the strip is `text-transform: uppercase`, and Chromium
  // computes the accessible name from the RENDERED text, so the tree says
  // SECURITYPOLICY. That is a real thing to know about this page, not a
  // convenience — a name assertion here has to match what a screen reader
  // would actually say.
  flat.some((n) => /securitypolicy/i.test(n)),
  flat.filter((n) => /button/.test(n)).slice(0, 12).join(' | '),
);

await page.screenshot({
  path: resolve(here, '2026-08-15-opnsense-rules-in-the-inventory.png'),
  fullPage: false,
});

// ---------------------------------------------------------------------------
// 6. The empty export. Issue #10595's failure mode, in the product.
// ---------------------------------------------------------------------------
await page.click('#tabPaste');
await page.waitForSelector('#pta', { state: 'visible' });
await page.fill('#pta', '@uuid;enabled;action\n');
await page.click('#pRun');
await page.waitForFunction(
  () => document.querySelector('#pErr')?.hasAttribute('hidden') === false,
  null,
  { timeout: 10000 },
);
const empty = (await page.textContent('#pErr')) ?? '';
ok('an empty export is refused by name', /no rules in it/.test(empty), empty);
ok('and it names the vendor issue', /10595/.test(empty), empty);
ok('and it says the estate was not touched', /has not touched your estate/.test(empty), empty);

await page.screenshot({
  path: resolve(here, '2026-08-15-opnsense-empty-export-refused.png'),
  fullPage: false,
});

await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
