/* INVARIANT 3 ON THE TABLE PATH, DRIVEN THROUGH THE SHIPPED ARTIFACT AND READ
   BACK OUT OF THE EXPORTED JOURNAL.
   ---------------------------------------------------------------------------
   CLAUDE.md rule 0 twice over.

   (a) A GATE IS TESTED AGAINST WHAT A DEVICE ACCEPTS. Every column name below is
       the vendor's own, read out of `opnsense/core` master on 2026-08-16 —
       `Auth/LDAP.php`'s $confMap gives `ldap_binddn` and `ldap_bindpw`,
       `Auth/Radius.php`'s gives `radius_secret`, and the manual's user page
       gives `otp_seed`. Not one is invented to suit the detector.

       Every VALUE is six characters. That is not a convenience: OPNsense's
       password length constraint is an OPTIONAL policy an administrator turns on
       ("Enable password policy constraints" / "Minimum password length to
       require", docs.opnsense.org/manual/users.html, read 2026-08-16), and
       opnsense/core #2390 records that length was not enforced at login at all
       and asks for SMALLER configurable minimums. So a six-character secret is a
       value a real box really holds — and it is under every content detector's
       floor (24 for base64, 32 for hex, 8 for the mask rule). If one of these
       survives, the column-name coupling is what failed, and nothing else could
       have carried it.

   (b) IT IS READ BACK OUT OF THE EXPORTED JOURNAL, which is the file an operator
       keeps and syncs. Asserting on the DOM would have missed the defect this
       round actually found: a quarantined line whose text was destroyed in the
       capture and kept in the graph fragment. Same pattern as
       `2026-08-15-credential-gate-through-the-export.mjs`.

   WHY A MIS-PASTED FILE IS THE CASE THAT MATTERS. A real rules export carries no
   credential — checked column by column against the exporter, see `64` §1.1 —
   so the gate should cost a real operator nothing, and that is asserted here
   too. But pasting the WRONG OPNsense file into the rules box is a documented
   event, not a hypothesis: opnsense/core #9861 records an operator importing a
   backup configuration into the rules importer and creating ~80,000 rules. */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import fs from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ARTIFACT = process.env.FATHOM_ARTIFACT
  || ('file://' + ROOT + '/target/artifact/fathom-dev.html');

const results = [];
const check = (n, ok, d) => {
  results.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '\n        ' + d : ''));
};

/* The canary values. Short, and each under a column name the vendor writes. */
const SECRETS = {
  'ldap_bindpw   (Auth/LDAP.php $confMap)': 'b1ndpw',
  'radius_secret (Auth/Radius.php $confMap)': 'r4d1us',
  'user_password (a local account)': 'hunt3r',
  'otp_seed      (a plaintext TOTP seed)': 'JBSWY3',
};

/* One mis-paste: a backup-shaped table whose columns are credentials. `enabled`
   is present so the paste binds something and is therefore APPLIED — a paste
   that bound nothing would be refused and would never reach the journal, which
   would make this test pass for the wrong reason. */
const MISPASTE =
  '@uuid;enabled;ldap_bindpw;radius_secret;user_password;otp_seed\n'
  + '8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;1;'
  + [SECRETS['ldap_bindpw   (Auth/LDAP.php $confMap)'],
     SECRETS['radius_secret (Auth/Radius.php $confMap)'],
     SECRETS['user_password (a local account)'],
     SECRETS['otp_seed      (a plaintext TOTP seed)']].join(';')
  + '\n';

/* A row WIDER than its header, which is the blocker this round closed. The
   stray `;` inside a description is the everyday cause — `64` §5 records that
   the export's quoting rule is established nowhere, so any free-text cell can
   do this. Row 2 carries a credential in the overflow position, which before
   the fix reached no detector of any kind and survived with drops = 0. */
const OVERFLOW_SECRET = 'p5kv4l';
const WIDE =
  '@uuid;enabled;sequence;action;interface;description\n'
  + '8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;1;1;pass;lan;Default allow LAN to any\n'
  + '2c772765-4c1e-4c61-9f34-0b7926bbf8db;1;11;block;wan;Reject v6 DNS; see CHG-4471\n'
  + 'd40b7c98-5e33-41aa-b0c7-6a2e1f8d9c07;1;21;pass;lan;note;ipsec_psk;' + OVERFLOW_SECRET + '\n';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const requests = [];
page.on('request', (r) => requests.push(r.url()));

await page.goto(ARTIFACT);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

async function paste(text) {
  await page.click('#tabPaste');
  await page.waitForSelector('#pta', { state: 'visible' });
  await page.fill('#pta', text);
  await page.click('#pRun');
  await page.waitForTimeout(900);
}

/* The rule rows are not on screen until their kind is selected — the inventory
   shows one row set at a time. Reading `document.body.innerText` without this
   asks whether a rule bound and gets told about the Device table instead, which
   is the sort of check that passes for years and proves nothing. */
async function showRules() {
  const btn = page.locator('.strip button:text-is("SecurityPolicy")');
  if (!(await btn.count())) return [];
  await btn.click();
  await page.waitForFunction(
    () => document.querySelectorAll('table.inv:not(.resid) tbody tr').length > 0,
    null, { timeout: 10000 },
  ).catch(() => {});
  // `:not(.resid)` because the residue list is also a `table.inv` — an unscoped
  // selector silently merges the residue rows into the rule count.
  return page.$$eval('table.inv:not(.resid) tbody tr', (trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())));
}

// ---------------------------------------------------------------------------
// 1. The wide row: refused by name, named on the residue list, swept.
// ---------------------------------------------------------------------------
await paste(WIDE);
const body1 = await page.evaluate(() => document.body.innerText);
const rules1 = await showRules();

