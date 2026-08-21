/* A PASTE RECORDS WHAT IT PRODUCED — `49` §19 phase 0, item 3 — driven through
   the shipped artifact, in Chromium, asserting on the DOM.
 *
 *   cargo run --locked -p fathom-artifact
 *   node docs/80-review/evidence/2026-08-21-a-paste-records-what-it-produced.mjs [repo-root]
 *
 * THE DEFECT. A journalled paste stores the redacted TEXT, and opening the file
 * re-runs the parser over it. This parser changes constantly — the Junos
 * dictionary went from 23.8% to 47.5% line coverage in two days this month — so
 * a workspace saved last month reopens as a DIFFERENT estate, with different
 * ids, and nothing says so. `49` §10a: "every hand-drawn link pointing at nodes
 * that no longer exist."
 *
 * WHAT IS REAL HERE AND WHAT IS SYNTHESISED, stated up front, because rule 0's
 * discipline is that a gate is tested against what it must catch and a test that
 * is honest about its construction can still be asking the wrong question.
 *
 *   Real:        both sides of the comparison. The recorded digest and counts
 *                are written by the product's own export. The rebuilt digest and
 *                counts are produced by the product's own parser, from the text
 *                in the file, at import time.
 *   Synthesised: WHY they differ. A month cannot be waited for and the shipped
 *                dictionary cannot be improved from a driver, so the drift is
 *                produced by adding one more bindable statement to the paste's
 *                TEXT in the saved file. The module then genuinely reads that
 *                text, genuinely mints more nodes than the record says, and the
 *                record genuinely no longer matches — which is byte for byte
 *                the situation a dictionary improvement creates: same file in,
 *                different estate out, stale record beside it.
 *
 * The one thing this construction does NOT exercise is a change to the module,
 * so it cannot prove the digest is stable across builds. `fathom-graph`'s
 * `tests/shape.rs` carries that half — write order, tombstones, re-pointed
 * edges at equal counts, and the field-value blind spot pinned on purpose.
 *
 * Playwright and Chromium are the ones already on this machine; neither is a
 * dependency of the product and neither is in Cargo.lock (gate zero).
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

/* THE TREE UNDER TEST IS THE TREE THIS SCRIPT LIVES IN — the worktree lesson of
   2026-08-16, when six drivers were run from a worktree and answered for
   somebody else's bytes. */
const ROOT = process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const SCRATCH = '/tmp/claude-0/-home-user-Fathom/6b99fe87-c207-5a7a-a276-aace66402f90/scratchpad';

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
};

/* A small branch config the shipped dictionary binds. One host name, one
   interface with an address, one zone. */
const CONFIG = [
  'set system host-name srx-drift-01',
  'set interfaces ge-0/0/0 unit 0 family inet address 10.10.0.1/24',
  'set security zones security-zone trust interfaces ge-0/0/0.0',
].join('\n') + '\n';

/* The line the "improved dictionary" learns to bind. It is a statement this
   build ALREADY binds — the point is that the recorded estate was written
   without it, which is what a build that could not read it would have done. It
   is a second interface rather than a second zone membership: the first thing
   tried here was `security-zone untrust interfaces ge-0/0/0.0`, and the STORE
   refused it, correctly, because `ZoneMember`'s in-bound is 1. A driver has to
   drift the estate with something the schema admits, or it is testing the
   cardinality check instead of the thing it came for. */
const LEARNED = 'set interfaces ge-0/0/1 unit 0 family inet address 10.20.0.1/24';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  acceptDownloads: true,
});
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const footer = () => page.$eval('#fMsg', n => n.textContent.trim());
const driftNote = () => page.$eval('.perr.drift[role="alert"]', n => n.innerText).catch(() => null);
const deviceCount = () => page.$$eval('.inv tbody tr', rs => rs.length);

// ---- 1. paste, add something by hand, export ---------------------------------

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.click('#tabPaste');
await page.fill('#pta', CONFIG);
await page.click('#pRun');
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);

