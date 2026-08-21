// A PASTE ADDS TO THE DESIGN, AND WILL NOT GUESS ABOUT A BOX IT ALREADY HAS.
//
//   cargo run --locked -p fathom-artifact
//   node docs/80-review/evidence/2026-08-21-the-additive-paste.mjs [repo-root]
//
// `49` §10b, the last of phase 0. Until 2026-08-21 OP_PASTE REPLACED the held
// estate: pasting a second switch deleted the first, silently, with no undo.
// On a server holding many designs of thousands of devices that is wrong in
// every single case.
//
// THE HARD HALF IS NOT THE ADDING. It is what to do when the paste names a box
// the design already holds. `70` §16.3 settled that question by DEFERRING it:
//
//   "a tier-1 match is a proposal to a human, not an automatic merge, because
//    two real branch sites may both run a `core-01` SRX on the same platform.
//    Until it is designed, OP_PASTE replaces the held estate and says so,
//    which is the behaviour that cannot silently merge two boxes."
//
// Making the paste additive REMOVES that guard, so the proposal has to exist —
// which is why this file drives the question and its answer, not just the add.
//
// And what replacing was actually doing is worth stating plainly: pasting the
// same box twice yielded one device BECAUSE THE SECOND PASTE DESTROYED THE
// FIRST. That is not correlation. It is amnesia that looks like correlation
// from one angle, and a question is the truth about what Fathom knows.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
};

const A = `set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set security zones security-zone trust interfaces ge-0/0/0.0
`;
const B = `set system host-name srx-branch-02
set interfaces ge-0/0/1 unit 0 family inet address 198.51.100.2/30
set security zones security-zone untrust interfaces ge-0/0/1.0
`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

const paste = async text => {
  await page.click('#tabPaste');
  await page.waitForFunction(() => document.querySelector('#pta') !== null);
  await page.fill('#pta', text);
  await page.click('#pRun');
  await page.waitForTimeout(400);
};
const devices = () => page.evaluate(() => {
  const strip = [...document.querySelectorAll('[data-kind]')]
    .find(n => /device/i.test(n.textContent));
  if (strip) strip.click();
  return document.querySelectorAll('.inv tbody tr').length;
});

// ---- 1. TWO DIFFERENT BOXES ACCUMULATE ---------------------------------------
await paste(A);
await page.keyboard.press('Escape');
await page.click('[data-view="inventory"]');
await page.waitForTimeout(250);
const afterFirst = await devices();
check('the first paste builds a device', afterFirst >= 1, afterFirst + ' row(s)');

await paste(B);
await page.keyboard.press('Escape');
await page.click('[data-view="inventory"]');
await page.waitForTimeout(250);
const afterSecond = await devices();
check('THE SECOND PASTE ADDS RATHER THAN REPLACING',
  afterSecond > afterFirst,
  afterFirst + ' -> ' + afterSecond + ' rows');

// The first box must still be there by NAME, not merely by count — a count can
// be satisfied by the wrong device.
const names = await page.evaluate(() => document.body.innerText);
check('and the FIRST device is still named on the page',
  names.includes('srx-branch-01'), 'srx-branch-01 present');
check('beside the second', names.includes('srx-branch-02'), 'srx-branch-02 present');

// ---- 2. THE SAME BOX AGAIN IS A QUESTION, NOT A SILENT ANYTHING --------------
await paste(A);
const asked = await page.evaluate(() => {
  const n = document.querySelector('#pErr');
  return n && !n.hidden ? n.innerText : '';
});
check('re-pasting a box the design holds ASKS', /already in this design/i.test(asked),
  asked.slice(0, 90).replace(/\n/g, ' '));
check('and the question names the box', /srx-branch-01/.test(asked));
check('and says WHY it will not guess',
  /estate of record|will not merge/i.test(asked));
check('and does not pretend an update exists',
  /no update yet|re-identification|nothing in this build/i.test(asked),
  'the missing second answer is stated, not offered');

const buttons = await page.$$eval('#pErr button', ns => ns.map(n => n.textContent.trim()));
check('exactly ONE answer is offered', buttons.length === 1, JSON.stringify(buttons));
check('and it is the honest one', /different boxes/i.test(buttons[0] || ''), buttons[0]);

// NOTHING WAS WRITTEN by the refused paste.
await page.keyboard.press('Escape');
await page.click('[data-view="inventory"]');
await page.waitForTimeout(250);
const afterRefusal = await devices();
check('THE REFUSED PASTE WROTE NOTHING', afterRefusal === afterSecond,
  afterSecond + ' -> ' + afterRefusal + ' rows');

// ---- 3. ANSWERING IT ADDS A SECOND DEVICE ------------------------------------
await page.click('#tabPaste');
await page.waitForTimeout(150);
await page.click('#pErr button[data-pdup]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.click('[data-view="inventory"]');
await page.waitForTimeout(250);
const afterConfirm = await devices();
check('answering "different boxes" adds one', afterConfirm > afterRefusal,
  afterRefusal + ' -> ' + afterConfirm + ' rows');

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' checks pass');
process.exit(passed === results.length ? 0 : 1);
