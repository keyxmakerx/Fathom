// A SERVER IS NOT A JUNIPER FIREWALL — driven in Chromium against the shipped artifact.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-09-04-a-server-is-not-a-juniper-firewall.mjs [repo-root]
//
// Seen in Chromium, 2026-09-04: the add-equipment form demanded a platform,
// the dropdown offered only network operating systems, so a VMware or Linux
// host had to borrow `junos-srx` and then showed as a Juniper firewall in the
// inventory. The owner will demo this estate to his employer, and anyone who
// knows it spots that on the first screen (`70` §19.5, §20.4).
//
// The decided design is RECOMMENDATIONS-2026-09-04 §15 (D1): keep
// `Device.platform` at `card: "1"` — no schema change — and let the FORM submit
// with it blank. The graph already has a state for that (UNKNOWN, `11` §9.1's
// "a hole, never a refusal"); the inventory renders it `—`; the findings view's
// existing gaps walk (card 1 + Unknown) lists it as work.
//
// AND THE TRAP THE SKEPTIC FOUND, which this file exists to prove closed: with
// the platform Unknown, a later paste of that box's real config matched nothing
// term by term and SILENTLY welded a second box — under a page hint that
// promised "a config naming a device you already have will ask before it adds
// a second one". The identity rule now treats a required field nobody has
// filled in as a question, not a mismatch, so the paste ASKS through the
// ERR_PASTE_CHOICE path that already existed. The hint's words did not change;
// the behaviour they describe did.
//
// RUN AGAINST THE BUILD BEFORE THIS CHANGE (HEAD, assembled in a detached
// worktree), NINE CHECKS FAIL AND THEN THE FILE TIMES OUT. Not the failures the
// first cut of this header predicted: the old form did not refuse a blank, it
// never OFFERED one — the select opened on `junos-srx` — so the add went through
// with the borrowed platform, which is the defect itself. Red on that build: the
// blank option, the required mark, the hint (§1); `junos-srx` in the cell (§2);
// all three findings checks (§3); the "never filled in" sentence (§4 — the old
// build asked "the same hostname and platform", because it had borrowed one);
// the drawn box's platform (§6); and the blank commit in §7 never returns,
// because the page refused it with "clear is not built yet". The silent second
// box — door open, rule not yet caught up — cannot be driven on either build,
// so it is pinned in Rust: `paste.rs`'s
// `a_platform_less_hand_added_box_with_the_pasted_hostname_asks` fails with the
// wildcard branch neutered, and was checked by neutering it.
//
// The estate: one box added by hand with no platform, whose hostname is the
// one the documented SRX branch fixture carries — read out of the fixture,
// never typed here, so the two cannot drift apart.
//
// REPAIRED 2026-09-05, THE SAME DAY. A skeptic attacked the clear that
// 1e0465a shipped and found it bypassed the gates a SET runs, because the only
// place `is_authorable` was enforced (`parse_into_slot`) never saw an empty
// value. §7b, §7c and §8b below are the checks: 46/46 here, 32/46 on an
// artifact built from 1e0465a in a detached worktree — and the file now runs
// to its count on that build instead of timing out, because a refusal that
// does not come is read as '' rather than waited for:
//   §7b  blanking the HOSTNAME cell — the one field the add door demands —
//        was accepted ("cleared — now unset"), leaving a box the door would
//        have refused, and a hostname-less junos-srx box makes EVERY junos-srx
//        paste ask "this may be that box". Now refused, naming the field.
//   §7c  the details-pane editor (`commitField`) sends the same blank and was
//        never driven; its three answers are driven here, and the floor too.
//        (On 1e0465a its three answers fail only as a CASCADE of §7b — the
//        cleared hostname leaves the pane on a nameless box — not because
//        that build's pane clear was broken; the floor check is its own red.)
//   §8b  a hand-edited journal carrying a `field` op with an EMPTY value on
//        `SecurityPolicy.action` — a key nothing in the product can type —
//        replayed ("opened a workspace — N steps replayed") and blanked what
//        the parser set, where the same op WITH a value was refused. The
//        journal is the file an operator keeps; ADR-0038's rule is that a
//        tampered record is refused, never guessed through. Modelled on
//        `2026-08-29-cabling-drive.mjs` §10.
// Field keys are read out of `schema/field-keys.yaml`, never typed here.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const OUT = ROOT + '/docs/80-review/evidence';
const FIXTURE = readFileSync(
  ROOT + '/crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt', 'utf8');