const beforeDevices = await deviceCount();
check('a config pastes and builds an estate', beforeDevices > 0, beforeDevices + ' device rows');

/* One hand-added box AFTER the paste, so the file has a step whose fate the
   drift stop decides. Without it this driver could not tell "stopped" from
   "there was nothing left to do". */
await page.click('#tabEquip');
await page.waitForFunction(() => document.querySelector('#eform select') !== null);
await page.fill('#ef6', 'nas-lab-01');
await page.selectOption('#ef7', 'junos-srx');
await page.click('#eRun');
await page.waitForTimeout(400);
const withHand = await deviceCount();
check('and a box added by hand joins it', withHand === beforeDevices + 1,
  beforeDevices + ' -> ' + withHand);

const dl = page.waitForEvent('download');
await page.click('#tabExport');
const saved = SCRATCH + '/drift-journal.json';
await (await dl).saveAs(saved);
const doc = JSON.parse(readFileSync(saved, 'utf8'));

check('the file declares version 3', doc.version === 3, String(doc.version));

const pasteOps = doc.ops.filter(o => o.op === 'paste');
check('the paste entry records what it produced', pasteOps.length === 1 &&
  typeof pasteOps[0].shape === 'string' && pasteOps[0].shape.length === 16,
  JSON.stringify({ shape: pasteOps[0] && pasteOps[0].shape }));
check('as sixteen hex characters, not a ULID and not a count',
  /^[0-9a-f]{16}$/.test(pasteOps[0].shape), pasteOps[0].shape);
check('with the four counts beside it, so a mismatch can be explained',
  ['things', 'connections', 'unread', 'secrets'].every(k => typeof pasteOps[0][k] === 'string'),
  JSON.stringify({ things: pasteOps[0].things, connections: pasteOps[0].connections,
                   unread: pasteOps[0].unread, secrets: pasteOps[0].secrets }));

/* THE DIGEST IS OVER THE PRODUCT AND NEVER OVER THE PASTE. A digest of text is a
   guess-confirmation oracle, and a length oracle was found in this exact area on
   2026-08-21 (`38` §14.9). Two checks: the recorded digest is not a function of
   the stored text (they differ for two texts of the same length is not testable
   here, so the weaker, checkable claim), and no secret-shaped material and no
   byte length of anything appears in the new fields. */
check('the new fields carry no text from the paste',
  !pasteOps[0].shape.includes('srx') &&
  ![pasteOps[0].things, pasteOps[0].connections, pasteOps[0].unread, pasteOps[0].secrets]
    .some(v => /[^0-9]/.test(v)),
  'shape + four decimal counts only');

// ---- 2. reopen it unchanged: no drift ---------------------------------------

await page.goto('about:blank');
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.setInputFiles('#importFile', saved);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);

check('reopening an untouched file replays every step', (await deviceCount()) === withHand,
  (await deviceCount()) + ' of ' + withHand);
check('and says so without a warning', /replayed/.test(await footer()), await footer());
check('and shows no drift note', (await driftNote()) === null);

// ---- 3. the same file, read differently: the drift is REPORTED --------------
// The record stays exactly as the product wrote it; only the text the parser is
// given changes, which is what a dictionary improvement does from the parser's
// side of the boundary.

const drifted = JSON.parse(readFileSync(saved, 'utf8'));
const target = drifted.ops.find(o => o.op === 'paste');
target.text = target.text.replace(/\n?$/, '\n') + LEARNED + '\n';
const driftedPath = SCRATCH + '/drift-journal-reread.json';
writeFileSync(driftedPath, JSON.stringify(drifted, null, 2));

await page.goto('about:blank');
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.setInputFiles('#importFile', driftedPath);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);

const note = await driftNote();
check('THE DIVERGENCE IS REPORTED RATHER THAN SUFFERED', note !== null,
  note ? note.split('\n')[0] : 'NO NOTE — the silent failure is still silent');

