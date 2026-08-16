/* Drives the shipped artifact to prove the demo-estate removal (2026-08-15).
 *
 * The fixture was 35,272 bytes of `44` §5.2's 900,000-byte module ceiling and
 * it is now behind an off-by-default Cargo feature. Removing an opcode a page
 * calls at boot is exactly the change that fails SILENTLY — the URL parameter
 * still parses, the call still returns, and the page renders an empty estate
 * with no explanation. So the assertions below are about what a PERSON is told,
 * not about whether the call returned.
 *
 * Run:
 *   cargo run --locked -p fathom-artifact
 *   /opt/node22/bin/node docs/80-review/evidence/2026-08-15-demo-estate-removed.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const page_url = 'file://' + path.join(root, 'target/artifact/fathom-dev.html');

let failures = 0;
let checks = 0;
function ok(name, cond, detail) {
  checks += 1;
  if (cond) {
    console.log('  PASS  ' + name);
  } else {
    failures += 1;
    console.log('  FAIL  ' + name + (detail === undefined ? '' : '  <-- ' + detail));
  }
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

/* ---------------------------------------------------------------------------
   1. ?fixture=demo-estate against a module that no longer has it.
   --------------------------------------------------------------------------- */
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(page_url + '?fixture=demo-estate');
  await page.waitForFunction(() => document.querySelectorAll('.unposted').length > 0);

  const text = await page.evaluate(() => document.body.innerText);

  ok(
    'the page says this module has no demo estate',
    /This module has no demo estate/.test(text),
    JSON.stringify(text.slice(0, 400)),
  );
  ok(
    'it names the cost, so the refusal is a reason and not an apology',
    /35,272 bytes/.test(text) && /900,000-byte module ceiling/.test(text),
  );
  ok(
    'it names the two doors that DO work',
    /Paste a config/.test(text) && /add\s+equipment by hand/.test(text),
  );
  /* The defect this guards: the raw typed refusal reaching a human. It is true
     and it is useless — "opcode 11" is not a thing anyone typed. */
  ok(
    'the raw ERR_UNKNOWN_OP text is NOT what the person is shown',
    !/opcode 11 is not implemented/.test(text) && !/the module refused: code 1/.test(text),
  );
  /* The silent-failure this guards: an empty inventory with no explanation. */
  ok(
    'no estate was loaded and the empty state says so',
    /no workspace loaded/.test(text),
  );
  ok(
    'the empty state no longer offers the fixture it cannot provide',
    !/\?fixture=demo-estate/.test(text),
  );
  ok(
    'one network request, the file itself (invariant 1)',
    requests.length === 1 && requests[0].startsWith('file://'),
    JSON.stringify(requests),
  );
  await page.screenshot({
    path: path.join(root, 'docs/80-review/evidence/2026-08-15-demo-estate-refused.png'),
    fullPage: true,
  });
  await ctx.close();
}

/* ---------------------------------------------------------------------------
   2. The doors the page now points at must actually open. Removing the fixture
      is only defensible if the real input works, so this asserts it rather
      than asserting it elsewhere.
   --------------------------------------------------------------------------- */
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(page_url);
  await page.waitForFunction(() => document.querySelectorAll('.unposted').length > 0);

  await page.click('#tabPaste');
  await page.fill(
    '#pta',
    [
      'set system host-name lab-srx-01',
      'set interfaces ge-0/0/0 unit 0 family inet address 198.51.100.1/24',
      'set interfaces ge-0/0/1 unit 0 family inet address 203.0.113.1/24',
    ].join('\n'),
  );
  await page.click('#pRun');
  await page.waitForFunction(() => !/no workspace loaded/.test(document.body.innerText));

  const text = await page.evaluate(() => document.body.innerText);
  ok('a pasted config still builds an estate', /lab-srx-01/.test(text), JSON.stringify(text.slice(0, 300)));
  ok('the estate is labelled as pasted, not as a demo', /pasted config/.test(text) && !/demo estate/.test(text));
  await page.screenshot({
    path: path.join(root, 'docs/80-review/evidence/2026-08-15-paste-after-removal.png'),
    fullPage: true,
  });
  await ctx.close();
}

await browser.close();
console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures === 0 ? 0 : 1);
