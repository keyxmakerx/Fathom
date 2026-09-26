// Drives the Print panel through the real App: prints each sheet kind to a
// real PDF, checks its page count against the title blocks' own "x of y".
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pw = await import(
  process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js'
);
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CLIENT = ROOT + '/client';
const DRIVE_LIB = ROOT + '/scripts/drive-lib';
const PORT = 5333;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });
const DOWNLOAD_DIR = join(tmpdir(), `fathom-print-downloads-${process.pid}`);
mkdirSync(DOWNLOAD_DIR, { recursive: true });

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

const fails = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) fails.push(name);
}

/** How many real pages a PDF has, two ways that must agree: `byTypePage`
 * counts leaf `/Type /Page` objects; `byCount` follows Catalog to its Pages object's own `/Count`. */
function countPdfPages(buffer) {
  const text = buffer.toString('latin1');
  const typePageMatches = text.match(/\/Type\s*\/Page(?!s)/g) ?? [];
  const catalogMatch = /\/Type\s*\/Catalog[\s\S]{0,200}?\/Pages\s+(\d+)\s+0\s+R/.exec(text);
  let byCount = null;
  if (catalogMatch) {
    const objRe = new RegExp(`(?:^|[^0-9])${catalogMatch[1]}\\s+0\\s+obj([\\s\\S]*?)endobj`);
    const objMatch = objRe.exec(text);
    const countMatch = objMatch ? /\/Count\s+(\d+)/.exec(objMatch[1]) : null;
    if (countMatch) byCount = Number(countMatch[1]);
  }
  return { byTypePage: typePageMatches.length, byCount };
}

const WASM_ARTIFACT = CLIENT + '/public/engine/fathom_wasm.wasm';
if (!existsSync(WASM_ARTIFACT)) {
  console.log('==> building the wasm artefact (missing): bash scripts/build-wasm.sh');
  execFileSync('bash', [ROOT + '/scripts/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
check('the wasm artefact exists', existsSync(WASM_ARTIFACT), WASM_ARTIFACT);

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
    <title>Fathom drive preview (not shipped)</title>
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

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Opens the print panel afresh on a clean load — no leftover choice from
 * one case can bleed into the next. */
async function openPanel(page, scene = 'print') {
  await page.goto(`${BASE}/drive.html?scene=${scene}`);
  // The first navigation of a run pays Vite's own cold dependency
  // pre-bundle; every later one in this same run is warm and fast.
  await page.waitForSelector('.react-flow__node-rack', { timeout: 45_000 });
  await page.locator('[data-testid="shell-print"]').click();
  await page.waitForSelector('[data-testid="print-panel"]', { timeout: 10_000 });
}

/** The real layout, on every page: no `.print-page__content` and no table
 * cell inside a `.print-page` scrolls (1px slack for rounding). */
async function checkNoOverflow(page, label) {
  const bad = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.print-page__content').forEach((el, i) => {
      if (el.scrollHeight > el.clientHeight + 1) out.push(`content ${i} scrollHeight ${el.scrollHeight}>${el.clientHeight}`);
      if (el.scrollWidth > el.clientWidth + 1) out.push(`content ${i} scrollWidth ${el.scrollWidth}>${el.clientWidth}`);
    });
    document.querySelectorAll('.print-page .print-table td, .print-page .print-table th').forEach((el, i) => {
      if (el.scrollHeight > el.clientHeight + 1) out.push(`cell ${i} scrollHeight ${el.scrollHeight}>${el.clientHeight} "${(el.textContent || '').slice(0, 24)}"`);
      if (el.scrollWidth > el.clientWidth + 1) out.push(`cell ${i} scrollWidth ${el.scrollWidth}>${el.clientWidth} "${(el.textContent || '').slice(0, 24)}"`);
    });
    return out;
  });
  check(`${label}: nothing clips on any page (scrollHeight<=clientHeight, scrollWidth<=clientWidth)`, bad.length === 0, bad.slice(0, 5).join(' | '));
}

/** Every device box's own real SVG geometry: a name/model's getBBox stays
 * inside it, a glyph's getBBox stays inside it, and text never meets a glyph. */
