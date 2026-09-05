// The diagram surface at every width it has to survive -- and it is a HEIGHT
// test, because height is what broke.
//
//   node docs/80-review/evidence/2026-08-15-diagram-surface-edges.mjs [repo-root]
//
// WHY THIS FILE IS SHAPED THE WAY IT IS. Its predecessor measured `canvasW` and
// `outlineW` and asserted containment with
//
//     return b.left >= c.left - 1 && b.right <= c.right + 1;
//
// -- horizontal only. So it PASSED at 700 px while the canvas was 70 px tall
// with five of fifteen boxes cut off below it, and it passed at 320 px while
// the canvas was 0 px tall, the Outline 4 px, and not one row was on screen. A
// test that passes over the defect is worse than no test, so every assertion
// below names a height, a vertical containment, or a count of rows actually
// inside the visible box of the container that scrolls them.
//
// The bar each width has to clear, and why it is that bar and not "N rows":
//   * the Outline has a positive height and one row per drawn box;
//   * at least one row INTERSECTS the fact column's visible box;
//   * focusing the first, middle and last row leaves that row wholly inside the
//     fact column -- WCAG 2.4.11 Focus Not Obscured, and `55` §5.6's roving
//     contract, which is the pair the old build failed;
//   * the page body never scrolls sideways -- WCAG 1.4.10.
// "N rows visible without scrolling" is deliberately NOT the bar. Measured on
// this build, the shipped inventory view shows 0 of its rows at 320x800,
// 360x740 and 390x844, because at those sizes the shell gives the fact column
// 120-298 px in total. Demanding more of the diagram than the product's only
// other live view manages would be measuring the wrong thing.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const ROOT = process.argv[2] || process.cwd();
const FILE = 'file://' + ROOT + '/target/artifact/fathom-dev.html';
const OUT = ROOT + '/docs/80-review/evidence';
const CONFIG = `set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security ike gateway gw-hq address 198.51.100.10
set security ike gateway gw-hq external-interface ge-0/0/0.0
set security ipsec vpn hq-vpn ike gateway gw-hq
set security ipsec vpn hq-vpn bind-interface st0.0
set security zones security-zone vpn interfaces st0.0
`;
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   ' + d : '')); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(FILE);
await page.waitForFunction(() => document.querySelector('#band button') !== null);

// --- no estate ---------------------------------------------------------------
await page.click('[data-view="diagram"]');
check('with no estate the view says so instead of drawing an empty box',
  (await page.textContent('#factBody')).includes('paste a config'));
check('no canvas is mounted', (await page.$('.dcanvas')) === null);
await page.keyboard.press('z');   // must not throw with nothing mounted
check('z with nothing mounted is a no-op', errors.length === 0, errors.join('|'));

// --- load ---------------------------------------------------------------------
await page.click('#tabPaste');
await page.fill('#pta', CONFIG);
await page.click('#pRun');
await page.click('[data-view="diagram"]');
await page.waitForSelector('.dcanvas svg');

/** Everything the width sweep needs, measured in one pass. */
const measure = () => page.evaluate(() => {
  const q = s => document.querySelector(s);
  const box = n => { const b = n.getBoundingClientRect();
                     return { w: Math.round(b.width), h: Math.round(b.height) }; };
  const col = q('#factBody').getBoundingClientRect();
  const rows = Array.from(document.querySelectorAll('[data-drow]'));
  const inside = n => { const b = n.getBoundingClientRect();
    return b.height > 0 && b.top >= col.top - 1 && b.bottom <= col.bottom + 1; };
  const touching = n => { const b = n.getBoundingClientRect();
    return b.height > 0 && b.bottom > col.top && b.top < col.bottom; };
  const canvas = q('.dcanvas');
  const cr = canvas.getBoundingClientRect();
  const shapes = Array.from(document.querySelectorAll('.dbox rect'));
  // Vertical AND horizontal -- the containment the old driver only half did.
  const boxesIn = shapes.filter(s => { const b = s.getBoundingClientRect();
    return b.width > 0 && b.height > 0 &&
           b.left >= cr.left - 1 && b.right <= cr.right + 1 &&
           b.top >= cr.top - 1 && b.bottom <= cr.bottom + 1; }).length;
  const se = document.scrollingElement;
  return {
    narrow: document.getElementById('sheet').getAttribute('data-width') === 'narrow',
    col: { w: Math.round(col.width), h: Math.round(col.height) },
    canvas: box(canvas), outline: box(q('.dout')),
    canvasShown: getComputedStyle(canvas).display !== 'none',
    sumShown: getComputedStyle(q('.dsum')).display !== 'none',
    rows: rows.length, rowsInside: rows.filter(inside).length,
    rowsTouching: rows.filter(touching).length,
    boxes: shapes.length, boxesIn,
    bodyHScroll: se.scrollWidth > se.clientWidth + 1
  };
});

