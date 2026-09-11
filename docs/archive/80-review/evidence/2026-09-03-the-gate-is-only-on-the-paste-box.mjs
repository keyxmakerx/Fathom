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
import { readFile } from 'node:fs/promises';

const ROOT = process.argv[2] || __r(__d(__f(import.meta.url)), '..', '..', '..');
const ARTIFACT_PATH = process.env.FATHOM_ARTIFACT_PATH || (ROOT + '/target/artifact/fathom-dev.html');
const FILE = process.env.FATHOM_ARTIFACT || ('file://' + ARTIFACT_PATH);

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
/* The warning must be true of BOTH doors. It must still say the paste box
 * destroys keys — that is real and an operator should rely on it — and it must
 * say that a hand-typed value is stored as typed, which is the half that was
 * missing and the half this file exists to prove. */
check('the exported file still credits the paste gate, which really does work',
  /destroys those at the paste box/.test(exported));
check('AND it warns that a hand-typed value is stored exactly as typed',
  /TYPED BY HAND IS STORED EXACTLY AS TYPED/.test(exported),
  'the sentence now covers the door this file walks through');

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

// ---- 5. THE MARK — ADR-0041: the same hole, marked rather than closed -----
//
// Sections 1-3 proved the hole and MUST STILL FAIL exactly as they did
// before this record — the hole is not closed here, it is marked. What this
// section proves is that the value section 2 typed and stored is now
// FLAGGED, in the cell, beside itself, and that nothing about section 2's
// save changed: the value is still there, untouched.

console.log('\n5. THE MARK — ADR-0041 D1-D4, D6');
await page.click('[data-view="inventory"]');
await page.waitForTimeout(250);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('[data-kind]')].find((n) => /^interface$/i.test(n.textContent.trim()));
  if (b) b.click();
});
await page.waitForTimeout(300);

/* Section 2 typed `'ipsec psk ' + PSK` — no `:`/`=` beside the word `psk`,
 * deliberately (that value's whole point, stated where PSK is defined
 * above, is a 19-character secret chosen to defeat `base64ish`'s 24-
 * character floor so section 4 proves the PASTE gate catches it by
 * DICTIONARY PATH, not by shape). ADR-0041's detector has no dictionary and
 * no path — by design (D5: built only from the word-adjacency rule and the
 * three value shapes) — so it correctly declines to guess at a bare `word
 * value` with nothing else to go on; that is the same restraint its own
 * unit tests pin as `looks_like_credential_needs_the_delimiter_not_bare_adjacency`,
 * and pinning it on the shipped page too is what keeps `"replaced the key
 * switch in rack 4"` from lighting up every neighbouring cell.
 *
 * So this drives the ordinary way an engineer ACTUALLY writes one down —
 * `name: value` — re-editing the same cell exactly as section 2 opened it. */
