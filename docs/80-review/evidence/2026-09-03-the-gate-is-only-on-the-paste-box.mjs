/* THE REDACTION GATE RUNS ON THE PASTE BOX AND NOWHERE ELSE.
 *
 *   cargo run --locked -p fathom-artifact
 *   node docs/80-review/evidence/2026-09-03-the-gate-is-only-on-the-paste-box.mjs [repo-root]
 *
 * WHY THIS EXISTS. On 2026-09-03 the owner asked a plain question about the
 * server version — "we are holding those keys now aren't we? because passwords
 * will be stored on the server?" — and was told no, on the strength of `49` §3
 * decision 1: the gate runs in the browser and only post-gate material is ever
 * uploaded. Three adversarial readers then broke that answer three different
 * ways. This drives the strongest of the three through the shipped product,
 * because CLAUDE.md rule 0 says a gate claim is proved against the artifact and
 * read out of the EXPORTED JOURNAL — the file an operator keeps — and not from
 * a code read.
 *
 * THE CLAIM UNDER TEST, in the product's own words. The export sheet tells the
 * operator, today, verbatim:
 *
 *   "Device passwords and pre-shared keys are NOT in it — Fathom destroys those
 *    when a config is pasted, before anything is stored."
 *
 * THE MECHANISM. `fathom_ingest::ingest()` is the only caller of the redaction
 * gate, and `OP_PASTE` is its only caller in turn (`shell.rs:219`). Every other
 * write path — `OP_FIELD_SET`, `OP_EQUIP_ADD`, the cable and port label writes,
 * rack placement — takes raw bytes off the wire and parses them straight into a
 * typed slot. `field_set` does not import `fathom_ingest` at all. So the gate
 * protects the paste box, and the schema's nineteen free-text `notes` and
 * `description` fields are ungated by construction.
 *
 * WHAT THIS DRIVES. A network engineer documents an interface and types a
 * pre-shared key into its `description` cell — the single most ordinary way this
 * happens. The value never goes near the gate, and it is in the export.
 *
 * WRITTEN TO FAIL. Its assertions are what SHOULD be true. Today, section 3
 * fails, and that failure is the finding. When the hole is closed this file
 * turns green without a word of it being rewritten, which is the only kind of
 * regression test worth having for a safety claim.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, resolve as __r } from 'node:path';

const ROOT = process.argv[2] || __r(__d(__f(import.meta.url)), '..', '..', '..');
const FILE = process.env.FATHOM_ARTIFACT || ('file://' + ROOT + '/target/artifact/fathom-dev.html');

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
};

/* A real pre-shared key, in a shape a device would actually take. NOT chosen to
 * suit a detector — rule 0's whole lesson. It is 22 characters of mixed case and
 * digits: long enough to be a real PSK, and deliberately NOT 24+ alphanumerics,
 * so the `base64ish` safety net cannot rescue it and let this file pass while
 * proving nothing. */
const PSK = 'Wg7fPqz2Lm4Rt8Vx1Bn';
const HOST = 'psk-probe-01';

const CONFIG = [
  'set system host-name ' + HOST,
  'set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30',
].join('\n') + '\n';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// ---- 1. AN ESTATE WITH AN INTERFACE IN IT ----------------------------------

console.log('\n1. PASTE A CONFIG SO THERE IS AN INTERFACE TO ANNOTATE');
await page.click('#tabPaste');
await page.waitForFunction(() => document.getElementById('pta') !== null);
await page.fill('#pta', CONFIG);
await page.click('#pRun');
await page.waitForTimeout(600);
await page.keyboard.press('Escape');

await page.click('[data-view="inventory"]');
await page.waitForTimeout(250);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('[data-kind]')].find((n) => /^interface$/i.test(n.textContent.trim()));
  if (b) b.click();
});
await page.waitForTimeout(300);

const row = await page.evaluate(() =>
  [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))
    .find((r) => r[0] && r[0].startsWith('ge-0/0/0')) || null);