check('a row wider than its header is refused by width, in the operator\'s words',
  /has \d+ fields where the header names \d+ columns/.test(body1),
  (body1.match(/has \d+ fields where the header names \d+ columns[^\n]*/) || ['not said'])[0]);
check('and it explains the likely cause rather than only the symptom',
  /unquoted `;`|unquoted ;/.test(body1));
check('and it says why guessing would be worse',
  /would say `any` where your file says a network|one column out/.test(body1));
check('the refused row is on the residue list with its own bytes',
  /CHG-4471/.test(body1));
check('a table counts its residue in CELLS, never lines',
  /\d+ cells not read/.test(body1) && !/lines not read/.test(body1),
  (body1.match(/read [^\n]*not read[^\n]*/) || ['no tally'])[0]);
/* EXACTLY ONE rule, and it is the well-formed one. Both other rows are wider
   than the header — row 2 by the stray `;` in its description, row 3 by the two
   trailing cells — so both are refused whole. That is the point of the fixture
   and the point of the fix: the file is not lost because two rows are, and the
   two that are refused assert NOTHING rather than asserting something shifted.

   The negative matters more than the positive here. `note` is row 3's
   description cell; if the old behaviour came back, row 3 would bind with its
   columns one out and `note` would appear as a rule's description. */
check('the one well-formed row bound',
  rules1.length === 1 && rules1[0][1] === 'permit',
  JSON.stringify(rules1));
check('and the two malformed rows asserted nothing at all',
  !rules1.some((r) => r.join('|').includes('note') || r.join('|').includes('CHG-4471')),
  JSON.stringify(rules1));

// ---------------------------------------------------------------------------
// 2. The mis-pasted credential table.
// ---------------------------------------------------------------------------
await paste(MISPASTE);
const body2 = await page.evaluate(() => document.body.innerText);
check('the mis-paste was applied, not refused — so it really reaches the journal',
  /understood/.test(body2));

// ---------------------------------------------------------------------------
// 3. THE EXPORT. Every byte an operator would keep.
// ---------------------------------------------------------------------------
const dl = page.waitForEvent('download');
await page.click('#tabExport');
const saved = '/tmp/claude-0/-home-user-Fathom/6b99fe87-c207-5a7a-a276-aace66402f90/scratchpad/opnsense-export.json';
await (await dl).saveAs(saved);
const stored = fs.readFileSync(saved, 'utf8');
console.log('\nexported journal: ' + stored.length + ' bytes\n');

const screen = await page.evaluate(() => document.body.innerText);
for (const [name, secret] of Object.entries(SECRETS)) {
  check('destroyed at the gate: ' + name,
    !stored.includes(secret),
    stored.includes(secret) ? 'THE SECRET IS IN THE EXPORTED JOURNAL' : '');
  check('  ... and never on screen: ' + name.split('(')[0].trim(),
    !screen.includes(secret));
}
check('the overflow cell\'s credential is destroyed too',
  !stored.includes(OVERFLOW_SECRET),
  stored.includes(OVERFLOW_SECRET)
    ? 'AN OVERFLOW CELL REACHED NO DETECTOR — the blocker is back' : '');
check('the page says it destroyed something', /secret/i.test(screen),
  (screen.match(/\d+ secrets? removed/) || ['(no count found)'])[0]);

// ---------------------------------------------------------------------------
// 4. A REAL export must lose nothing. The other half of rule 0.
// ---------------------------------------------------------------------------
const real = fs.readFileSync(
  ROOT + '/crates/fathom-ingest/tests/fixtures/opnsense-rules-export.csv', 'utf8');
await paste(real);
const body4 = await page.evaluate(() => document.body.innerText);
const rules4 = await showRules();
check('a REAL 50-column export loses nothing at the gate',
  /0 secrets removed/.test(body4),
  (body4.match(/read [^\n]*\n?/) || ['no tally'])[0]);
check('and the operator\'s own sentence survives it, quoted delimiter and all',
  rules4.some((r) => r.join('|').includes('Reject v6 DNS; see change CHG-4471')),
  JSON.stringify(rules4.map((r) => r[5])));

// ---------------------------------------------------------------------------
// 5. #10595 carried to the user: an empty box is not an empty firewall.
// ---------------------------------------------------------------------------
await page.click('#tabPaste');
await page.waitForSelector('#pta', { state: 'visible' });
await page.fill('#pta', '');
await page.click('#pRun');
await page.waitForTimeout(400);
const emptyMsg = (await page.textContent('#pErr')) ?? '';
check('an empty paste names the vendor bug rather than blaming the operator',
  /10595/.test(emptyMsg), emptyMsg.slice(0, 120));
check('  ... and says the firewall is still running the rules',
  /still running them|still enforcing them/.test(emptyMsg));
check('  ... and says where they are', /\/conf\/config\.xml/.test(emptyMsg));

// A header with no records — the same event, the module's half.
await page.fill('#pta', '@uuid;enabled;action\n');
await page.click('#pRun');
await page.waitForTimeout(400);
const headerOnly = (await page.textContent('#pErr')) ?? '';
check('a header with no rules is refused, naming the issue',
  /10595/.test(headerOnly), headerOnly.slice(0, 120));
check('  ... and refuses to let "0 rules" stand as a fact about the firewall',
  /DOES NOT MEAN YOUR FIREWALL HAS NO RULES/.test(headerOnly));

check('exactly one network request — the file itself',
  requests.length === 1, requests.join(', '));
check('no page errors', errs.length === 0, errs.join(' | '));

console.log('\n' + results.filter(Boolean).length + '/' + results.length + ' checks pass');
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
