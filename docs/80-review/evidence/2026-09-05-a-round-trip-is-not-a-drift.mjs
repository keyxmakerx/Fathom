/* A ROUND TRIP IS NOT A DRIFT — driven through the shipped artifact, in
   Chromium, through a real reload, asserting on the DOM and on the exported
   file.
 *
 *   cargo run --locked -p fathom-artifact
 *   node docs/80-review/evidence/2026-09-05-a-round-trip-is-not-a-drift.mjs [repo-root]
 *
 * THE DEFECT. Paste `junos-srx-branch-documented.txt`, export, reload, import
 * the file — the SAME build — and the page showed the replay-divergence
 * notice: "it now destroys 7 secrets in this config where the saved file
 * recorded 8". Nothing had learned anything. The file holds the REDACTED
 * capture, the replay runs the gate over it again, and the module counted
 * gate EDITS: on redacted text the gate writes each of its own markers over
 * itself (seven), and the eighth edit — `read-only`, collateral behind a
 * synthetic community VALUE that carries the word `community` — fires only on
 * the raw text. `fathom_ingest::redact::DropManifest::destroyed` carries the
 * account. Seen by two skeptics 2026-09-04/05; reproduced on 8481632's parent.
 *
 * WHAT IS REAL AND WHAT IS SYNTHESISED, up front (rule 0):
 *
 *   Real:        section 1 entirely. The product's own paste, its own export,
 *                a real reload, its own import. Nothing in the file is edited.
 *   Synthesised: sections 2 and 3 put a value BACK into the saved file by
 *                hand — the fixture's own PSK into its marker's slot, and a
 *                base64 blob onto a residue line — which is byte for byte what
 *                a file from a build with one detector fewer would hold. The
 *                module then genuinely destroys it on the replay. Section 2 is
 *                the case the old count could not tell from a clean file (both
 *                read 7); section 3 is the case it was BLIND to (7 + 1 = 8,
 *                equal to the paste's own, silence).
 *
 * On the parent commit (0733288) section 1's "no note" check is red, section
 * 2's wording and its clean re-export are red, and section 3's note is absent.
 *
 * Playwright and Chromium are the ones already on this machine; neither is a
 * dependency of the product and neither is in Cargo.lock (gate zero).
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/* THE TREE UNDER TEST IS THE TREE THIS SCRIPT LIVES IN — the worktree lesson of
   2026-08-16 — unless a root is named, which is how the before/after runs are
   made against a parent commit built in its own worktree. */
const ROOT = process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const PREFERRED = '/tmp/claude-0/-home-user-Fathom/e19d71fc-fe02-580a-8983-cb176abd8dca/scratchpad';
const SCRATCH = existsSync(PREFERRED) ? PREFERRED : mkdtempSync(resolve(tmpdir(), 'fathom-round-trip-'));

const FIXTURE = readFileSync(
  ROOT + '/crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt', 'utf8');
/* Line 112's value, quotes included — restoring it reproduces the raw line. */
const PSK_LITERAL = '"$9$EXAMPLEnotARealKey01234"';
if (!FIXTURE.includes(PSK_LITERAL)) { console.error('the fixture no longer carries the PSK this driver leans on'); process.exit(2); }
/* A residue line the parser does not bind, and a value today's gate catches by
   shape (`base64ish`: 24+ of [A-Za-z0-9+/], up to two `=`). */
const RESIDUE_LINE = 'set applications application ssh-alt protocol tcp';
const BLOB = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVg==';

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const footer = () => page.$eval('#fMsg', n => n.textContent.trim());
/* The INVENTORY's rows. The paste sheet's residue and pending-names tables wear
   `.inv` too (with `.resid`), so an unscoped count reads 57 after a paste and
   1 after an import of the same estate — a selector fact, not a product one. */
const rows = () => page.$$eval('.inv:not(.resid) tbody tr', rs => rs.length);
/* Every alert wearing `perr drift`: the drift note and the gate note both do,
   and the gate note adds `gatenote`. Read as a list so "no note" and "exactly
   one, and it is the gate's" are both sayable. */
const notes = () => page.$$eval('.perr.drift[role="alert"]',
  ns => ns.map(n => ({ gate: n.classList.contains('gatenote'), text: n.innerText })));
const tally = () => page.$$eval('.tally li', ls => ls.map(l => l.innerText.replace(/\s+/g, ' ').trim()));

const fresh = async () => {
  await page.goto('about:blank');
  await page.goto(FILE);
  await page.waitForFunction(() => document.querySelector('#band button') !== null);
};
const exportTo = async (path) => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tabExport')]);
  await dl.saveAs(path);
  return JSON.parse(readFileSync(path, 'utf8'));
};
const importFrom = async (path) => {
  await page.setInputFiles('#importFile', path);
  await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0, null, { timeout: 15000 })
    .catch(() => {});
};
const pasteOf = (doc) => doc.ops.find(o => o.op === 'paste');

// ---- 1. the same build, twice — nothing is edited ----------------------------

