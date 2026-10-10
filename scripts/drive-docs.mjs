// Proves docs (ADR-0061 round 7) end to end against the real compiled client: a doc on a
// model shows on that model's device and not another, a design-wide doc is in the Docs list, a
// paste goes through the gate (a real-length Junos key is destroyed before the save), a link
// shows its host and refuses javascript:, a reader sees docs and cannot change them, and every
// saved payload loads through the engine.
//
// Usage:
//   bash scripts/build-wasm.sh   # once, if the artefact is stale
//   node scripts/drive-docs.mjs
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
// Playwright is not a repo dependency (ADR-0032 gate zero) — reached by
// absolute path, like every other `scripts/drive-*`.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { barAction } from './drive-lib/bar.mjs';

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
// Not shared with any other `scripts/drive-*.mjs` — `grep -h "PORT = "
// scripts/drive-*.mjs` before picking a new one.
const PORT = 18331;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

const fails = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) fails.push(name);
}

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
    <title>Fathom — docs proof preview (throwaway, not shipped)</title>
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

/** Dispatches a real `click` on the one `[data-cable-id]` element in the
 * scene — `CableEdge.tsx`'s own selection handler, reached this way rather
 * than a geometric `page.click` because the SVG path's bounding box is not
 * reliably over its own stroke. The same "dispatch straight at the DOM
 * node" technique `drive-hand-entry.mjs` already uses for its drag-and-drop. */