const HOST = (/^set system host-name (\S+)/m.exec(FIXTURE) || [])[1];
if (!HOST) { console.error('the fixture carries no host-name line'); process.exit(2); }
// `Kind.field: N` lines of the registry — the same table the module's wire keys
// come from, so a key here cannot be a number somebody remembered.
const KEYS = {};
for (const m of readFileSync(ROOT + '/schema/field-keys.yaml', 'utf8').matchAll(/^\s+([A-Za-z]+\.[a-z_]+):\s*(\d+)\s*$/gm)) KEYS[m[1]] = parseInt(m[2], 10);
const KEY = name => { if (!(name in KEYS)) throw new Error('no key for ' + name); return KEYS[name]; };

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
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const requests = [];
page.on('request', r => requests.push(r.url()));

// ---- helpers that read the DOM, never page internals -------------------------

// THE ROW SET IS THE FIRST `table.inv` UNDER `.invwrap`, AND ONLY THAT ONE.
// After a paste the inventory view also carries the residue table ("what you
// pasted, and why it was not read") and the pending-references table, both
// class `inv`, and the paste sheet keeps its own copies in the DOM while
// hidden. A bare `table.inv tbody tr` counted 58 rows over a two-device estate
// on this file's first run — 2 devices and 56 residue lines — which is exactly
// the kind of count that passes for the wrong reason.
const ROWSET = '.invwrap table.inv';
// The inventory, on one row set — picked BY LABEL from the kind strip, never
// by position.
const inventoryOf = async label => {
  await page.click('[data-view="inventory"]');
  await page.waitForSelector(ROWSET);
  await page.evaluate(label => {
    const strip = [...document.querySelectorAll('#factBody .strip [data-kind]')]
      .find(n => n.textContent.trim() === label);
    if (strip) strip.click();
  }, label);
  await page.waitForTimeout(150);
};
const inventory = () => inventoryOf('Device');
const footer = () => page.$eval('#fMsg', n => n.textContent);
// The refusal the cell editor shows, or '' when none came within a moment —
// so a build that ACCEPTS what should be refused fails the check instead of
// hanging the file on a selector that never appears.
const cellErr = async () => {
  try {
    await page.waitForSelector(ROWSET + ' .cellerr', { timeout: 1500 });
    return await page.textContent(ROWSET + ' .cellerr');
  } catch (e) { return ''; }
};
// The details pane's own editor for one field, by the field's name — the
// SECOND surface that writes a field (`commitField`). Unset fields sit behind
// a <details> that states its own count, opened here as the direction-a
// driver opens it. Returns the footer sentence after Enter.
const paneCommit = async (field, text) => {
  await page.evaluate(() => {
    const d = document.querySelector('#ipaneDetails details.unsetfields');
    if (d && !d.open) d.open = true;
  });
  const inp = await page.$('#ipaneDetails .fedit[aria-label="' + field + '"]');
  if (!inp) return null;
  // A short timeout, and null rather than a throw: on a build where the
  // previous step left the pane on something else (1e0465a, after it cleared
  // the hostname), the check must FAIL, not hang the file.
  try { await inp.fill(text, { timeout: 2000 }); } catch (e) { return null; }
  await inp.press('Enter');
  await page.waitForTimeout(250);
  return footer();
};
const headers = () => page.$eval(ROWSET, t =>
  [...t.querySelectorAll('thead th')].map(n => n.textContent.trim()));