await fresh();
await page.click('#tabPaste');
await page.waitForFunction(() => document.querySelector('#pta') !== null);
await page.fill('#pta', FIXTURE);
await page.click('#pRun');
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
const pasted = await rows();
check('the branch fixture pastes and builds an estate', pasted > 0, pasted + ' rows');

const t1 = await tally();
check('the tally counts 8 secrets removed at the paste',
  t1.some(s => /^8 secrets removed$/i.test(s)), JSON.stringify(t1));  // `innerText` carries the CSS uppercase

const saved1 = SCRATCH + '/round-trip-1.json';
const doc1 = await exportTo(saved1);
const p1 = pasteOf(doc1);
check('the export records 8 beside the redacted text', p1 && p1.secrets === '8', p1 && p1.secrets);
check('and the text it holds is the REDACTED capture',
  p1 && p1.text.includes('<REDACTED:psk>') && !p1.text.includes(PSK_LITERAL));

await fresh();
await importFrom(saved1);
check('reopening the same build’s own export replays every step',
  /replayed/.test(await footer()) && (await rows()) === pasted, await footer());
const n1 = await notes();
check('and shows NO note — a same-build round trip is not a drift and the gate has learned nothing',
  n1.length === 0, n1.map(n => n.text.slice(0, 160)).join(' | '));

const saved2 = SCRATCH + '/round-trip-2.json';
const doc2 = await exportTo(saved2);
const p2 = pasteOf(doc2);
check('the re-export carries the recorded 8 forward — the replay’s figure is not stamped over it',
  p2 && p2.secrets === '8', p2 && p2.secrets);
check('and the same text, byte for byte', p2 && p2.text === p1.text);
check('and the same number of steps', doc2.ops.length === doc1.ops.length,
  doc1.ops.length + ' -> ' + doc2.ops.length);

// ---- 2. the PSK put back into the saved file: same edit count as clean --------

const leaked = JSON.parse(readFileSync(saved1, 'utf8'));
const lp = pasteOf(leaked);
lp.text = lp.text.replace('<REDACTED:psk>', PSK_LITERAL);
const leakedPath = SCRATCH + '/round-trip-psk-back.json';
writeFileSync(leakedPath, JSON.stringify(leaked, null, 2));

await fresh();
await importFrom(leakedPath);
const n2 = await notes();
check('a saved file holding the PSK in plain text gets the gate note',
  n2.length === 1 && n2[0].gate, JSON.stringify(n2.map(n => n.text.slice(0, 120))));
const gtext = n2.length ? n2[0].text : '';
check('which says how many values it destroyed and that the FILE held them in plain text',
  /destroyed 1 value/.test(gtext) && /plain text/.test(gtext), gtext.slice(0, 220));
check('and it is not a drift note — the estate opened exactly as saved',
  n2.every(n => n.gate) && /replayed/.test(await footer()) && (await rows()) === pasted, await footer());
await page.screenshot({ path: ROOT + '/docs/80-review/evidence/2026-09-05-a-round-trip-is-not-a-drift.png' });

const saved3 = SCRATCH + '/round-trip-3.json';
const doc3 = await exportTo(saved3);
const p3 = pasteOf(doc3);
check('the export from here does NOT carry the PSK — the note’s own instruction is true',
  p3 && !p3.text.includes(PSK_LITERAL) && p3.text.includes('<REDACTED:psk>'));
check('and the record totals what the gate has destroyed from this capture: 8 at the paste + 1 today',
  p3 && p3.secrets === '9', p3 && p3.secrets);

await fresh();
await importFrom(saved3);
const n3 = await notes();
check('and reopening THAT export is clean — the warning can be cleared', n3.length === 0,
  n3.map(n => n.text.slice(0, 120)).join(' | '));

// ---- 3. the blind case: a shape-caught value on a residue line ---------------

const blind = JSON.parse(readFileSync(saved1, 'utf8'));
const bp = pasteOf(blind);
if (!bp.text.includes(RESIDUE_LINE)) { console.error('the residue line this driver leans on moved'); process.exit(2); }
bp.text = bp.text.replace(RESIDUE_LINE, RESIDUE_LINE + ' ' + BLOB);
const blindPath = SCRATCH + '/round-trip-blob.json';
writeFileSync(blindPath, JSON.stringify(blind, null, 2));

await fresh();
await importFrom(blindPath);
const n4 = await notes();
check('a value on a residue line that today’s gate catches gets the note too — where the old count came out equal and said nothing',
  n4.length === 1 && n4[0].gate && /destroyed 1 value/.test(n4[0].text),
  JSON.stringify(n4.map(n => n.text.slice(0, 120))));
check('with the estate opened as saved', /replayed/.test(await footer()) && (await rows()) === pasted);
const saved4 = SCRATCH + '/round-trip-4.json';
const p4 = pasteOf(await exportTo(saved4));
check('and the blob is gone from the export', p4 && !p4.text.includes(BLOB));

// ---- 4. ----------------------------------------------------------------------

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' checks pass');
process.exit(passed === results.length ? 0 : 1);