const MARK_VALUE = 'ipsec psk: ' + PSK;
await page.evaluate(() => {
  const tr = [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .find((r) => r.textContent.includes('ge-0/0/0'));
  const b = tr && tr.querySelector('td button[data-icol="2"]');
  if (b) b.focus();
});
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
if (!(await page.$('.invwrap table.inv .iedit'))) {
  await page.keyboard.press('Enter');
}
await page.waitForSelector('.invwrap table.inv .iedit', { timeout: 5000 });
await page.evaluate(() => { document.querySelector('.invwrap table.inv .iedit').value = ''; });
await page.keyboard.type(MARK_VALUE);
await page.keyboard.press('Enter');
await page.waitForTimeout(500);

// Column 2 (description) is where the value went. `cells[i]` for i !== 2 is
// every OTHER cell of the same row — the plainly innocent neighbours.
const markInfo = await page.evaluate(() => {
  const tr = [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .find((r) => r.textContent.includes('ge-0/0/0'));
  if (!tr) return null;
  const cells = [...tr.querySelectorAll('td')];
  const descTd = cells[2];
  const mark = descTd ? descTd.querySelector('.credmark') : null;
  return {
    hasMark: !!mark,
    tag: mark ? mark.tagName : null,
    ariaLabel: mark ? mark.getAttribute('aria-label') : null,
    descCellText: descTd ? descTd.textContent : null,
    neighboursMarked: cells.some((td, i) => i !== 2 && td.querySelector('.credmark') !== null),
    tableMarkCount: document.querySelectorAll('.invwrap table.inv .credmark').length,
  };
});
check('the mark is present beside the marked cell (the description column)',
  markInfo && markInfo.hasMark, JSON.stringify(markInfo));
check('D1: the value still saves — the cell still holds it, nothing was refused or destroyed',
  markInfo && markInfo.descCellText && markInfo.descCellText.includes(PSK));
check('the mark is a real control (a <button>), not a decorative span',
  markInfo && markInfo.tag === 'BUTTON');
check('D6: the wording describes STORAGE, not the value\'s nature',
  markInfo && /stored as typed/i.test(markInfo.ariaLabel || ''), markInfo && markInfo.ariaLabel);
check('a plainly innocent neighbour cell in the SAME row is NOT marked',
  markInfo && !markInfo.neighboursMarked, JSON.stringify(markInfo));
check('only the one credential-looking cell is marked anywhere in the table',
  markInfo && markInfo.tableMarkCount === 1, 'marks found: ' + (markInfo && markInfo.tableMarkCount));

// D4: reached and read BY KEYBOARD — tab to it from the value, then read the
// accessible name off whatever Tab actually landed on. Not hover, not a
// direct .focus() call that would pass even if the mark sat outside tab
// order.
await page.evaluate(() => {
  const tr = [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .find((r) => r.textContent.includes('ge-0/0/0'));
  const valueBtn = tr.querySelectorAll('td')[2].querySelector('button:not(.credmark)');
  if (valueBtn) valueBtn.focus();
});
await page.keyboard.press('Tab');
const tabbed = await page.evaluate(() => ({
  isMark: document.activeElement.classList.contains('credmark'),
  ariaLabel: document.activeElement.getAttribute('aria-label'),
}));
check('pressing Tab from the value reaches the mark next, in the normal tab order',
  tabbed.isMark, JSON.stringify(tabbed));
check('and its accessible name — read purely by keyboard, no hover involved — carries the sentence',
  /stored as typed/i.test(tabbed.ariaLabel || ''), tabbed.ariaLabel);

// D5: one detector, in Rust. A second copy in the page is exactly the drift
// `49` §1 refused for the gate itself, for the same reason. Checked against
// the Rust IDENTIFIER, not against individual dictionary words — this page
// is annotated prose throughout and several already discuss the gate's own
// history in English (`trap-group`, `simple-password` appear as topics of
// conversation, not as a JS array), so a word-level substring check would
// indict a comment for describing the feature it sits beside.
const pageSource = await readFile(ARTIFACT_PATH, 'utf8');
check('D5: the page declares no secret word list of its own (the detector is Rust)',
  !pageSource.includes('SECRET_WORD_LIST') && !pageSource.includes('looksLikeCredential'));

// ---- 6. THE SAME VALUE, RENDERED A SECOND TIME — a skeptic's finding -------
//
// D7 says the hint "travels with the value, not with the view." A proving
// pass found that `renderMeaningFace`'s field table — the DETAILS pane's
// "Fields" section, reached from THIS SAME ROW by the click section 5 just
// made, and reused verbatim by the diagram's own details panel (`dgDetails`
// calls the identical function) — was a second on-screen rendering of the
// exact value section 5 marked, and it carried no mark at all: a colleague
// who opened DETAILS instead of reading the table cell saw the PSK with
// nothing beside it. `FieldRow.hint` / `FACE_FIELD` slot 5 exist to close
// that, and this is driven against the DETAILS pane the click already
// turned to (`ivPaneSet('details', true)` fires on every row selection) —
// not a fresh click sequence invented for this section.

console.log('\n6. THE SAME VALUE, IN THE DETAILS PANE (D7, closing a proving-pass finding)');
const detailInfo = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#ipaneDetails table.kv tbody tr')];
  const row = rows.find((r) => {
    const th = r.querySelector('th');
    return th && th.textContent.trim() === 'description';
  });
  if (!row) return null;
  const td = row.querySelector('td');
  const mark = td ? td.querySelector('.credmark') : null;
  const input = td ? td.querySelector('input.fedit') : null;
  return {
    found: true,
    hasMark: !!mark,
    ariaLabel: mark ? mark.getAttribute('aria-label') : null,
    fieldText: input ? input.value : (td ? td.textContent : null),
  };
});
check('the DETAILS pane\'s Fields section renders (the row selection is live)',
  detailInfo && detailInfo.found, JSON.stringify(detailInfo));
check('and it carries the identical typed value, untouched',
  detailInfo && detailInfo.fieldText && detailInfo.fieldText.includes(PSK),
  JSON.stringify(detailInfo));
check('the SAME field is marked here too — not just in the inventory table cell',
  detailInfo && detailInfo.hasMark, JSON.stringify(detailInfo));
check('and it carries the same D6 wording',
  detailInfo && /stored as typed/i.test(detailInfo.ariaLabel || ''), detailInfo && detailInfo.ariaLabel);

// ---- 7. THE WORD IS VISIBLE ON FOCUS, NOT ONLY ANNOUNCED -------------------
//
// `title` is a native tooltip and shows on mouse hover only, in every
// shipping browser — never on keyboard focus. `55` §1.4 already names this
// exact failure for the diagram's own line marks ("a hover tooltip … is
// mouse-hover-only, the precise failure listed as impossible") and a
// skeptic pointed out the credential mark had the identical gap: a sighted
// keyboard-only reader tabbing to the glyph got a focus ring and nothing
// readable. This checks the real fix — a `content: attr(data-tip)`
// pseudo-element the CSS turns on for `:focus-visible`, not a hover-only
// affordance — by reading the COMPUTED style after a real keyboard focus,
// not by trusting the attribute exists.

console.log('\n7. THE MARK\'S WORD IS VISIBLE ON KEYBOARD FOCUS, NOT ONLY ANNOUNCED');
await page.evaluate(() => {
  const tr = [...document.querySelectorAll('.invwrap table.inv tbody tr')]
    .find((r) => r.textContent.includes('ge-0/0/0'));
  const valueBtn = tr.querySelectorAll('td')[2].querySelector('button:not(.credmark)');
  if (valueBtn) valueBtn.focus();
});
await page.keyboard.press('Tab');
const focusedTip = await page.evaluate(() => {
  const m = document.activeElement;
  if (!m || !m.classList.contains('credmark')) return null;
  const after = window.getComputedStyle(m, '::after');
  return {
    display: after.display,
    content: after.content,
    dataTip: m.getAttribute('data-tip'),
  };
});
check('the mark is still what Tab lands on',
  focusedTip !== null, JSON.stringify(focusedTip));
check('its focus-visible ::after is actually painted (display: block), not hover-only',
  focusedTip && focusedTip.display === 'block', JSON.stringify(focusedTip));
check('and the painted content IS the sentence, read off data-tip — real DOM text, not just an aria-label',
  focusedTip && typeof focusedTip.content === 'string'
    && focusedTip.content.includes('stored as typed')
    && focusedTip.dataTip && /stored as typed/i.test(focusedTip.dataTip),
  JSON.stringify(focusedTip));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' checks pass');
if (passed !== results.length) {
  console.log('\nA FAILING CHECK HERE IS THE FINDING, NOT A BROKEN TEST.');
}
process.exit(passed === results.length ? 0 : 1);
