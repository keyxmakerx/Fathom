// The finder's honesty chrome and its clipboard ladder, driven in a browser.
//
//   node docs/80-review/evidence/2026-08-15-finder-verification-and-copy.mjs
//
// WHY THIS FILE EXISTS. An adversarial review of the finder found one
// high-severity defect and four claim-vs-code gaps, and every one of them was a
// sentence in a report that the shipped page did not support. So this driver
// asserts the corrected behaviour against the assembled artifact rather than
// against the source:
//
//   1  ADR-0027's `unverified` is keyed on a BENCH RUN (61 §3.1's verified_on),
//      not on `reviewed_by`. The corpus review line must name both facts.
//   2  The label lives in TWO places on BOTH forms, not three.
//   3  53 §3.5's three Enters are all bound and all distinguishable.
//   4  52 §3.2.2's "same keymap": Esc clears the query in the ⌥1 full-canvas
//      form exactly as it does in the overlay.
//   5  53 §6.2's layer 3 and layer 4. With the clipboard denied, the PAYLOAD
//      must survive -- "Never a silent failure" is about the text, not about
//      the announcement.
//
// Assertions are DOM-only: the page's JS is inside an IIFE and nothing in it is
// reachable from the driver, which is the point -- this tests what a user can
// see, not what a function returns.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

// The REPO's artifact, not a worktree's. This line held an absolute path into
// `.claude/worktrees/wf_4fe78c28-dff-1/` — the throwaway tree this file was
// written in — so the driver stopped running the day that tree was cleaned up.
// A checked-in test may not depend on a path that is not checked in.
const ROOT = process.argv[2] || process.cwd();
const URL = 'file://' + ROOT + '/target/artifact/fathom-dev.html';

const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '\n        ' + d : '')); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e)));
const reqs = []; page.on('request', r => reqs.push(r.url()));
await page.goto(URL);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// --- 1. the review line names both facts, and keys unverified on the box ----
await page.keyboard.press('Control+k');
await page.fill('#fq', 'ipsec');
await page.waitForFunction(() => document.querySelectorAll('#fhits .hit').length > 0);

const review = await page.textContent('#fReview');
check('the corpus line counts the bench runs', /98 unverified, never run on a box \(ADR-0027\)/.test(review), review);
check('and counts the placeholder reviewers SEPARATELY',
  /98 with no named reviewer \(invariant 10\)/.test(review), review);

const stamps = await page.$$eval('#fhits .stampline', ns => ns.map(n => [n.textContent, n.getAttribute('data-unverified')]));
check('every row is stamped, and every stamp says not run on a box',
  stamps.length > 20 && stamps.every(([t, u]) => u === 'true' && /unverified — not run on a box/.test(t)),
  stamps.length + ' rows; first: ' + JSON.stringify(stamps[0]));
check('and no stamp claims a reviewer the corpus does not have',
  stamps.every(([t]) => /no named reviewer \(invariant 10\)/.test(t)), JSON.stringify(stamps[0]));

// --- 2. two labelling places, on BOTH forms ---------------------------------
const foot = await page.textContent('#fFootCount');
check('the footer carries hit counts and makes no review claim',
  /above the cutoff/.test(foot) && !/unverified|reviewed/.test(foot), foot);

// --- 3. the three Enters ----------------------------------------------------
// Each press is followed by a wait on the footer, because copyText is async:
// reading #fMsg synchronously after the keystroke reads the PREVIOUS copy's
// message, which is how the first version of this driver reported a pass for
// ⇧Enter that was really the pass from the plain Enter before it.
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
const clip = () => page.evaluate(() => navigator.clipboard.readText());
async function pressInFinder(input, mods) {
  await page.keyboard.press('Control+k');
  await page.fill('#fq', 'ipsec');
  await page.waitForFunction(() => document.querySelectorAll('#fhits .hit').length > 0);
  await page.evaluate(() => { document.getElementById('fMsg').textContent = ''; });
  await page.focus(input);
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press('Enter');
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForFunction(() => document.getElementById('fMsg').textContent !== '', null, { timeout: 4000 });
  return page.textContent('#fMsg');
}

let msg = await pressInFinder('#fq', []);
check('Enter copies the command and closes',
  (await page.getAttribute('#fsheet', 'hidden')) !== null &&
  /^copied: show security ipsec/.test(msg) && /^show security ipsec/.test(await clip()), msg);

msg = await pressInFinder('#fq', ['Shift']);
check('⇧Enter is bound, and SAYS it copied the un-interpolated form (53 §3.5)',
  /^copied un-interpolated: /.test(msg) && /<vpn-name>/.test(await clip()), msg);

