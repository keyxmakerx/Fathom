// Proves the phone field view (ADR-0075) against the real compiled client at a phone viewport.
// Usage: node scripts/drive-phone.mjs (FATHOM_SHOTS picks the screenshot dir)
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, fails, waitForServer } from './drive-lib/kit.mjs';

const pw = await import(
  process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js'
);
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM
  || '/opt/pw-browsers/chromium';
const CLIENT = ROOT + '/client';
const DRIVE_LIB = ROOT + '/scripts/drive-lib';
// Not shared with any other `scripts/drive-*.mjs` — `grep -h "PORT = "
// scripts/drive-*.mjs` before picking a new one.
const PORT = 18470;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

// Step 0: the wasm artefact.
const WASM_ARTIFACT = CLIENT + '/public/engine/fathom_wasm.wasm';
if (!existsSync(WASM_ARTIFACT)) {
  console.log('==> building the wasm artefact (missing): bash scripts/build-wasm.sh');
  execFileSync('bash', [ROOT + '/scripts/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
check('the wasm artefact exists', existsSync(WASM_ARTIFACT), WASM_ARTIFACT);

// Step 1: copy the shared throwaway harness into `client/`.
for (const f of [PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE]) {
  if (existsSync(f)) {
    console.error(`refusing to run: ${f} already exists (left from an earlier run?); remove it first`);
    process.exit(2);
  }
}
writeFileSync(
  PREVIEW_HTML,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fathom — ADR-0062 proof preview (throwaway, not shipped)</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/drive.tsx"></script>
  </body>
</html>
`,
);
mkdirSync(CLIENT + '/public', { recursive: true });
copyFileSync(DRIVE_LIB + '/harness.tsx', PREVIEW_TSX);
copyFileSync(DRIVE_LIB + '/seed.ts', PREVIEW_SEED);
copyFileSync(DRIVE_LIB + '/catalogue.json', PREVIEW_CATALOGUE);
check('drive.html written', existsSync(PREVIEW_HTML));
check('drive.tsx copied from drive-lib/harness.tsx', existsSync(PREVIEW_TSX));
check('drive-seed.ts copied from drive-lib/seed.ts', existsSync(PREVIEW_SEED));
check('drive-catalogue.json copied from drive-lib/catalogue.json', existsSync(PREVIEW_CATALOGUE));

let viteProc = null;
let browser = null;

try {
  console.log(`==> starting the client dev server on port ${PORT}`);
  viteProc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: CLIENT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let viteLog = '';
  viteProc.stdout.on('data', (d) => { viteLog += d.toString(); });
  viteProc.stderr.on('data', (d) => { viteLog += d.toString(); });
  const up = await waitForServer(`${BASE}/drive.html`, 30_000);
  check('client dev server answers /drive.html', up, up ? '' : viteLog.slice(-2000));
  if (!up) throw new Error('dev server did not come up');

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const pageErrors = [];
  const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('    console error: ' + m.text().slice(0, 300)); });
  const shot = async (name) => { await page.screenshot({ path: SHOTS + name }); console.log('    wrote ' + SHOTS + name); };
  const shown = (sel) => page.evaluate((q) => [...document.querySelectorAll(q)].some((e) => e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'), sel);

  // ---- A design opens on Find, with the three tabs ----
  await page.goto(`${BASE}/drive.html?scene=estate&scale=0.15&corrections=1&capability=steward`);
  await page.waitForSelector('.phone-tabs', { timeout: 240_000 });
  await page.waitForSelector('.inv-table__row', { timeout: 60_000 });
  const tabs = await page.locator('.phone-tabs button').allInnerTexts();
  check('phone: three tabs along the bottom', tabs.map((t) => t.toLowerCase()).join('|') === 'scan|find|canvas', tabs.join('|'));
  check('phone: the design opened on Find (the Inventory)', (await page.locator('.phone-tabs__tab--on').innerText()).toLowerCase() === 'find');
  check('phone: the view tabs in the bar are folded away', !(await shown('.shell-bar__tabs--views')));
  check('phone: the side panel strip is folded away', !(await shown('.dock-strip')));
  check('phone: Import, Paste, Columns and + Device are folded away', (await page.getByRole('button', { name: /Import file|Paste rows|Columns|\+ Device/i }).filter({ visible: true }).count()) === 0);
  check('phone: no tick boxes in the list', !(await shown('.inv-table__check')));
  const tabBox = await page.locator('.phone-tabs').boundingBox();
  const rootBox = await page.locator('#root').boundingBox();
  check('phone: the page stops above the tabs', rootBox.y + rootBox.height <= tabBox.y + 1, `${rootBox.y + rootBox.height} vs ${tabBox.y}`);
  check('phone: nothing scrolls sideways', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot('phone-01-find.png');

  // ---- Scan: the sheet, a label for this design, a serial, a stranger's link ----
  const cableIds = await page.evaluate(() => window.__cableIds__);
  const scanType = async (text) => {
    await page.locator('.phone-tabs button', { hasText: /scan/i }).click();
    await page.waitForSelector('.phone-scan', { timeout: 5_000 });
    await page.getByLabel('Or type the label or serial').fill(text);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
  };
  await page.locator('.phone-tabs button', { hasText: /scan/i }).click();
  await page.waitForSelector('.phone-scan', { timeout: 5_000 });
  await page.waitForFunction(() => !/Starting the camera/.test(document.querySelector('.phone-scan__say')?.textContent ?? ''), null, { timeout: 10_000 });
  const say = await page.locator('.phone-scan__say').innerText();
  check('scan: with no camera or reader the sheet says so in words', /can't read barcodes|No camera|not allowed/.test(say), say);
  await shot('phone-02-scan.png');
  await page.getByRole('button', { name: 'Close' }).click();
  check('scan: Close takes the sheet away', (await page.locator('.phone-scan').count()) === 0);

  const origin = new URL(BASE).origin;
  await scanType(`${origin}/scan#design-drive/${cableIds[0]}`);
  await page.waitForSelector('.inv-page', { timeout: 10_000 });
  check('scan: a label for this design opens its cable page', (await page.locator('.phone-scan').count()) === 0 && /THE RUN|the run/i.test(await page.locator('.inv-page').innerText()));
  check('scan: the address is the ordinary Inventory address', await page.evaluate((id) => decodeURIComponent(location.hash).includes(`o=cable:${id}`), cableIds[0]));
  check('scan: the cable page lists the corrections waiting, with Accept', /corrections waiting/i.test(await page.locator('.inv-corr').first().innerText()) && (await page.getByRole('button', { name: 'Accept' }).count()) > 0);
  check('scan: nothing scrolls sideways on the cable page', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot('phone-03-scanned-cable.png');

  await scanType('lon1-core1');
  await page.waitForFunction(() => decodeURIComponent(location.hash).includes('f=lon1-core1'), null, { timeout: 10_000 });
  check('scan: anything that is not a label is looked up in Find', true);
  await shot('phone-04-find-typed.png');

  await scanType(`https://elsewhere.example/scan#design-drive/${cableIds[0]}`);
  await page.waitForSelector('.phone-scan__message', { timeout: 5_000 });
  check('scan: a link that is not this Fathom is not followed', /not a label from this Fathom/.test(await page.locator('.phone-scan__message').innerText()));
  await page.getByRole('button', { name: 'Close' }).click();

  // ---- Canvas: to look at ----
  await page.locator('.phone-tabs button', { hasText: /canvas/i }).click();
  await page.waitForSelector('.drawing', { timeout: 60_000 });
  await page.waitForTimeout(800);
  check('canvas: the drawing tools are folded away', !(await shown('.shell-canvas-bar__group')));
  check('canvas: the bar says View only and Undo is off', (await page.getByText('View only').count()) > 0 && (await page.locator('.shell-pill [aria-label="Undo"]').isDisabled()));
  check('canvas: the minimap is folded away', !(await shown('.canvas-minimap')));
  await shot('phone-05-canvas.png');
  await context.close();

  // ---- An AI idea waiting shows as a fourth tab, opening full screen ----
  {
    const ctx = await browser.newContext(PHONE);
    const p3 = await ctx.newPage();
    p3.on('pageerror', (e) => pageErrors.push(e.message));
    await p3.addInitScript(() => {
      window.__aiIdeas__ = [{ id: 'idea-1', key: 'key-1', owner: 'o', ownerName: 'Drive User', title: 'Label both ends of the uplink', why: 'One end has no label.', steps: [{ action: 'note', target: null, text: 'Print two labels.' }], createdAt: 1, state: 'open', decidedBy: null, decidedAt: null, version: 1 }];
    });
    await p3.goto(`${BASE}/drive.html?scene=estate&scale=0.15&capability=steward`);
    await p3.waitForSelector('.phone-tabs', { timeout: 240_000 });
    const ideasTab = p3.locator('.phone-tabs button', { hasText: /ideas 1/i });
    await ideasTab.waitFor({ timeout: 20_000 }).catch(() => {});
    check('ideas: a waiting AI idea adds an Ideas tab', (await ideasTab.count()) === 1, (await p3.locator('.phone-tabs button').allInnerTexts()).join('|'));
    if ((await ideasTab.count()) === 1) {
      await ideasTab.click();
      const sheet = p3.getByRole('dialog', { name: 'AI ideas' });
      await sheet.waitFor({ timeout: 10_000 });
      check('ideas: the sheet shows the idea', (await sheet.innerText()).includes('Label both ends of the uplink'));
      await p3.screenshot({ path: SHOTS + 'phone-06-ideas.png' });
      await sheet.getByRole('button', { name: 'Close' }).first().click();
      check('ideas: Close takes the sheet away', (await sheet.count()) === 0);
    }
    await ctx.close();
  }

  // ---- The owner, 2026-11-01: after a plan, the tabs had gone and the bar ran off the right ----
  // A long plan name widened the page; the phone then zoomed out and stretched its layout viewport, so
  // the fixed tabs sat below the bottom of the screen. The bar's Doing, Share and Admin were clipped.
  {
    const ctx = await browser.newContext({ ...PHONE, viewport: { width: 1280, height: 844 } });
    const p4 = await ctx.newPage();
    p4.on('pageerror', (e) => pageErrors.push(e.message));
    const click = (sel, text) => p4.evaluate(([q, t]) => { const el = [...document.querySelectorAll(q)].find((e) => !t || new RegExp(t, 'i').test(e.textContent)); el?.click(); return el != null; }, [sel, text]);
    await p4.goto(`${BASE}/drive.html?scene=canvas&capability=steward`);
    await p4.waitForSelector('.drawing', { timeout: 240_000 });
    await click('[data-testid=shell-doing]');
    await click('[data-testid=doing-plan]');
    await click('.plans-btn', 'New plan');
    await p4.locator('.plans-new input').first().fill('Swap the core switch in rack A-04 for the new Juniper EX4400 before Friday');
    await p4.locator('.plans-new input').first().press('Enter');
    await p4.waitForSelector('[data-testid=shell-task]', { timeout: 10_000 });
    await p4.setViewportSize({ width: 390, height: 844 });
    await p4.waitForSelector('.phone-tabs', { timeout: 10_000 });
    await p4.waitForTimeout(500);
    const fits = () => p4.evaluate(() => {
      const bar = document.querySelector('.shell-bar');
      const tabs = document.querySelector('.phone-tabs').getBoundingClientRect();
      return { page: document.documentElement.scrollWidth, bar: bar.scrollWidth, tabsBottom: Math.round(tabs.bottom), scale: window.visualViewport.scale };
    });
    // Against the phone's own size: a page that widens also stretches innerWidth and innerHeight with it.
    const PHONE_SIZE = { width: 390, height: 844 };
    let f = { ...(await fits()), ...PHONE_SIZE };
    check('plan open on a phone: nothing scrolls sideways', f.page <= f.width + 1, JSON.stringify(f));
    check('plan open on a phone: the bar fits, with Exit in reach', f.bar <= f.width + 1 && (await p4.locator('[data-testid=shell-task-exit]').isVisible()), JSON.stringify(f));
    check('plan open on a phone: the tabs are on the screen', f.tabsBottom <= f.height + 1, JSON.stringify(f));
    await p4.screenshot({ path: SHOTS + 'phone-07-plan-open.png' });
    await p4.locator('[data-testid=shell-task-exit]').click();
    await p4.waitForTimeout(500);
    f = { ...(await fits()), ...PHONE_SIZE };
    check('after the plan: the tabs are still on the screen', f.tabsBottom <= f.height + 1 && f.page <= f.width + 1, JSON.stringify(f));
    check('after the plan: the bar fits', f.bar <= f.width + 1, JSON.stringify(f));
    await p4.locator('[data-testid=shell-more]').click();
    const rows = (await p4.locator('.shell-popover__row').allInnerTexts()).join('|');
    check('after the plan: Doing and Share are in More', /Plan a change/.test(rows) && /Share/.test(rows), rows);
    await p4.locator('[data-testid=doing-plan]').click();
    await p4.waitForSelector('[data-testid=plans-band-close]', { timeout: 5_000 });
    await p4.locator('[data-testid=plans-band-close]').click();
    check('the plans band with no plan open has a Close that puts it away', (await p4.locator('[data-testid=plans-band]').count()) === 0);
    await p4.screenshot({ path: SHOTS + 'phone-08-after-plan.png' });
    await ctx.close();
  }

  // ---- A computer is unchanged ----
  {
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await desk.newPage();
    p2.on('pageerror', (e) => pageErrors.push(e.message));
    await p2.goto(`${BASE}/drive.html?scene=estate&scale=0.15&capability=steward`);
    await p2.waitForSelector('.drawing', { timeout: 240_000 });
    check('desk: a design still opens on the canvas', (await p2.locator('.drawing').count()) > 0);
    check('desk: no phone tabs', (await p2.locator('.phone-tabs').count()) === 0);

    // Print labels from ticked rows: cables get one label per end.
    await p2.locator('.shell-bar__tab', { hasText: /^Inventory$/i }).first().click();
    await p2.waitForSelector('.inv-table__row', { timeout: 60_000 });
    await p2.evaluate(() => { window.location.hash = 'inventory?k=cables'; });
    await p2.waitForTimeout(800);
    const boxes = p2.locator('.inv-table__row .inv-table__check input[type=checkbox]');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await p2.getByRole('button', { name: 'Print labels' }).click();
    await p2.waitForSelector('.labels-preview', { timeout: 5_000 });
    check('labels: two cables give four labels', (await p2.locator('.labels-preview .label').count()) === 4, String(await p2.locator('.labels-preview .label').count()));
    check('labels: cables default to a wrap, one a page, with the name and no code', (await p2.locator('.labels-page').count()) === 4 && (await p2.locator('.labels-preview .label--wrap').count()) === 4 && (await p2.locator('.labels-preview .label svg').count()) === 0);
    await p2.screenshot({ path: SHOTS + 'labels-00-wrap.png' });
    await p2.locator('.labels-preview select').first().selectOption('flag-24');
    check('labels: a flag carries the code on both faces', (await p2.locator('.labels-preview .label--flag svg path').count()) === 8);
    await p2.screenshot({ path: SHOTS + 'labels-00-flag.png' });
    await p2.locator('.labels-preview select').first().selectOption('tze-24');
    check('labels: each tape label carries a drawn code', (await p2.locator('.labels-preview .label svg path').count()) === 4);
    check('labels: 24 mm P-touch tape is one label a page', (await p2.locator('.labels-page').count()) === 4);
    await p2.screenshot({ path: SHOTS + 'labels-01-tape.png' });
    await p2.locator('.labels-preview select').first().selectOption('a4');
    check('labels: A4 puts all four on one sheet', (await p2.locator('.labels-page').count()) === 1);
    await p2.screenshot({ path: SHOTS + 'labels-02-a4.png' });
    await p2.emulateMedia({ media: 'print' });
    check('labels: printing shows only the labels', !(await p2.evaluate(() => { const r = document.getElementById('root'); return r && getComputedStyle(r).display !== 'none'; })) && (await p2.locator('.labels-preview__bar').isHidden()));
    await p2.screenshot({ path: SHOTS + 'labels-03-print.png' });
    await p2.emulateMedia({ media: 'screen' });
    await p2.getByRole('button', { name: 'Close' }).click();
    check('labels: Close takes the preview away', (await p2.locator('.labels-preview').count()) === 0);
    await desk.close();
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close();
  browser = null;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (viteProc) {
    viteProc.kill();
    try { execFileSync('fuser', ['-k', `${PORT}/tcp`]); } catch { /* nothing was listening */ }
  }
  for (const f of [PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE]) {
    if (existsSync(f)) rmSync(f);
  }
  check('drive.html removed', !existsSync(PREVIEW_HTML));
  check('drive.tsx removed', !existsSync(PREVIEW_TSX));
  check('drive-seed.ts removed', !existsSync(PREVIEW_SEED));
  check('drive-catalogue.json removed', !existsSync(PREVIEW_CATALOGUE));
}

console.log(fails.length ? '\nFAILURES:\n  ' + fails.join('\n  ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