async function checkFaceplateGeometry(page, label) {
  const bad = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.print-elevation__box').forEach((boxEl, bi) => {
      const w = boxEl.width.baseVal.value;
      const h = boxEl.height.baseVal.value;
      const kids = [...boxEl.parentElement.querySelectorAll('.print-elevation__name, .print-elevation__model, .print-elevation__port')];
      const boxed = kids.map((el) => ({ el, b: el.getBBox() }));
      for (const { el, b } of boxed) {
        if (b.x < -0.05 || b.y < -0.05 || b.x + b.width > w + 0.05 || b.y + b.height > h + 0.05) {
          out.push(`box ${bi} ${el.getAttribute('class')} outside (${b.x.toFixed(2)},${b.y.toFixed(2)},${b.width.toFixed(2)},${b.height.toFixed(2)}) vs ${w.toFixed(2)}x${h.toFixed(2)}`);
        }
      }
      const texts = boxed.filter(({ el }) => el.classList.contains('print-elevation__name') || el.classList.contains('print-elevation__model'));
      const glyphs = boxed.filter(({ el }) => el.classList.contains('print-elevation__port'));
      for (const t of texts) {
        for (const g of glyphs) {
          const overlap = t.b.x < g.b.x + g.b.width && t.b.x + t.b.width > g.b.x && t.b.y < g.b.y + g.b.height && t.b.y + t.b.height > g.b.y;
          if (overlap) out.push(`box ${bi}: ${t.el.textContent} meets a glyph`);
        }
      }
    });
    return out;
  });
  check(`${label}: every name/model/glyph stays inside its own device box, text never meets a glyph`, bad.length === 0, bad.slice(0, 6).join(' | '));
}

async function choosePaper(page, paper) {
  await page.locator(`[data-testid="print-paper-${paper.toLowerCase()}"]`).click();
}

async function chooseWhat(page, what) {
  await page.locator(`[data-testid="print-what-${what}"]`).click();
}

/** Clicks the panel's own Print button, waits for the preview, and reads
 * every page's own "page X of Y". */
