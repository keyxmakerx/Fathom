// Drives the Print panel (GitHub issue #39) through the real App: the
// panel opens, prints each sheet kind to a real PDF (Playwright's
// page.pdf, Chromium) on both A4 and Letter, and every real PDF page count
// is checked against the "x of y" its own title blocks print — the check
// fails when they differ. Also downloads the cut sheet as .xlsx and .csv.
// Usage: bash scripts/build-wasm.sh (if stale), then
//   flock <lock> node scripts/drive-print.mjs
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

/** How many real pages a Chromium-produced PDF actually has — counted off
 * the document's own `/Type /Page` objects (never `/Type /Pages`, the
 * parent). Chromium's `page.pdf()` writes these as plain, uncompressed
 * objects (verified empirically against this same build: no `/ObjStm`, no
 * compressed cross-reference stream), so a byte-level regex count and the
 * Pages object's own `/Count` agree — this checks both and refuses to
 * trust either alone. */
function countPdfPages(buffer) {
  const text = buffer.toString('latin1');
  const typePageMatches = text.match(/\/Type\s*\/Page(?!s)/g) ?? [];
  const countMatch = /\/Count\s+(\d+)/.exec(text);
  const declaredCount = countMatch ? Number(countMatch[1]) : null;
  return { byTypePage: typePageMatches.length, byCount: declaredCount };
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

/** Opens the print panel afresh, from the Racks place, on a clean load —
 * every case below starts here rather than closing and reopening the
 * panel, so one case's leftover choice can never bleed into the next. */
async function openPanel(page) {
  await page.goto(`${BASE}/drive.html?scene=print`);
  // The first navigation of a run pays Vite's own cold dependency
  // pre-bundle; every later one in this same run is warm and fast.
  await page.waitForSelector('.react-flow__node-rack', { timeout: 45_000 });
  await page.locator('[data-testid="shell-print"]').click();
  await page.waitForSelector('[data-testid="print-panel"]', { timeout: 10_000 });
}

async function choosePaper(page, paper) {
  await page.locator(`[data-testid="print-paper-${paper.toLowerCase()}"]`).click();
}

async function chooseWhat(page, what) {
  await page.locator(`[data-testid="print-what-${what}"]`).click();
}

/** Clicks the panel's own Print button, waits for the preview, and reads
 * every page's own "page X of Y" — this drive's one check that must fail
 * when it disagrees with the real PDF. */
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
  // The real cases: this rack (the 42U rack), every rack in the closet
  // (six racks), and the cut sheet — on A4 and on Letter, each printed to
  // a real PDF and checked against its own title blocks.
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
        // Downloads: exercised once (paper does not change the file) —
        // brief item 5.
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
      check(`${label}: every title block agrees on "of"`, pairs.every((p) => p && p.of === pairs[0]?.of), JSON.stringify(pairs));
      const declaredOf = pairs[0]?.of ?? -1;
      check(`${label}: "of" equals the number of pages actually shown`, declaredOf === domPageCount, `declared ${declaredOf}, shown ${domPageCount}`);
      check(
        `${label}: page numbers run 1..of in order`,
        pairs.every((p, i) => p && p.page === i + 1),
        JSON.stringify(pairs),
      );

      const pdfBuffer = await page.pdf({ format: paper, printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
      const { byTypePage, byCount } = countPdfPages(pdfBuffer);
      check(`${label}: the real PDF's own page objects agree with its own /Count`, byTypePage === byCount, `/Type/Page=${byTypePage} /Count=${byCount}`);
      check(
        `${label}: the real PDF's page count matches the title block's "of y" — must fail when they differ`,
        byTypePage === declaredOf,
        `pdf pages=${byTypePage}, title block "of"=${declaredOf}`,
      );

      // `.print-preview` scrolls internally (`position: fixed; inset: 0`),
      // so the DOCUMENT never grows past the viewport and `fullPage`
      // screenshots nothing extra — one shot at the top (the panel's own
      // choice and the first sheet), one scrolled to the very end (its
      // title block and "page N of N").
      await page.screenshot({ path: SHOTS + `P-02-${kase.what}-${paper}-top.png` });
      await page.evaluate(() => document.querySelector('[data-testid="print-preview"]')?.scrollTo(0, 1e9));
      await page.waitForTimeout(100);
      await page.screenshot({ path: SHOTS + `P-02-${kase.what}-${paper}-end.png` });
      console.log('    wrote ' + SHOTS + `P-02-${kase.what}-${paper}-{top,end}.png`);

      await page.locator('[data-testid="print-preview-close"]').click();
    }
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