const colIndex = async label => {
  const i = (await headers()).indexOf(label);
  if (i < 0) throw new Error('no `' + label + '` column in ' + JSON.stringify(await headers()));
  return i;
};
// Every device row: its id, and its cells by column label.
const deviceRows = async () => {
  const hs = await headers();
  return page.$eval(ROWSET, (t, hs) => [...t.querySelectorAll('tbody tr')].map(tr => {
    const tds = [...tr.querySelectorAll('td')];
    const first = tds[0] && tds[0].querySelector('button');
    const row = { id: first ? first.getAttribute('data-post') : null };
    hs.forEach((h, i) => { row[h] = tds[i] ? tds[i].textContent.trim() : undefined; });
    return row;
  }), hs);
};
// Open the editor on one cell, exactly as a person does it: the first press
// selects the row, the second edits the cell (2026-08-22's idiom) — and on a
// row that is ALREADY selected the first press is the edit, so the second
// press is made only when the editor did not open. This file's first cut
// pressed twice unconditionally and timed out on its second clear, waiting
// for a button the editor had already replaced.
const editCell = async (id, col, text) => {
  const sel = ROWSET + ' td button[data-post="' + id + '"][data-icol="' + col + '"]';
  await page.click(sel);
  await page.waitForTimeout(200);
  if (!(await page.$(ROWSET + ' .iedit'))) await page.click(sel);
  await page.waitForSelector(ROWSET + ' .iedit');
  await page.fill(ROWSET + ' .iedit', text);
  await page.keyboard.press('Enter');
};
const editorGone = () => page.waitForFunction(sel =>
  document.querySelector(sel + ' .iedit') === null, ROWSET);
// Every gap group on the findings view, in document order.
const groups = async () => {
  await page.click('[data-view="findings"]');
  await page.waitForTimeout(150);
  return page.evaluate(() => [...document.querySelectorAll('.gaprow')].map(row => {
    const list = row.nextElementSibling;
    return {
      n: parseInt(row.querySelector('.n').textContent, 10),
      what: row.querySelector('.what').textContent,
      mark: row.querySelector('.mark') ? row.querySelector('.mark').textContent : '',
      ids: list && list.classList.contains('gapitems')
        ? [...list.querySelectorAll('button')].map(b => b.getAttribute('data-post')) : [],
    };
  }));
};
const platformGap = async () => (await groups()).find(g => /Device nodes ha(s|ve) no platform$/.test(g.what));
const question = () => page.evaluate(() => {
  const n = document.querySelector('#pErr');
  return n && !n.hidden ? n.innerText : '';
});

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// ---- 1. THE DOOR: the form no longer demands a platform ----------------------
await page.click('#tabEquip');
await page.waitForFunction(() => document.querySelector('#eform select') !== null);
const firstOption = await page.$eval('#ef7 option:first-child', o => o.value);
check('the platform select offers a BLANK first, not a Juniper firewall',
  firstOption === '', JSON.stringify(firstOption));
check('and the platform label carries no "required" mark',
  (await page.$$('label[for="ef7"] .req')).length === 0);
check('while hostname is still marked required',
  (await page.$$('label[for="ef6"] .req')).length === 1);
check('the hint beside the field says what a blank means',
  /leave it blank/i.test(await page.$eval('#ef7', n => n.parentElement.textContent)),
  (await page.$eval('#ef7', n => n.parentElement.querySelector('.note').textContent)).slice(0, 80));

await page.fill('#ef6', HOST);
await page.selectOption('#ef9', 'server');
// #ef7 is left exactly as the sheet opened it: blank.
await page.click('#eRun');
await page.waitForTimeout(400);
check('ADDING A SERVER WITH NO PLATFORM IS ACCEPTED (the door refused it before)',
  await page.$eval('#esheet', n => n.hidden) &&
  (await page.$eval(ROWSET, t => t.querySelectorAll('tbody tr').length)) === 1,
  'sheet hidden: ' + await page.$eval('#esheet', n => n.hidden) +
  ', error: ' + JSON.stringify(await page.$eval('#eErr', n => n.hidden ? '' : n.textContent)));