if (note) {
  check('the note names the step', /^Step 1 of 2 did not rebuild what you saved\./.test(note),
    note.split('\n')[0]);
  /* "Fingerprint mismatch" is useless to a network engineer. The sentence has to
     carry the numbers he can act on, in the words the tally already uses. */
  check('it says what the config gave then and what it gives now, in numbers',
    /When you saved this, that config gave \d+ things and \d+ connections/.test(note) &&
    /Today the same text gives \d+ things and \d+ connections/.test(note), '');
  check('it uses the tally\'s own words — things, connections, unread',
    /things/.test(note) && /connections/.test(note) && /unread/.test(note), '');
  check('it says the estate on screen is what Fathom reads today',
    /on screen is what Fathom reads today/.test(note), '');
  check('it says the remaining steps were NOT replayed, and why',
    /were NOT replayed/.test(note) && /whatever now happens to hold those ids/.test(note), '');
  check('it says his saved file is untouched and tells him to keep it',
    /Your saved file has not been touched — keep it\./.test(note), '');
  check('it never says "fingerprint", "hash", "digest" or "checksum"',
    !/fingerprint|hash|digest|checksum/i.test(note), '');
  check('and never claims the file is sealed, signed or verified',
    !/tamper|sealed|signed|verified|authentic/i.test(note), '');
}

/* THE STOP IS THE FEATURE, not the message. Ids are minted by walking upward
   from the entry's entropy, so a parser that mints one extra node REASSIGNS
   every id after it to a live element of some other kind. Replaying the hand
   step against a stale id could succeed against the wrong box, and be
   journalled, exported and believed. */
const afterDrift = await deviceCount();
check('the hand step after the drifted paste was NOT replayed',
  afterDrift < withHand, afterDrift + ' rows, against ' + withHand + ' in the saved file');
check('but the paste itself is loaded — today\'s reading is worth having',
  afterDrift > 0, afterDrift + ' rows');
check('the footer points at the note rather than repeating it',
  /does not read the same today/.test(await footer()), await footer());

/* The note must survive a click, because it is the answer to "why is my diagram
   different" and not news for a second. */
await page.click('[data-view="diagram"]');
await page.waitForTimeout(200);
await page.click('[data-view="inventory"]');
await page.waitForTimeout(200);
check('and the note is still there after looking somewhere else',
  (await driftNote()) !== null);

/* 55 — a state only a mouse can see is not a state. */
check('the note is announced, not merely drawn',
  (await page.$$eval('.perr.drift[role="alert"]', ns => ns.length)) === 1);

// ---- 4. an export from the drifted session describes what is on screen -------

const dl2 = page.waitForEvent('download');
await page.click('#tabExport');
const after = SCRATCH + '/drift-journal-after.json';
await (await dl2).saveAs(after);
const doc2 = JSON.parse(readFileSync(after, 'utf8'));
check('exporting after a drift writes only the steps that actually ran',
  doc2.ops.length === 1 && doc2.ops[0].op === 'paste',
  doc2.ops.length + ' ops: ' + doc2.ops.map(o => o.op).join(','));
check('and its recorded shape is today\'s, not the stale one',
  doc2.ops[0].shape !== target.shape,
  doc2.ops[0].shape + ' vs the stale ' + target.shape);

/* And the loop closes: what he exports after being told opens clean. A warning
   that cannot be cleared is a warning he learns to ignore. */
await page.goto('about:blank');
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.setInputFiles('#importFile', after);
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
check('and reopening THAT file is clean — the warning can be cleared',
  (await driftNote()) === null, await footer());

check('no page errors', errors.length === 0, errors.join(' | '));

await page.screenshot({ path: ROOT + '/docs/80-review/evidence/2026-08-21-drift-note.png' });
await browser.close();

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' checks pass');
process.exit(passed === results.length ? 0 : 1);
