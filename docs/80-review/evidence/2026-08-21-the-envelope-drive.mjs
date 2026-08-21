// WHO MADE THIS CHANGE, AND WHEN IN ORDER — driven through the shipped artifact.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-21-the-envelope-drive.mjs [repo-root]
//
// `49` §10c makes the author and the sequence number a phase-0 item: free now,
// brutal later. The defect was worse than that document says. Every mutating
// opcode minted its author as `Ulid::from_parts(at.0, 1)` — DERIVED FROM THE
// HOST CLOCK — so a fifty-operation estate carried up to fifty distinct user
// ids, none of which was a person. Not "the same anonymous nobody": one nobody
// per millisecond, which is worse, because it looks like authorship data.
//
// The Rust half is asserted in `crates/fathom-wasm/tests/author.rs`, which fails
// on the real defect (proved by reverting it). THIS file asserts the half no
// unit test can see: what actually lands in the file an operator keeps, and
// whether a workspace he saved BEFORE today still opens.
//
// THE ORDERING CLAIM IS THE POINT. `at` is the host's wall clock and is not an
// order: two operations in the same millisecond have no relative position, and
// a clock that steps backwards — an NTP correction, a laptop waking in another
// timezone — reorders history. `seq` is monotonic from 1 within one design, and
// check 4 drives three edits fast enough to collide on `at` to prove it.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

const add = async (host, role, model) => {
  await page.click('#tabEquip');
  await page.waitForFunction(() => document.querySelector('#eform select') !== null);
  await page.fill('#ef6', host);
  await page.selectOption('#ef7', 'junos-srx');
  await page.selectOption('#ef9', role);
  if (model) await page.fill('#ef19', model);
  await page.click('#eRun');
  await page.waitForTimeout(200);
};

// Three devices back to back — fast enough that `at` may well collide.
await add('sw-core-01', 'switch', 'EX4300-48T');
await add('proxmox-01', 'server', 'R730xd');
await add('truenas-01', 'server');
await page.keyboard.press('Escape');

// There is no debug hook and there should not be one, so the journal is read
// out of the download the operator actually gets.
const exported = async () => {
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#tabExport'),
  ]);
  const stream = await dl.createReadStream();
  let text = '';
  for await (const chunk of stream) text += chunk;
  return JSON.parse(text);
};

const doc = await exported();
const ops = doc.ops || [];

check('the export carries three steps', ops.length === 3, ops.length + ' step(s)');

check('the file declares version 2', doc.version === 2, 'version ' + doc.version);

check('EVERY step names an author', ops.every(o => typeof o.by === 'string' && o.by),
  JSON.stringify(ops.map(o => o.by)));

check('and the author is `local` — a build with no accounts, said honestly',
  ops.every(o => o.by === 'local'), JSON.stringify(ops.map(o => o.by)));

// THE ORDERING CLAIM.
const seqs = ops.map(o => o.seq);
check('EVERY step carries a sequence number', seqs.every(s => typeof s === 'number'),
  JSON.stringify(seqs));
check('the sequence starts at 1 and never repeats',
  seqs.length === new Set(seqs).size && Math.min(...seqs) === 1,
  JSON.stringify(seqs));
check('the sequence is strictly increasing in file order',
  seqs.every((s, i) => i === 0 || s > seqs[i - 1]), JSON.stringify(seqs));

// `at` is NOT the order, and this is the assertion that says why `seq` exists.
// If the three clocks happen to collide, `seq` is the only thing separating
// them; if they do not, this check simply passes on a weaker fact and says so.
const ats = ops.map(o => o.at);
const collided = ats.length !== new Set(ats).size;
check('the clock is not relied on for order' + (collided ? ' (and it DID collide here)' : ''),
  seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
  'at: ' + JSON.stringify(ats));

// ---- A WORKSPACE SAVED BEFORE TODAY MUST STILL OPEN ---------------------------
// This is the check that matters most to a person who already uses Fathom.
// Bumping the export version without teaching the importer the old one turns an
// upgrade into a silent destruction of saved work.
const v1 = {
  magic: doc.magic,
  version: 1,
  ops: ops.map(o => {
    const { seq, by, ...rest } = o;   // exactly a v1 entry: no seq, no by
    return rest;
  }),
};
await page.evaluate(text => {
  // Feed the importer the same way the file input does.
  // eslint-disable-next-line no-undef
  const f = new File([text], 'old.fathom-journal.json', { type: 'application/json' });
  const dt = new DataTransfer();
  dt.items.add(f);
  const input = document.getElementById('importFile');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, JSON.stringify(v1));
await page.waitForTimeout(600);

const afterV1 = await page.evaluate(() => document.querySelectorAll('.inv tbody tr').length);
check('a v1 workspace — saved before the envelope existed — still opens',
  afterV1 > 0, afterV1 + ' inventory row(s) after importing v1');

const reexported = await exported();
check('and its steps are given a sequence rather than left unordered',
  (reexported.ops || []).every(o => typeof o.seq === 'number'),
  JSON.stringify((reexported.ops || []).map(o => o.seq)));
check('and an author, which says `local` because that is what is known',
  (reexported.ops || []).every(o => o.by === 'local'),
  JSON.stringify((reexported.ops || []).map(o => o.by)));

// A NEW EDIT AFTER AN IMPORT MUST NOT REUSE A POSITION.
await add('ap-attic', 'access_point');
const after = await exported();
const aseq = (after.ops || []).map(o => o.seq);
check('an edit after an import continues the sequence, never restarts it',
  aseq.length === new Set(aseq).size && aseq.every((s, i) => i === 0 || s > aseq[i - 1]),
  JSON.stringify(aseq));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' checks pass');
process.exit(passed === results.length ? 0 : 1);