// ---- 2. THE INVENTORY says "—", not junos-srx ---------------------------------
await inventory();
const platCol = await colIndex('platform');
const roleCol = await colIndex('role');
let rows = await deviceRows();
const drawn = rows.find(r => r.hostname === HOST);
check('one device row, named as typed', rows.length === 1 && !!drawn,
  JSON.stringify(rows.map(r => r.hostname)));
check('its platform reads as UNSET — "—" — not as a borrowed junos-srx',
  drawn && drawn.platform === '—', drawn && drawn.platform);
check('and its role reads server', drawn && drawn.role === 'server', drawn && drawn.role);
check('the platform cell can be typed into later',
  await page.$eval(ROWSET + ' td button[data-post="' + drawn.id + '"][data-icol="' + platCol + '"]',
    b => b.hasAttribute('data-iedit')));
const drawnId = drawn.id;

// ---- 3. THE FINDINGS VIEW lists the gap, and lists it as work ----------------
let gap = await platformGap();
check('findings lists "1 of 1 Device nodes has no platform"',
  gap && gap.n === 1 && gap.what === '1 of 1 Device nodes has no platform',
  gap ? gap.what : 'no such group');
check('and does not mark it "cannot be typed in yet" — it can', gap && gap.mark === '', gap && gap.mark);
check('and names the box under it', gap && gap.ids.includes(drawnId), gap && JSON.stringify(gap.ids));

// ---- 4. THE PASTE ASKS instead of welding a second box -----------------------
await page.click('#tabPaste');
await page.waitForFunction(() => document.querySelector('#pta') !== null);
const hint = await page.$eval('#pHint', n => n.textContent);
await page.fill('#pta', FIXTURE);
await page.click('#pRun');
await page.waitForTimeout(600);
const asked = await question();
check('PASTING THE BOX\'S REAL CONFIG ASKS (it welded a second box silently before)',
  /already in this design/i.test(asked), asked.slice(0, 100).replace(/\n/g, ' '));
check('the question names the box', asked.includes(HOST));
check('and says which term matched and which was never filled in',
  /the same hostname, and its platform was never filled in/.test(asked),
  asked.slice(0, 160).replace(/\n/g, ' '));
check('and says why it will not guess', /will not merge|estate of record/i.test(asked));
const buttons = await page.$$eval('#pErr button', ns => ns.map(n => n.textContent.trim()));
check('exactly ONE answer is offered, and it is "different boxes"',
  buttons.length === 1 && /different boxes/i.test(buttons[0]), JSON.stringify(buttons));
await page.screenshot({ path: OUT + '/2026-09-04-a-server-is-not-a-juniper-firewall.png' });

await page.keyboard.press('Escape');
await inventory();
rows = await deviceRows();
check('THE REFUSED PASTE WROTE NOTHING — still one device', rows.length === 1,
  rows.length + ' row(s)');

// ---- 5. THE HINT SENTENCE IS TRUE, and §4 is the demonstration --------------
check('the paste hint still promises a question before a second box',
  /will ask before it adds a second one/.test(hint), hint.slice(0, 200));
check('and the promise was kept for a box with no platform',
  /already in this design/i.test(asked) && rows.length === 1);

// ---- 6. ANSWERING "different boxes" still adds one --------------------------
await page.click('#tabPaste');
await page.waitForTimeout(150);
await page.click('#pErr button[data-pdup]');
await page.waitForTimeout(800);
await page.keyboard.press('Escape');
await inventory();
rows = await deviceRows();
const same = rows.filter(r => r.hostname === HOST);
check('answering "different boxes" adds the second device', rows.length === 2, rows.length + ' rows');
check('both carry the hostname; the drawn one is still unset and the pasted one is junos-srx',
  same.length === 2 &&
  same.some(r => r.id === drawnId && r.platform === '—') &&
  same.some(r => r.id !== drawnId && r.platform === 'junos-srx'),
  JSON.stringify(same.map(r => [r.id === drawnId ? 'drawn' : 'pasted', r.platform])));

// ---- 7. FILL THE PLATFORM IN, THEN CLEAR IT AGAIN ----------------------------
await editCell(drawnId, platCol, 'junos-srx');
await editorGone();
rows = await deviceRows();
check('typing a platform into the cell stores it',
  rows.find(r => r.id === drawnId).platform === 'junos-srx',
  rows.find(r => r.id === drawnId).platform);