async function toPreviewAndReadTitleBlocks(page) {
  await page.locator('[data-testid="print-panel-print"]').click();
  await page.waitForSelector('[data-testid="print-preview"]', { timeout: 10_000 });
  const domPageCount = await page.locator('[data-testid="print-page"]').count();
  const ofTexts = await page.locator('[data-testid="print-page-of"]').allInnerTexts();
  const pairs = ofTexts.map((t) => {
    const m = /^(\d+)\s+of\s+(\d+)$/.exec(t.trim());
    return m ? { page: Number(m[1]), of: Number(m[2]) } : null;
  });
  return { domPageCount, pairs };
}

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
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // -------------------------------------------------------------------------
  // P-01 — the panel itself: opens from the Print chip, names which rack
  // it will print, offers paper/cables/options.
  // -------------------------------------------------------------------------
  await openPanel(page);
  const panelText = await page.locator('[data-testid="print-panel"]').innerText();
  check('the panel names the rack it will print ("This rack")', panelText.includes('This rack'));
  check('the panel offers "Every rack in this closet"', panelText.includes('Every rack in this closet'));
  check('the panel offers "The cut sheet"', panelText.includes('The cut sheet'));
  check('the panel offers A4 and Letter', panelText.includes('A4') && panelText.includes('Letter'));
  await page.screenshot({ path: SHOTS + 'P-01-panel.png' });
  console.log('    wrote ' + SHOTS + 'P-01-panel.png');

  // Ctrl+P opens the same panel — reload fresh, prove the shortcut, then
  // close it before the real per-case loop below starts its own opens.
  await page.goto(`${BASE}/drive.html?scene=print`);
  await page.waitForSelector('.react-flow__node-rack', { timeout: 20_000 });
  await page.keyboard.press('Control+p');
  const opensViaCtrlP = await page.locator('[data-testid="print-panel"]').count();
  check('Ctrl+P opens the panel', opensViaCtrlP > 0);
  if (opensViaCtrlP > 0) await page.locator('[data-testid="print-panel-cancel"]').click();

  // -------------------------------------------------------------------------
  // The real cases: this rack, the whole closet, the cut sheet — A4 and Letter.
  // -------------------------------------------------------------------------
  const cases = [
    { what: 'this-rack', cables: 'all', label: 'the 42U rack, cables all' },
    { what: 'closet', cables: 'none', label: 'every rack in the closet (six racks)' },
    { what: 'cut-sheet', cables: null, label: 'the cut sheet' },
  ];

  for (const paper of ['A4', 'Letter']) {
    for (const kase of cases) {
      await openPanel(page);
      await choosePaper(page, paper);
      await chooseWhat(page, kase.what);
      if (kase.cables) await page.locator(`[data-testid="print-cables-${kase.cables}"]`).click();

      if (kase.what === 'cut-sheet' && paper === 'A4') {
        // Downloads: exercised once — paper does not change the file.
        const [xlsxDownload] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('[data-testid="print-download-xlsx"]').click(),
        ]);
        const xlsxPath = join(DOWNLOAD_DIR, 'cut-sheet.xlsx');
        await xlsxDownload.saveAs(xlsxPath);
        const xlsxBytes = readFileSync(xlsxPath);
        check('the .xlsx download starts with a zip signature (PK)', xlsxBytes[0] === 0x50 && xlsxBytes[1] === 0x4b);
        check(
          'the .xlsx download carries the worksheet part',
          xlsxBytes.toString('latin1').includes('xl/worksheets/sheet1.xml'),
        );

        const [csvDownload] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('[data-testid="print-download-csv"]').click(),
        ]);
        const csvPath = join(DOWNLOAD_DIR, 'cut-sheet.csv');
        await csvDownload.saveAs(csvPath);
        const csvBytes = readFileSync(csvPath);
        check(
          'the .csv download opens with a UTF-8 BOM',
          csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
        );
        check('the .csv download carries the column header row', csvBytes.toString('utf8').includes('Device,Model,Placement'));
      }

      const { domPageCount, pairs } = await toPreviewAndReadTitleBlocks(page);
      const label = `${kase.label} · ${paper}`;
      check(`${label}: the preview shows at least one page`, domPageCount > 0, `${domPageCount} pages`);
      if (paper === 'A4') {
        // This scene's design sits directly in one scope ("Drive network")
        // — the title block must name it once, not as its own path too.
        const design = await page.locator('.print-title-block__design').first().innerText();
        const path = await page.locator('.print-title-block__path').first().innerText();
        check(`${label}: the title block names the design once, not twice as its own path`, path.trim() !== design.trim(), `design="${design}" path="${path}"`);
      }
      check(`${label}: every title block agrees on "of"`, pairs.every((p) => p && p.of === pairs[0]?.of), JSON.stringify(pairs));
      const declaredOf = pairs[0]?.of ?? -1;
      check(`${label}: "of" equals the number of pages actually shown`, declaredOf === domPageCount, `declared ${declaredOf}, shown ${domPageCount}`);
      check(
        `${label}: page numbers run 1..of in order`,
        pairs.every((p, i) => p && p.page === i + 1),
        JSON.stringify(pairs),
      );

      await checkNoOverflow(page, label);
      if (kase.what === 'this-rack') await checkFaceplateGeometry(page, label);

      const pdfBuffer = await page.pdf({ format: paper, printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
      const { byTypePage, byCount } = countPdfPages(pdfBuffer);
      check(`${label}: the real PDF's own page objects agree with its own /Count`, byTypePage === byCount, `/Type/Page=${byTypePage} /Count=${byCount}`);
      check(
        `${label}: the real PDF's page count matches the title block's "of y" — must fail when they differ`,
        byTypePage === declaredOf,
        `pdf pages=${byTypePage}, title block "of"=${declaredOf}`,
      );

      // The preview scrolls internally, so one shot at the top and one
      // scrolled to the end cover the whole job.
      await page.screenshot({ path: SHOTS + `P-02-${kase.what}-${paper}-top.png` });
      await page.evaluate(() => document.querySelector('[data-testid="print-preview"]')?.scrollTo(0, 1e9));
      await page.waitForTimeout(100);
      await page.screenshot({ path: SHOTS + `P-02-${kase.what}-${paper}-end.png` });
      console.log('    wrote ' + SHOTS + `P-02-${kase.what}-${paper}-{top,end}.png`);

      await page.locator('[data-testid="print-preview-close"]').click();
    }
  }

  // -------------------------------------------------------------------------
  // The Loft scene: a real mixed-vendor rack, for the owner's own look
  // against the board — with and without "leave out serials".
  // -------------------------------------------------------------------------
  for (const hideSensitive of [false, true]) {
    await openPanel(page, 'print-loft');
    await choosePaper(page, 'A4');
    await chooseWhat(page, 'this-rack');
    await page.locator('[data-testid="print-cables-all"]').click();
    if (hideSensitive) await page.locator('[data-testid="print-hide-sensitive"]').click();
    const label = `loft scene${hideSensitive ? ', serials left out' : ''}`;
    await toPreviewAndReadTitleBlocks(page);
    await checkNoOverflow(page, label);

    const glyphCount = await page.locator('.print-elevation__port').count();
    check(`${label}: every device's own ports draw a glyph`, glyphCount > 0, `${glyphCount} glyphs`);
    const hatchCount = await page.locator('[data-testid^="print-elevation-"][data-testid$="-empty"]').count();
    check(`${label}: the empty units between devices are hatched`, hatchCount > 0, `${hatchCount} hatched rows`);
    const unitFront = await page.locator('[data-testid="print-elevation-front"] .print-elevation__unit').count();
    check(`${label}: unit numbers run down both sides of the frame`, unitFront === 24 * 2, `${unitFront} labels`);
    const heading = await page.locator('.print-page__header-detail').first().innerText();
    check(`${label}: the heading names the U count and device count`, heading.includes('24U') && heading.includes('8 device'), heading);
    const title = await page.locator('.print-page__header-title').first().innerText();
    check(`${label}: the heading names the closet, "Rack R1 · Loft"`, title === 'Rack R1 · Loft', title);

    await checkFaceplateGeometry(page, label);

    // Three of this scene's own five cables cross from a front port to a
    // rear one (the servers/NAS to sw-core) — drawn on neither face.
    const frontCableCount = await page.locator('[data-testid="print-elevation-front"] .print-elevation__cable').count();
    const rearCableCount = await page.locator('[data-testid="print-elevation-rear"] .print-elevation__cable').count();
    check(`${label}: only same-face cables draw as arcs`, frontCableCount === 2 && rearCableCount === 0, `front ${frontCableCount}, rear ${rearCableCount}`);

    const anchorMiss = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.print-elevation__cable').forEach((path) => {
        const len = path.getTotalLength();
        const ctm = path.getScreenCTM();
        for (const p of [path.getPointAtLength(0), path.getPointAtLength(len)]) {
          const screen = p.matrixTransform(ctm);
          const hit = [...document.querySelectorAll('.print-elevation__port')].some((g) => {
            const b = g.getBoundingClientRect();
            return screen.x >= b.left - 1 && screen.x <= b.right + 1 && screen.y >= b.top - 1 && screen.y <= b.bottom + 1;
          });
          if (!hit) bad.push(`(${screen.x.toFixed(1)},${screen.y.toFixed(1)})`);
        }
      });
      return bad;
    });
    check(`${label}: every drawn cable starts and ends on a port glyph`, anchorMiss.length === 0, anchorMiss.slice(0, 5).join(' '));
    const cablesNoteText = await page.locator('[data-testid="print-page"] .print-cables-note').first().innerText();
    check(`${label}: the "Cables:" list still names all five, drawn or not`, cablesNoteText.includes('all · 5'), cablesNoteText.slice(0, 40));

    const tableText = await page.locator('[data-testid="print-rack-device-table"]').first().innerText();
    check(
      `${label}: a real serial shows exactly when serials are not left out`,
      tableText.includes('CTAZ2609J001') === !hideSensitive,
      tableText.slice(0, 120),
    );

    await page.screenshot({ path: SHOTS + `P-04-loft${hideSensitive ? '-hidden' : ''}-top.png` });
    console.log('    wrote ' + SHOTS + `P-04-loft${hideSensitive ? '-hidden' : ''}-top.png`);
    await page.locator('[data-testid="print-preview-close"]').click();
  }

  // -------------------------------------------------------------------------
  // Nothing behind the preview may take a key or focus: Delete/Backspace/
  // Ctrl+Z/Ctrl+Y/Ctrl+K must all stay swallowed, and Escape must still work.
  // -------------------------------------------------------------------------
  await page.goto(`${BASE}/drive.html?scene=print`);
  await page.waitForSelector('.react-flow__node-rack', { timeout: 20_000 });
  await page.locator('.react-flow__node-chassis').first().click();
  await page.waitForTimeout(200);
  const chassisCountBefore = await page.locator('.react-flow__node-chassis').count();

  await page.locator('[data-testid="shell-print"]').click();
  await page.locator('[data-testid="print-panel-print"]').click();
  await page.waitForSelector('[data-testid="print-preview"]', { timeout: 10_000 });
  const saveCountBefore = await page.evaluate(() => window.__saveCount__);

  for (const combo of ['Delete', 'Backspace', 'Control+z', 'Control+y', 'Control+k']) {
    await page.keyboard.press(combo);
    await page.waitForTimeout(150);
  }

  const stillOpen = (await page.locator('[data-testid="print-preview"]').count()) > 0;
  check('the preview stays open through Delete/Backspace/Ctrl+Z/Ctrl+Y/Ctrl+K', stillOpen);
  const activeClass = await page.evaluate(() => document.activeElement?.className ?? '');
  check('Ctrl+K under the preview did not focus the search box behind it', !activeClass.includes('shell-search'), activeClass);

  let escapeClosed = true;
  try {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="print-preview"]', { state: 'detached', timeout: 5_000 });
  } catch {
    escapeClosed = false;
  }
  check('Escape still closes the preview after those keys', escapeClosed);

  const chassisCountAfter = await page.locator('.react-flow__node-chassis').count();
  check('the design is unchanged — no key under the preview deleted or undid anything', chassisCountAfter === chassisCountBefore, `${chassisCountBefore} -> ${chassisCountAfter}`);
  const saveCountAfter = await page.evaluate(() => window.__saveCount__);
  check('nothing was saved while the preview was open', saveCountAfter === saveCountBefore, `${saveCountBefore} -> ${saveCountAfter}`);

  // -------------------------------------------------------------------------
  // Opening and closing the preview leaves the drawing behind it exactly as
  // it was: zoom, pan, the selection and its open editor panel.
  // -------------------------------------------------------------------------
  await page.goto(`${BASE}/drive.html?scene=print`);
  await page.waitForSelector('.react-flow__node-rack', { timeout: 20_000 });
  await page.locator('.react-flow__node-chassis').first().click();
  await page.waitForTimeout(200);
  await page.locator('[aria-label="Zoom in"]').click();
  await page.locator('[aria-label="Zoom in"]').click();
  const pane = await page.locator('.react-flow__pane').boundingBox();
  if (pane) {
    const cx = pane.x + pane.width / 2;
    const cy = pane.y + pane.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 25, { steps: 6 });
    await page.mouse.up();
  }
  await page.waitForTimeout(200);
  // A short timeout and a caught failure, not Playwright's own 30s default
  // — a missing panel fails this named check instead of hanging the run.
  async function readOrMissing(locator) {
    try {
      return await locator.innerText({ timeout: 2_000 });
    } catch {
      return null;
    }
  }
  const zoomBefore = await readOrMissing(page.locator('.shell-zoom-value'));
  const transformBefore = await page.locator('.react-flow__viewport').getAttribute('style');
  const editorBefore = await readOrMissing(page.locator('.drawing-editor__panel'));

  await page.locator('[data-testid="shell-print"]').click();
  await page.locator('[data-testid="print-panel-print"]').click();
  await page.waitForSelector('[data-testid="print-preview"]', { timeout: 10_000 });
  await page.locator('[data-testid="print-preview-close"]').click();
  await page.waitForSelector('[data-testid="print-preview"]', { state: 'detached', timeout: 5_000 });

  const zoomAfter = await readOrMissing(page.locator('.shell-zoom-value'));
  const transformAfter = await page.locator('.react-flow__viewport').getAttribute('style');
  const editorAfter = await readOrMissing(page.locator('.drawing-editor__panel'));
  check('the preview does not disturb zoom', zoomBefore != null && zoomAfter === zoomBefore, `${zoomBefore} -> ${zoomAfter}`);
  check('the preview does not disturb pan', transformAfter === transformBefore, `${transformBefore} -> ${transformAfter}`);
  check(
    'the preview does not disturb the open editor / selection',
    editorBefore != null && editorAfter === editorBefore,
    `before=${editorBefore?.slice(0, 40) ?? 'MISSING'} after=${editorAfter?.slice(0, 40) ?? 'MISSING'}`,
  );

  // -------------------------------------------------------------------------
  // The attack scene: 50-character FQDN hostnames, a long cable label and
  // many VLANs — real long values, and a job of more than 8 pages.
  // -------------------------------------------------------------------------
  const attackCases = [
    { what: 'this-rack', cables: 'all', label: 'attack scene: the rack, cables all' },
    { what: 'cut-sheet', cables: null, label: 'attack scene: the cut sheet' },
  ];

  for (const kase of attackCases) {
    await openPanel(page, 'print-attack');
    await choosePaper(page, 'A4');
    await chooseWhat(page, kase.what);
    if (kase.cables) await page.locator(`[data-testid="print-cables-${kase.cables}"]`).click();

    const { domPageCount, pairs } = await toPreviewAndReadTitleBlocks(page);
    check(`${kase.label}: the preview shows at least one page`, domPageCount > 0, `${domPageCount} pages`);
    const declaredOf = pairs[0]?.of ?? -1;
    check(`${kase.label}: "of" equals the number of pages actually shown`, declaredOf === domPageCount, `declared ${declaredOf}, shown ${domPageCount}`);

    await checkNoOverflow(page, kase.label);

    if (kase.what === 'this-rack') {
      // The measuring pass must use the same column widths the printed
      // table does, or a long hostname reflows the row a different height.
      const rowHeights = await page.evaluate(() => ({
        measured: document.querySelector('.print-measure [data-row-id="0:r0"]')?.getBoundingClientRect().height ?? null,
        printed: document.querySelector('[data-testid="print-rack-device-table"] tbody tr')?.getBoundingClientRect().height ?? null,
      }));
      check(
        `${kase.label}: a measured rack-table row equals the printed one within 1px`,
        rowHeights.measured != null && rowHeights.printed != null && Math.abs(rowHeights.measured - rowHeights.printed) <= 1,
        JSON.stringify(rowHeights),
      );
    }

    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    const { byTypePage, byCount } = countPdfPages(pdfBuffer);
    check(`${kase.label}: the real PDF's own page objects agree with its own /Count`, byTypePage === byCount, `/Type/Page=${byTypePage} /Count=${byCount}`);
    check(
      `${kase.label}: the real PDF's page count matches the title block's "of y"`,
      byTypePage === declaredOf,
      `pdf pages=${byTypePage}, title block "of"=${declaredOf}`,
    );

    await page.screenshot({ path: SHOTS + `P-03-attack-${kase.what}-top.png` });
    await page.evaluate(() => document.querySelector('[data-testid="print-preview"]')?.scrollTo(0, 1e9));
    await page.waitForTimeout(100);
    await page.screenshot({ path: SHOTS + `P-03-attack-${kase.what}-end.png` });
    console.log('    wrote ' + SHOTS + `P-03-attack-${kase.what}-{top,end}.png`);

    if (kase.what === 'cut-sheet') {
      // Past 8 pages Chromium nests /Pages containers with their own smaller
      // /Count — this proves the job is big enough to exercise that path.
      check('attack scene: the cut sheet takes more than 8 pages, so the /Count fix is tested for real', declaredOf > 8, `${declaredOf} pages`);
    }

    await page.locator('[data-testid="print-preview-close"]').click();
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  browser = null;
} catch (error) {
  check('the drive completed without throwing', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (viteProc) {
    viteProc.kill();
    try { execFileSync('fuser', ['-k', `${PORT}/tcp`]); } catch { /* nothing was listening */ }
  }
  for (const f of [PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE]) {
    if (existsSync(f)) rmSync(f);
  }
  rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  check('drive.html removed', !existsSync(PREVIEW_HTML));
  check('drive.tsx removed', !existsSync(PREVIEW_TSX));
  check('drive-seed.ts removed', !existsSync(PREVIEW_SEED));
  check('drive-catalogue.json removed', !existsSync(PREVIEW_CATALOGUE));
}

console.log(fails.length ? '\nFAILURES:\n  ' + fails.join('\n  ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