msg = await pressInFinder('#fq', ['Alt']);
const blockText = await clip();
check('⌥Enter copies the whole answer block, stamp last',
  msg === 'copied the answer block' && blockText.split('\n').length >= 6 &&
  /unverified — not run on a box/.test(blockText.split('\n').pop()),
  JSON.stringify(blockText.split('\n').pop()));

// --- 4. the ⌥1 full-canvas form shares the Esc keymap -----------------------
await page.keyboard.press('Alt+Digit1');
await page.waitForSelector('#fqv');
await page.fill('#fqv', 'show security ike');
await page.waitForFunction(() => document.querySelectorAll('#fvhits .hit').length > 0);
const fvBefore = await page.inputValue('#fqv');
await page.focus('#fqv');
await page.keyboard.press('Escape');
check('Esc in the full-canvas form clears the query, as it does in the overlay (52 §3.2.2)',
  fvBefore === 'show security ike' && (await page.inputValue('#fqv')) === '',
  'before ' + JSON.stringify(fvBefore) + ' after ' + JSON.stringify(await page.inputValue('#fqv')));
check('and the full-canvas form carries the same corpus line',
  /never run on a box/.test(await page.$eval('.pad .freview', n => n.textContent)),
  await page.$eval('.pad .freview', n => n.textContent));

// --- 5. the clipboard ladder, layer by layer --------------------------------
// Two runs. The first denies layer 2 only; the second denies layers 2 AND 3,
// which is the only state layer 4 exists for. Denying by REPLACING the API is
// the honest simulation available here: a permission prompt cannot be refused
// from a driver, and what the page must do about a rejection is the thing under
// test either way.
async function copyWithDeniedClipboard(alsoDenyExecCommand) {
  await page.evaluate((denyExec) => {
    navigator.clipboard.writeText = () =>
      Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
    if (denyExec) document.execCommand = () => false;
  }, alsoDenyExecCommand);
  await page.keyboard.press('Alt+Digit1');
  await page.fill('#fqv', 'ipsec');
  await page.waitForFunction(() => document.querySelectorAll('#fvhits .hit').length > 0);
  const want = await page.textContent('#fvhits .hit .cmd');
  await page.evaluate(() => { document.getElementById('fMsg').textContent = ''; });
  await page.focus('#fqv');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('fMsg').textContent !== '', null, { timeout: 4000 });
  return { want, msg: await page.textContent('#fMsg'), block: (await page.getAttribute('#cfall', 'hidden')) === null };
}

let r3 = await copyWithDeniedClipboard(false);
// OBSERVED, not assumed (ADR-0034): Chromium 141.0.7390.37 on a file:// document
// ran document.execCommand('copy') successfully from inside the rejected
// promise's handler on 2026-08-15. Other engines may not, which is exactly why
// layer 4 is asserted separately below rather than treated as unreachable.
check('layer 3 catches a refused layer 2, and says the primary path failed',
  /used the deprecated path/.test(r3.msg) && !r3.block, r3.msg);

let r4 = await copyWithDeniedClipboard(true);
check('with layers 2 AND 3 denied, layer 4 renders the payload',
  r4.block && (await page.inputValue('#cfta')) === r4.want,
  JSON.stringify((await page.inputValue('#cfta')).slice(0, 60)) + ' vs ' + JSON.stringify(r4.want.slice(0, 60)));
check('and 53 §6.5 words the footer verbatim',
  r4.msg === 'copy blocked by the browser · press ⌘C on the selected block', r4.msg);
check('layer 4 pre-selects the block and puts focus in it (53 §6.2)',
  await page.evaluate(() => document.activeElement && document.activeElement.id === 'cfta' &&
    document.activeElement.selectionStart === 0 &&
    document.activeElement.selectionEnd === document.activeElement.value.length));
check('and it is readonly — a last-resort block is not an editor',
  await page.evaluate(() => document.getElementById('cfta').readOnly));
await page.screenshot({ path: 'docs/80-review/evidence/2026-08-15-finder-copy-fallback.png' });
await page.keyboard.press('Escape');
check('Esc dismisses it and does not leave the payload in the DOM',
  (await page.getAttribute('#cfall', 'hidden')) !== null && (await page.inputValue('#cfta')) === '');

check('zero page errors', errs.length === 0, errs.join(' | '));
check('exactly one network request (the file itself)', reqs.length === 1, reqs.join(' | '));

await browser.close();
const bad = results.filter(r => !r).length;
console.log('\n' + (results.length - bad) + '/' + results.length + ' pass');
process.exit(bad ? 1 : 0);