check('and the findings gap goes', !(await platformGap()));

await inventory();
await editCell(drawnId, platCol, '');
await editorGone();
rows = await deviceRows();
check('A BLANK COMMIT CLEARS IT (this was "clear is not built yet" before)',
  rows.find(r => r.id === drawnId).platform === '—',
  rows.find(r => r.id === drawnId).platform);
gap = await platformGap();
check('and the gap is back', gap && gap.n === 1 && gap.ids.includes(drawnId), gap ? gap.what : 'none');

// Clearing what is already clear records no claim: the module refuses in its
// own words, in the cell, and the cell keeps reading unset.
await inventory();
await editCell(drawnId, platCol, '');
await page.waitForSelector(ROWSET + ' .cellerr');
check('clearing an already-empty cell is refused rather than journalled',
  /nothing to clear/.test(await page.textContent(ROWSET + ' .cellerr')),
  await page.textContent(ROWSET + ' .cellerr'));
await page.keyboard.press('Escape');
await editorGone();

// ---- 7b. THE FLOOR: what the door demands cannot be cleared ------------------
// On 1e0465a this blank is ACCEPTED: the cell reads "—", the footer says
// "cleared — now unset", and the estate holds a box with neither hostname nor
// platform — one the add door would have refused.
await inventory();
const hostCol = await colIndex('hostname');
await editCell(drawnId, hostCol, '');
const floorErr = await cellErr();
check('BLANKING THE HOSTNAME IS REFUSED, and the refusal names the field and the way out',
  /needs a hostname/.test(floorErr) && /instead of clearing/.test(floorErr),
  floorErr || ('no refusal; footer: ' + await footer()));
await page.screenshot({ path: OUT + '/2026-09-05-what-the-door-demands-cannot-be-cleared.png' });
await page.keyboard.press('Escape');
await editorGone();
rows = await deviceRows();
check('and the cell still holds the name',
  rows.find(r => r.id === drawnId).hostname === HOST, rows.find(r => r.id === drawnId).hostname);

// ---- 7c. THE SAME THREE ANSWERS THROUGH THE DETAILS PANE --------------------
// `commitField` is the second editor that sends a blank, and 1e0465a drove
// only the cell. The row is still selected from 7b, so the pane is on it.
await page.click('#ipaneDetails [data-face="meaning"]').catch(() => {});
check('the details pane is on the drawn box', await page.$eval('#ipaneDetails', (n, host) => n.textContent.includes(host), HOST));
check('pane: typing a platform says "changed"',
  await paneCommit('platform', 'junos-srx') === 'changed', await footer());
check('pane: a blank says "cleared — now unset"',
  await paneCommit('platform', '') === 'cleared — now unset', await footer());
check('pane: a second blank is refused with "nothing to clear"',
  /nothing to clear/.test(await paneCommit('platform', '') || ''), await footer());
const paneFloor = await paneCommit('hostname', '');
check('pane: BLANKING THE HOSTNAME IS REFUSED with the same sentence the cell got',
  /needs a hostname/.test(paneFloor || '') && /instead of clearing/.test(paneFloor || ''), paneFloor);
rows = await deviceRows();
check('and the name is still in the table',
  rows.find(r => r.id === drawnId).hostname === HOST, rows.find(r => r.id === drawnId).hostname);

// ---- 8. EXPORT → RELOAD → IMPORT replays all of it -------------------------
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tabExport')]);
let exported = '';
for await (const c of await dl.createReadStream()) exported += c;
const journal = JSON.parse(exported);
const fieldOps = (journal.ops || journal.journal || journal).filter
  ? (journal.ops || journal.journal || journal).filter(o => o.op === 'field')
  : [];
check('the journal holds the two fills and the two clears as four field ops, the clears with an empty value',
  fieldOps.length === 4 && JSON.stringify(fieldOps.map(o => o.value)) === '["junos-srx","","junos-srx",""]',
  JSON.stringify(fieldOps.map(o => o.value)));