check('the pasted interface has an inventory row', row !== null, JSON.stringify(row));

// ---- 2. TYPE A PRE-SHARED KEY INTO ITS DESCRIPTION -------------------------
//
// Column 2 is `description` (INTERFACE_COLUMNS). Two presses: the first selects
// the row, the second opens the editor — the idiom the cell-edit driver pins.

console.log('\n2. AN ENGINEER TYPES A PSK INTO THE DESCRIPTION CELL');
const opened = await page.evaluate(() => {
  const tr = [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .find((r) => r.textContent.includes('ge-0/0/0'));
  if (!tr) return false;
  const b = tr.querySelector('td button[data-icol="2"]');
  if (!b) return false;
  b.focus();
  return b.hasAttribute('data-iedit');
});
check('the description cell offers itself as editable', opened);

await page.keyboard.press('Enter');
await page.waitForTimeout(200);
await page.keyboard.press('Enter');
await page.waitForSelector('.invwrap table.inv .iedit', { timeout: 5000 });
await page.evaluate(() => { document.querySelector('.invwrap table.inv .iedit').value = ''; });
await page.keyboard.type('ipsec psk ' + PSK);
await page.keyboard.press('Enter');
await page.waitForTimeout(500);

const stored = await page.evaluate(() =>
  [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .map((tr) => tr.textContent).join(' | '));
check('the typed value was accepted and stored', stored.includes(PSK),
  'the cell holds it — which is the product working as designed');

// ---- 3. THE EXPORT, AND WHAT IT PROMISES -----------------------------------
//
// THIS IS THE SECTION THAT FAILS TODAY, AND THE FAILURE IS THE FINDING.

console.log('\n3. THE EXPORTED JOURNAL — THE FILE AN OPERATOR KEEPS');
const [dl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#tabExport'),
]);
let exported = '';
for await (const c of await dl.createReadStream()) exported += c;
console.log('   exported journal: ' + exported.length + ' bytes');

const banner = await page.evaluate(() => document.body.innerText);

/* The claim is not on the screen — it is INSIDE the file, as its `warning`
 * field, travelling with it to wherever it is sent. That is worse and it is
 * the point: the exported journal carries both the secret and a sentence
 * saying the secret is not there. */
check('the exported file carries the promise, in its own warning field',
  /pre-shared keys are NOT in it/.test(exported),
  'the claim under test ships inside the artifact it is wrong about');

check('THE PRE-SHARED KEY IS NOT IN THE EXPORTED JOURNAL',
  !exported.includes(PSK),
  exported.includes(PSK)
    ? 'IT IS. A value typed into a description cell never reaches the gate — '
      + 'the gate has exactly one caller and it is OP_PASTE.'
    : '');

// And the same value must not be sitting in the page for a shoulder to read.
check('and it is not rendered anywhere on the page either',
  !banner.includes(PSK),
  banner.includes(PSK) ? 'it is on screen' : '');

// ---- 4. THE CONTROL: THE PASTE PATH STILL WORKS ----------------------------
//
// Without this, a green run above could mean the gate improved OR that nothing
// was tested. This proves the gate is alive on the path it does cover.

console.log('\n4. CONTROL — the gate still destroys a PASTED key');
await page.click('#tabPaste');
await page.waitForFunction(() => document.getElementById('pta') !== null);
await page.fill('#pta', 'set security ike policy p1 pre-shared-key ascii-text ' + PSK + '\n');
await page.click('#pRun');
await page.waitForTimeout(600);
const afterPaste = await page.evaluate(() => document.body.innerText);
check('a PASTED pre-shared key is destroyed at the gate',
  !afterPaste.includes(PSK),
  'the gate works on the path it covers — the hole is that this is the only path');

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' checks pass');
if (passed !== results.length) {
  console.log('\nA FAILING CHECK HERE IS THE FINDING, NOT A BROKEN TEST.');
}
process.exit(passed === results.length ? 0 : 1);