async function clickTheCable(page) {
  return page.evaluate(() => {
    const g = document.querySelector('[data-cable-id]');
    if (!g) return false;
    g.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const SECRET_LINE = 'set security ike proposal IKE-PROP pre-shared-key ascii-text $9$EXAMPLEnotARealKey01234';
  const paste = (loc, text) =>
    loc.evaluate((el, t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);

  await page.goto(`${BASE}/drive.html?scene=tags`);
  await page.waitForSelector('.drawing', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-chassis').length === 2, null, { timeout: 15_000 });

  // 1 - a device's panel has a Docs line with "+ Add doc".
  await page.locator('.react-flow__node-chassis', { hasText: 'core-01' }).click();
  await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
  await page.getByRole('tab', { name: 'Notes' }).click();
  check('core-01 has a Docs line and "+ Add doc"', (await page.locator('[data-testid="docs-section"]').count()) === 1 && (await page.getByText('+ Add doc').count()) === 1);

  // 2 - a doc on the model, typed, with Markdown and a hostile line.
  await page.getByText('+ Add doc').click();
  await page.waitForSelector('.docs-overlay', { timeout: 5_000 });
  check('the dialog takes focus', await page.evaluate(() => document.activeElement?.classList.contains('docs-overlay')));
  await page.locator('.docs-overlay label:has-text("Every EX4300-48P") input').check();
  await page.locator('.docs-field:has-text("Title") input').fill('Upgrade runbook');
  await page.locator('.docs-field:has-text("Text") textarea').fill('# Steps\n\n- reboot **one** at a time\n\n<script>window.__xss=1</script>\n\n![t](https://evil.test/p.gif)');
  check('the typed-text sentence is shown', (await page.locator('.docs-overlay').innerText()).includes('does not redact what you type'));
  await page.screenshot({ path: SHOTS + 'docs-01-new.png' });
  await page.getByRole('button', { name: 'Save doc' }).click();
  await page.waitForSelector('.doc-md h2', { timeout: 5_000 });
  const pageText = await page.locator('.docs-overlay').innerText();
  check('the doc page shows the heading, the list and the model line', pageText.includes('Steps') && pageText.includes('reboot') && pageText.includes('on the model EX4300-48P'), pageText.slice(0, 200));
  check('raw HTML is text and nothing ran', (await page.locator('.docs-overlay script').count()) === 0 && (await page.evaluate(() => window.__xss === undefined)));
  check('no image is loaded', (await page.locator('.docs-overlay img').count()) === 0 && !(await page.evaluate(() => window.__requests__.some((r) => r.url.includes('evil.test')))));
  await page.screenshot({ path: SHOTS + 'docs-02-page.png' });

  // 3 - links: javascript: refused, https shows host and rel.
  await page.locator('input[aria-label="Link title"]').fill('Vendor guide');
  await page.locator('input[aria-label="Link address"]').fill('javascript:alert(1)');
  await page.getByRole('button', { name: '+ Add link' }).click();
  await page.waitForSelector('.docs-problem', { timeout: 5_000 });
  check('javascript: is refused with words', (await page.locator('.docs-problem').innerText()).includes('http'));
  await page.locator('input[aria-label="Link address"]').fill('https://docs.example.com/guide');
  await page.getByRole('button', { name: '+ Add link' }).click();
  await page.waitForSelector('.docs-links a', { timeout: 5_000 });
  const a = page.locator('.docs-links a').first();
  check('the link opens safely and shows its host', (await a.getAttribute('rel')) === 'noopener noreferrer' && (await a.getAttribute('target')) === '_blank' && (await page.locator('.docs-links__host').first().innerText()).includes('docs.example.com'));
  await page.screenshot({ path: SHOTS + 'docs-03-links.png' });

  // 4 - Esc closes; core-01 lists it on the model; acc-01 does not.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.docs-overlay'), null, { timeout: 5_000 });
  let section = await page.locator('[data-testid="docs-section"]').innerText();
  check('core-01 lists the doc, marked on the model', section.includes('Upgrade runbook') && section.includes('on the model'), section);
  await page.locator('.react-flow__node-chassis', { hasText: 'acc-01' }).click();
  await page.waitForTimeout(300);
  section = await page.locator('[data-testid="docs-section"]').innerText();
  check('acc-01 (another model) does not', !section.includes('Upgrade runbook'), section);

  // 5 - a pasted doc goes through the gate: the key never reaches the save.
  await page.getByText('+ Add doc').click();
  await page.waitForSelector('.docs-overlay');
  await page.locator('.docs-field:has-text("Title") input').fill('IKE notes');
  const ta = page.locator('.docs-field:has-text("Text") textarea');
  await paste(ta, SECRET_LINE);
  await ta.fill(SECRET_LINE);
  await page.getByRole('button', { name: 'Save doc' }).click();
  await page.waitForSelector('.doc-md', { timeout: 5_000 });
  const shown = await page.locator('.docs-overlay').innerText();
  check('the pasted key is shown as destroyed at the gate', shown.includes('destroyed at the gate') && !shown.includes('EXAMPLEnotARealKey'), shown.slice(0, 300));
  const saved = await page.evaluate(() => window.__requests__.filter((r) => r.method === 'POST').map((r) => r.bodyLatin1).join('\n'));
  check('no save carries the pasted key', !saved.includes('EXAMPLEnotARealKey01234'));
  await page.screenshot({ path: SHOTS + 'docs-04-gated.png' });

  // 5b - files: text goes through the gate before upload, an image says Not checked, a
  // download is the stored bytes, a refused type says so.
  const upload = (name, buffer) => page.setInputFiles('input[aria-label="Add a file"]', { name, mimeType: 'application/octet-stream', buffer });
  await upload('ike.conf', Buffer.from('set system host-name acc-01\n' + SECRET_LINE + '\n'));
  await page.waitForSelector('.docs-files__table tbody tr', { timeout: 5_000 });
  const upl = await page.evaluate(() => window.__uploads__);
  check('exactly one upload, and the key never left the browser', upl.length === 1 && !upl[0].includes('EXAMPLEnotARealKey01234') && upl[0].includes('host-name acc-01'), upl.join('|').slice(0, 200));
  check('the table says passwords were removed', /\d+ passwords? removed/.test(await page.locator('.docs-files__table').innerText()));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await upload('rack.png', png);
  await page.getByRole('button', { name: 'Add rack.png, it shows no passwords' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.docs-files__table tbody tr').length === 2);
  check('an image says Not checked', (await page.locator('.docs-files__table').innerText()).includes("Not checked · image"));
  await upload('tool.exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]));
  await page.waitForSelector('[role="alert"]');
  check('a program is refused by content', (await page.locator('[role="alert"]').innerText()).includes('not a PDF, an image or a text file'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download rack.png' }).click()]);
  check('the download keeps the name', dl.suggestedFilename() === 'rack.png');
  check('the add control says images and PDFs are not checked yet', (await page.locator('.docs-files').innerText()).includes('Images and PDFs are not checked yet'));
  // Remove keeps it undoable and listed; delete for good asks, then erases on the server.
  await page.getByRole('button', { name: 'Remove file rack.png' }).click();
  await page.waitForSelector('.docs-files__removed');
  await page.getByRole('button', { name: 'Delete rack.png for good' }).click();
  await page.getByRole('button', { name: 'Really delete rack.png for good' }).click();
  await page.waitForFunction(() => window.__deleted__.length === 1);
  check('delete for good reached the server and says so', (await page.locator('.docs-files').innerText()).includes('Deleted for good'));
  await page.screenshot({ path: SHOTS + 'docs-04b-files.png' });
  await page.keyboard.press('Escape');

  // 6 - the design Docs list shows every doc; dark mode too.
  await barAction(page, 'docs');
  await page.waitForSelector('.docs-table', { timeout: 5_000 });
  const rows = await page.locator('.docs-table tbody tr').allInnerTexts();
  check('the list has the model doc and the doc about acc-01', rows.length === 2 && rows.some((r) => r.includes('Model EX4300-48P')) && rows.some((r) => r.includes('acc-01')), rows.join(' | '));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: SHOTS + 'docs-05-list-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');

  const saveLoadFailures = await page.evaluate(() => window.__saveLoadFailures__ ?? []);
  check('every saved payload loaded through the engine', saveLoadFailures.length === 0, saveLoadFailures.join(' | '));

  // 7 - a reader sees the list and the lines, and has no way to change anything.
  await page.goto(`${BASE}/drive.html?scene=tags&capability=read`);
  await page.waitForSelector('.drawing', { timeout: 15_000 });
  await page.locator('.react-flow__node-chassis', { hasText: 'core-01' }).click();
  await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
  check('a reader sees the Docs line but no "+ Add doc"', (await page.locator('[data-testid="docs-section"]').count()) === 1 && (await page.getByText('+ Add doc').count()) === 0);
  await barAction(page, 'docs');
  await page.waitForSelector('.docs-overlay');
  check('a reader has no add in the list', (await page.getByText('+ Add doc').count()) === 0);
  await page.screenshot({ path: SHOTS + 'docs-06-reader.png' });

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