/** Focus a row by index and report whether it ended up inside the column. */
const focusRow = (i) => page.evaluate((idx) => {
  const rows = Array.from(document.querySelectorAll('[data-drow]'));
  const r = rows[idx];
  r.setAttribute('tabindex', '0');
  r.focus();
  const b = r.getBoundingClientRect();
  const c = document.getElementById('factBody').getBoundingClientRect();
  return { focused: document.activeElement === r,
           inside: b.height > 0 && b.top >= c.top - 1 && b.bottom <= c.bottom + 1,
           row: [Math.round(b.top), Math.round(b.height)],
           col: [Math.round(c.top), Math.round(c.height)] };
}, i);

const WIDTHS = [[1400, 900], [1400, 400], [860, 800], [800, 800], [700, 800],
                [600, 800], [500, 800], [390, 844], [360, 740], [320, 800]];

console.log('\n  width      col      canvas    outline   rows in/touch/all   boxes-in-canvas');
for (const [w, h] of WIDTHS) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(160);
  const m = await measure();
  const tag = w + 'x' + h;
  console.log('  ' + tag.padEnd(10) +
    (m.col.w + 'x' + m.col.h).padEnd(9) +
    (m.canvasShown ? m.canvas.w + 'x' + m.canvas.h : 'collapsed').padEnd(10) +
    (m.outline.w + 'x' + m.outline.h).padEnd(10) +
    (m.rowsInside + '/' + m.rowsTouching + '/' + m.rows).padEnd(20) +
    (m.canvasShown ? m.boxesIn + '/' + m.boxes : '—'));

  // THE REGRESSION, ASSERTED. The old build gave the Outline 0-6 px here.
  check(tag + ': the Outline has real height', m.outline.h > 0, 'h=' + m.outline.h);
  check(tag + ': every drawn box has an Outline row', m.rows === m.boxes,
    m.rows + ' rows, ' + m.boxes + ' boxes');
  check(tag + ': at least one row is on screen', m.rowsTouching >= 1,
    'inside ' + m.rowsInside + ', touching ' + m.rowsTouching);
  check(tag + ': the page body does not scroll sideways', !m.bodyHScroll);

  // `55` §6.3 decides this view's narrow behaviour by name.
  if (m.narrow) {
    check(tag + ': the canvas is collapsed to a summary line (55 §6.3)',
      !m.canvasShown && m.sumShown);
  } else {
    check(tag + ': wide keeps the canvas beside the Outline, no summary line',
      m.canvasShown && !m.sumShown && m.canvas.h > 0 && m.outline.h > 0,
      'canvas ' + m.canvas.h + ', outline ' + m.outline.h);
    check(tag + ': every box is inside the canvas, vertically as well as across',
      m.boxesIn === m.boxes, m.boxesIn + '/' + m.boxes);
  }

  // WCAG 2.4.11 / `55` §5.6. The old build put a focused row at top=479 h=30
  // inside a container at top=492 h=4.
  for (const idx of [0, Math.floor((m.rows - 1) / 2), m.rows - 1]) {
    const f = await focusRow(idx);
    check(tag + ': focused row ' + idx + ' is inside its scroll container',
      f.focused && f.inside, 'row ' + JSON.stringify(f.row) + ' col ' + JSON.stringify(f.col));
  }
}

// --- the control `55` §6.3 requires ------------------------------------------
await page.setViewportSize({ width: 320, height: 800 });
await page.waitForTimeout(160);
// The sweep above left the fact column scrolled to whichever row it focused
// last; the screenshots are meant to show the TOP of the surface.
const toTop = () => page.evaluate(() => { document.getElementById('factBody').scrollTop = 0; });
await toTop();
await page.screenshot({ path: OUT + '/2026-08-15-diagram-surface-narrow.png' });
check('320 px: the expand control says what it will do',
  (await page.textContent('[data-dexpand]')) === 'show the picture');
check('320 px: it is a disclosure and says so',
  (await page.getAttribute('[data-dexpand]', 'aria-expanded')) === 'false');
await page.click('[data-dexpand]');
await page.waitForTimeout(220);
const open = await measure();
check('320 px: expanding gives a canvas with real height', open.canvasShown && open.canvas.h > 0,
  'canvas ' + open.canvas.w + 'x' + open.canvas.h);
check('320 px: and the whole picture is inside it, vertically too',
  open.boxesIn === open.boxes, open.boxesIn + '/' + open.boxes);
