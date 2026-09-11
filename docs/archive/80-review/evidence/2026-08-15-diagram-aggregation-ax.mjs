// Aggregation's disclosure contract, read from the ACCESSIBLE TREE.
//
//   node docs/80-review/evidence/2026-08-15-diagram-aggregation-ax.mjs
//
// WHY THIS FILE EXISTS. The aggregation rebuild declared its whole disclosure
// contract -- role, tabindex, aria-label, aria-expanded, aria-controls -- on the
// SVG <g> elements. The SVG is `aria-hidden="true"` (`55` §10 item 6), so none
// of it was announced by anything, and a focusable node inside an aria-hidden
// subtree is a defect on its own: it takes focus that assistive technology
// cannot follow. Both the builder and its adversarial reviewer verified those
// attributes with getAttribute and found them present, which is true and beside
// the point. THE DOM IS NOT THE ACCESSIBLE TREE. So this file asks Chromium for
// the accessible tree and asserts on what is in it.
//
// The fix `55` §4.5.2 already specified: "keyboard focus in the diagram view
// never enters the <svg>. It moves through a real DOM tree -- the Outline ...
// The SVG mirrors the Outline's focus; it does not hold it." The disclosure is
// the Outline row; the shape keeps only its data attributes, for the mouse.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
/* THE TREE UNDER TEST IS THE TREE THIS SCRIPT LIVES IN.
   This line used to name /home/user/Fathom absolutely, so running it from a
   worktree opened the MAIN repo's artifact and reported a clean pass for a
   build that was never made here. It is derived from the script's own path
   now, with FATHOM_ARTIFACT as an override for anyone who wants to point it
   somewhere on purpose. Found 2026-08-16, after six drivers were run from a
   worktree and answered for somebody else's bytes. */
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, resolve as __r } from 'node:path';
const __ROOT = __r(__d(__f(import.meta.url)), '..', '..', '..');
const __ARTIFACT = process.env.FATHOM_ARTIFACT
  || ('file://' + __ROOT + '/target/artifact/fathom-dev.html');
const URL = __ARTIFACT;
function units(n) {
  const L = ['set system host-name srx-hub-01',
             'set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30'];
  for (let i = 0; i < n; i++)
    L.push(`set interfaces st0 unit ${i} family inet address 10.255.${i}.1/30`);
  return L.join('\n') + '\n';
}
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.goto(URL);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.click('#tabPaste'); await page.fill('#pta', units(13)); await page.click('#pRun');
await page.waitForFunction(() => document.querySelectorAll('.inv tbody tr').length > 0);
await page.click('[data-view="diagram"]'); await page.waitForSelector('.dcanvas svg');

const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   ' + d : '')); };

function flat(node, out = []) {
  out.push({ role: node.role, name: node.name, expanded: node.expanded });
  (node.children || []).forEach(c => flat(c, out));
  return out;
}

let ax = flat(await page.accessibility.snapshot({ interestingOnly: false }));
const groupNames = ax.filter(n => /collapsed|partially expanded/i.test(n.name || ''));
check('the collapsed group is IN the accessible tree at all',
  groupNames.length > 0, groupNames.length + ' nodes name a collapse');
check('and it announces the cardinal and what activating does',
  groupNames.some(n => /13 collapsed\. Activate to expand 6 of them\./.test(n.name)),
  JSON.stringify(groupNames.slice(0, 3)));
check('no focusable node lives inside the aria-hidden picture',
  (await page.$$eval('svg[aria-hidden="true"] [tabindex]', n => n.length)) === 0);
check('and no role= survives on a shape either',
  (await page.$$eval('svg[aria-hidden="true"] [role]', n => n.length)) === 0);

// Open it FROM THE KEYBOARD, through the Outline, and re-read the tree.
await page.evaluate(() => {
  const r = document.querySelector('[data-drow][data-group]');
  r.setAttribute('tabindex', '0'); r.focus();
});
const before = await page.evaluate(() => document.activeElement.id);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({
  id: document.activeElement.id, tag: document.activeElement.tagName,
  rows: document.querySelectorAll('[data-drow]').length }));
check('Enter on the Outline row opens the group', after.rows > 9,
  before + ' -> ' + JSON.stringify(after));
check('and focus is on an Outline row, never <body> (59 §3.8)',
  after.tag === 'DIV' && /^dorow/.test(after.id), JSON.stringify(after));

ax = flat(await page.accessibility.snapshot({ interestingOnly: false }));
const partial = ax.filter(n => /partially expanded/i.test(n.name || ''));
check('the partial state is announced, with both numbers',
  partial.some(n => /partially expanded: 6 of 13 shown, 7 still collapsed/.test(n.name)),
  JSON.stringify(partial.slice(0, 2)));
check('and it is expanded=true in the accessible tree',
  partial.some(n => n.expanded === true), JSON.stringify(partial.slice(0, 2)));

// aria-controls must point at nodes that exist.
const ctl = await page.evaluate(() => {
  const r = document.querySelector('[data-drow][aria-controls]');
  if (!r) return null;
  const ids = r.getAttribute('aria-controls').split(' ');
  return { ids: ids.length, resolve: ids.filter(i => document.getElementById(i)).length };
});
check('every aria-controls id resolves to a real node',
  ctl && ctl.ids > 0 && ctl.ids === ctl.resolve, JSON.stringify(ctl));

check('no page errors', errs.length === 0, errs.join(' | '));
console.log('\n' + results.filter(Boolean).length + '/' + results.length + ' checks pass');
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