check('and the two refused hostname blanks left NO op — every field op names the platform key',
  fieldOps.every(o => o.key === KEY('Device.platform')),
  JSON.stringify(fieldOps.map(o => o.key)) + ' vs platform ' + KEY('Device.platform'));
await page.reload();
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.evaluate(text => {
  const f = new File([text], 'w.fathom-journal.json', { type: 'application/json' });
  const dt = new DataTransfer();
  dt.items.add(f);
  const input = document.getElementById('importFile');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, exported);
await page.waitForTimeout(1200);
await inventory();
rows = await deviceRows();
const back = rows.filter(r => r.hostname === HOST);
check('reopened: two devices, the drawn one unset again (the clear replayed), the pasted one junos-srx',
  rows.length === 2 && back.length === 2 &&
  back.some(r => r.platform === '—') && back.some(r => r.platform === 'junos-srx'),
  JSON.stringify(back.map(r => r.platform)));
check('and no duplicate question is standing after the import', !/already in this design/.test(await question()));
gap = await platformGap();
check('and findings lists the one gap again', gap && gap.n === 1, gap ? gap.what : 'none');

// ---- 8b. A HAND-EDITED JOURNAL CLEARING WHAT NOTHING CAN TYPE IS REFUSED -----
// The op appended here is exactly the record a `field` op takes, with the one
// value no editor in the product can produce for this key: an empty one on
// `SecurityPolicy.action`, which the parser set from `then permit` and which
// `author.rs` has no parser for. On 1e0465a it replays — the footer reads
// "opened a workspace — N steps replayed", findings reports a policy with no
// action, and nothing can refill it. Here the whole import is refused by
// step and by sentence, and the estate is left empty rather than half-built.
await inventoryOf('SecurityPolicy');
const policyId = await page.$eval(ROWSET, t => {
  const b = t.querySelector('tbody tr td button[data-post]');
  return b ? b.getAttribute('data-post') : null;
});
check('setup: the reopened estate has a security policy to tamper with', !!policyId, policyId);
const tampered = JSON.parse(exported);
tampered.ops.push({
  seq: tampered.ops.length + 1, by: 'local', op: 'field', at: Date.now(),
  ent: randomBytes(16).toString('base64'),
  id: policyId, key: KEY('SecurityPolicy.action'), value: '',
});
const tamperedPath = join(tmpdir(), 'fathom-clear-tamper-' + process.pid + '.json');
const honestPath = join(tmpdir(), 'fathom-clear-honest-' + process.pid + '.json');
writeFileSync(tamperedPath, JSON.stringify(tampered));
writeFileSync(honestPath, exported);
await page.goto('about:blank');
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.setInputFiles('#importFile', tamperedPath);
await page.waitForTimeout(1500);
const verdict = await footer();
check('THE TAMPERED IMPORT IS REFUSED — by step, in the sentence a typed value gets, and nothing is opened',
  new RegExp('step ' + tampered.ops.length + ' of ' + tampered.ops.length + ' was refused').test(verdict) &&
  /cannot be typed in yet/.test(verdict) && /nothing was opened/.test(verdict),
  verdict);
check('and it left no estate at all', (await page.$$('.inv tbody tr')).length === 0,
  (await page.$$('.inv tbody tr')).length + ' row(s)');
await page.setInputFiles('#importFile', honestPath);
await page.waitForTimeout(1500);
await inventory();
rows = await deviceRows();
check('the honest journal still opens afterwards — two devices, as before',
  rows.length === 2 && rows.filter(r => r.hostname === HOST).length === 2, rows.length + ' rows');

// ---- 9. THE INVARIANTS -------------------------------------------------------
check('one network request, the file itself (invariant 1)',
  requests.filter(u => !u.startsWith('file://') && u !== 'about:blank').length === 0,
  requests.length + ' request(s)');
check('no page errors through the whole drive', errors.length === 0, errors.join(' | '));

await browser.close();
const bad = results.filter(r => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
process.exit(bad.length ? 1 : 0);