// The control has to deliver the picture, not just mount it below the fold.
// Measured HERE, before anything else in this block touches the scroll.
const shown = await page.evaluate(() => {
  const c = document.querySelector('.dcanvas').getBoundingClientRect();
  const col = document.getElementById('factBody').getBoundingClientRect();
  return { overlap: Math.round(Math.min(c.bottom, col.bottom) - Math.max(c.top, col.top)),
           canvasH: Math.round(c.height) };
});
check('320 px: the control scrolls the picture into the column, not merely into the DOM',
  shown.overlap > 40, shown.overlap + ' of ' + shown.canvasH + ' px on screen');
await page.screenshot({ path: OUT + '/2026-08-15-diagram-surface-narrow-open.png' });
// The Outline is UNDER an 18rem canvas in a 146 px column, so it is below the
// fold by construction -- the user asked for the picture. What must hold is
// that it is all still there and every row is still reachable, which is the
// pair the old build failed: it had neither.
check('320 px: the Outline is still whole under it',
  open.outline.h > 0 && open.rows === open.boxes,
  'outline ' + open.outline.h + ', ' + open.rows + ' rows for ' + open.boxes + ' boxes');
const reach = await focusRow(open.rows - 1);
check('320 px: with the picture open, the last row is still reachable and lands inside the column',
  reach.focused && reach.inside, 'row ' + JSON.stringify(reach.row) + ' col ' + JSON.stringify(reach.col));
check('320 px: still no sideways scroll with the picture open', !open.bodyHScroll);
check('320 px: the control now offers the way back',
  (await page.textContent('[data-dexpand]')) === 'hide the picture' &&
  (await page.getAttribute('[data-dexpand]', 'aria-expanded')) === 'true');
await page.click('[data-dexpand]');
await page.waitForTimeout(160);
check('320 px: collapsing puts the summary line back',
  !(await measure()).canvasShown);
check('320 px: the band stops quoting a zoom for a picture that is not on screen',
  /picture collapsed/.test(await page.textContent('.dband')),
  (await page.textContent('.dband')).trim());

// `55` §6.3's own e2e assertion, verbatim: "for zoom in [200,400] ... every
// interactive element reachable by Tab". Tabbed for real from the top of the
// document, and the list must come back to <body> -- `55` §5.7 forbids a trap
// on this surface outright ("The diagram canvas | no").
// Rebuild the view first. The width sweep above focused rows 0, middle and last
// by hand, which left three rows carrying tabindex="0" -- the harness's doing,
// not the page's. A view switch runs roveScan, which restores the one-stop
// contract, and asserting the contract on a tree the harness has been poking is
// asserting the harness.
await page.click('[data-view="inventory"]');
await page.click('[data-view="diagram"]');
await page.waitForTimeout(160);
await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
await page.keyboard.press('Tab');
const walk = [];
for (let i = 0; i < 80; i++) {
  const here = await page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'BODY';
    return (a.getAttribute('data-layer') ? 'layer:' + a.textContent
         : a.getAttribute('data-dexpand') ? 'expand'
         : a.getAttribute('data-drow') ? 'row'
         : a.id || a.tagName + '.' + (a.className || ''));
  });
  walk.push(here);
  if (here === 'BODY' && walk.length > 1) break;
  await page.keyboard.press('Tab');
}
const reached = new Set(walk);
check('320 px: every layer toggle is reachable by Tab',
  ['physical', 'l2', 'l3', 'security', 'overlay'].every(l => reached.has('layer:' + l)),
  walk.filter(w => w.startsWith('layer:')).join(' '));
check('320 px: the expand control is reachable by Tab', reached.has('expand'));
check('320 px: the Outline is reachable by Tab, as exactly one stop',
  walk.filter(w => w === 'row').length === 1, walk.filter(w => w === 'row').length + ' stops');
check('320 px: Tab leaves the surface again — no trap (55 §5.7)',
  walk.indexOf('BODY') > 0, walk.length + ' stops walked: ' + walk.join(' '));

// --- 400% page zoom, which is what 320 CSS px IS (55 §6.3) --------------------
//
// CORRECTED 2026-08-15, and the correction is the point. This block used to set
// `document.body.style.zoom = '4'` on a 1400x900 context and assert it "IS the
// 320 CSS px case". IT IS NOT. The CSS `zoom` property scales the element's
// layout, and `window.innerWidth` stays 1400 — so the sheet's width rules never
// fire, `[data-width]` stays `wide`, and the block was measuring the wide layout
// under a magnifying glass. That is the overclaim this file's own DEFECT 3 was
// about, arriving in the evidence rather than in the product.
//
// A browser at 400% on a 1400x900 physical display gives a 350x225 CSS viewport,
// so that is what is set. Reached by the numbers rather than by the name:
// 1400/4 = 350, 900/4 = 225.
//
// WHAT THIS NOW MEASURES, AND WHAT IT FINDS. At 350x225 the fact column has zero
// height and no Outline row is on screen. That failure is PRE-EXISTING and
// SHELL-WIDE — it reproduces in all five views on the parent commit, before any
// diagram work — so it is asserted here as a known state rather than as a pass,
// and it is filed in `73` §14 as an escalation. Asserting `touching >= 1` here
// would be re-telling the same lie in the other direction: claiming a product
// behaviour that is not there.
await page.setViewportSize({ width: 1400, height: 900 });
const zoomed = await browser.newContext({ viewport: { width: 350, height: 225 }, deviceScaleFactor: 4 });
const zp = await zoomed.newPage();
const zerrors = [];
zp.on('pageerror', e => zerrors.push(String(e)));
await zp.goto(FILE);
await zp.waitForFunction(() => document.querySelector('#band button') !== null);
await zp.click('#tabPaste');
await zp.fill('#pta', CONFIG);
await zp.click('#pRun');
await zp.click('[data-view="diagram"]');
// `attached`, not `visible`: at this width `55` §6.3's substitution collapses
// the canvas by design, so waiting for a VISIBLE svg waits forever. That the
// wait had to change is itself the finding — the old block never reached this
// layout at all.
await zp.waitForSelector('.dcanvas svg', { state: 'attached' });
await zp.waitForTimeout(250);
const z = await zp.evaluate(() => {
  const col = document.getElementById('factBody').getBoundingClientRect();
  const rows = Array.from(document.querySelectorAll('[data-drow]'));
  const se = document.scrollingElement;
  return { rows: rows.length,
           boxes: document.querySelectorAll('.dbox').length,
           innerWidth: window.innerWidth,
           width: document.querySelector('.sheet').getAttribute('data-width'),
           colH: Math.round(col.height),
           touching: rows.filter(n => { const b = n.getBoundingClientRect();
             return b.height > 0 && b.bottom > col.top && b.top < col.bottom; }).length,
           outlineH: Math.round(document.querySelector('.dout').getBoundingClientRect().height),
           bodyHScroll: se.scrollWidth > se.clientWidth + 1 };
});
check('400% page zoom: the viewport really is narrow, not a magnified wide one',
  z.innerWidth <= 350 && z.width === 'narrow', JSON.stringify(z));
check('400% page zoom: every drawn box still has an Outline row',
  z.rows === z.boxes && z.rows > 0, JSON.stringify(z));
check('400% page zoom: no sideways body scroll (WCAG 1.4.10)', !z.bodyHScroll);
check('400% page zoom: no page errors', zerrors.length === 0, zerrors.join(' | '));
// The known bad state, pinned so that FIXING it fails this line and forces the
// escalation to be closed rather than quietly outlived.
check('400% page zoom: the fact column has no height — PRE-EXISTING, `73` §14',
  z.colH === 0 && z.touching === 0,
  'colH ' + z.colH + ', rows touching ' + z.touching +
  ' — if this now passes rows on screen, the shell bug is fixed: close the ' +
  'escalation in `73` §14 and turn this into a positive assertion');
await zoomed.close();

// --- the estate changes under the view ----------------------------------------
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForSelector('.dcanvas svg');
// 2026-09-05: rung 1 now folds the zones into their device (dgFoldInside, `57`
// §2), so a Zone has no level-1 row until `show what is inside` is pressed.
// Pressed here, once the width is back to wide (the control is hidden while
// the narrow picture is collapsed), so the removal below is measured on the
// picture this section was written against.
await page.click('[data-inside][aria-pressed="false"]');
await page.waitForSelector('.dcanvas svg');
const before = await page.$$eval('.dbox', n => n.length);
const zoneId = await page.evaluate(() => {
  const r = Array.from(document.querySelectorAll('[data-drow]'))
    .find(x => x.querySelector('.dokind').textContent === 'Zone');
  return r ? r.getAttribute('data-drow') : null;
});
await page.click('[data-drow="' + zoneId + '"]');
await page.click('[data-remove]');
await page.click('[data-view="diagram"]');
await page.waitForSelector('.dcanvas svg');
const after = await page.$$eval('.dbox', n => n.length);
check('removing an element redraws the picture with one box fewer',
  after === before - 1, before + ' -> ' + after);
check('the Outline followed', (await page.$$eval('[data-drow]', n => n.length)) === after);
check('the ring is not left pointing at something that is gone',
  await page.$eval('.dring', r => r.getAttribute('visibility')) === 'hidden');
check('still no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const bad = results.filter(r => !r).length;
console.log('\n' + (results.length - bad) + '/' + results.length + ' checks pass');
process.exit(bad ? 1 : 0);
