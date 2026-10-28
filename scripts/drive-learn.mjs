// Proves the explainers (ADR-0066 item 1.1) on the real compiled client over the `firmware` scene:
// a Junos EX switch's panel has a Learn line marked Unreviewed, Read more opens the explainer with
// its sources, the library groups every entry, a Cisco box (no explainer yet) shows no Learn line,
// Esc closes, a reader sees the same, and dark and phone widths render. `GET /learn/explainers` is
// served by Playwright with two entries shaped like `json_of_explainer` in design_api.rs; the
// route itself is proved in crates/fathom-server/tests/design_api.rs.
//
// Usage:
//   bash scripts/build-wasm.sh   # once, if the artefact is stale
//   node scripts/drive-learn.mjs
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
// Playwright is not a repo dependency (ADR-0032 gate zero) — reached by
// absolute path, like every other `scripts/drive-*`.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const PORT = 18412;
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
    <title>Fathom — learn proof preview (throwaway, not shipped)</title>
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
// The firmware scene's two models the shared fixture lacks, cloned as drive-firmware.mjs does.
{
  const cat = JSON.parse(readFileSync(DRIVE_LIB + '/catalogue.json', 'utf8'));
  const clone = (from, vendor, model) => {
    const m = JSON.parse(JSON.stringify(cat.models[from]));
    m.model = model;
    m.vendor = vendor;
    cat.models[`${vendor}/${model}`] = m;
    cat.list.push({ model, rack_units: m.rack_units, vendor });
  };
  clone('juniper/EX2300-48P', 'juniper', 'EX2300-24P');
  clone('ubiquiti/USW-48-PoE', 'cisco', 'C9300-48P');
  writeFileSync(PREVIEW_CATALOGUE, JSON.stringify(cat));
}
check('drive.html written', existsSync(PREVIEW_HTML));
check('drive.tsx copied from drive-lib/harness.tsx', existsSync(PREVIEW_TSX));
check('drive-seed.ts copied from drive-lib/seed.ts', existsSync(PREVIEW_SEED));
check('drive-catalogue.json written from drive-lib/catalogue.json', existsSync(PREVIEW_CATALOGUE));

let viteProc = null;
let browser = null;

const EXPLAINERS = [
  {
    id: 'explain:concept:junos-ex.switching-basics', class: 'concept', title: 'Junos on EX switches: VLANs, interfaces and commit',
    subject: 'junos-ex.switching-basics', platforms: ['junos-ex'], tab: 'read this first',
    terse: 'Junos keeps a candidate configuration and applies it only on `commit`.',
    explained: 'A change typed in configuration mode does nothing until `commit`.\nThe running and candidate configurations are separate.',
    teaching: 'Use `commit confirmed 5` on a remote box, then `commit` again to keep it.', breaks_if_wrong: 'Forgetting the second commit rolls the change back after five minutes.',
    reviewed_on: '2026-09-19', reviewed: false,
    sources: [{ publisher: 'Juniper Networks', doc: 'Junos OS CLI User Guide', url: 'https://www.juniper.net/documentation/', read_on: '2026-09-19', note: null }],
  },
  {
    id: 'explain:concept:arista.eos-basics', class: 'concept', title: 'Arista EOS: what to know first',
    subject: 'arista.eos-basics', platforms: ['eos'], tab: 'read this first',
    terse: 'EOS reads like IOS and runs on Linux underneath.', explained: null, teaching: null, breaks_if_wrong: null,
    reviewed_on: '2026-09-19', reviewed: false, sources: [],
  },
  ...[
    ['basics.switch', 'Switch: joins the devices of one network', 'Joins devices in the same network and learns which port each one is behind.'],
    ['basics.trunk', 'Trunk: several VLANs on one cable', 'A trunk carries several VLANs on one cable; each frame is tagged with its VLAN.'],
    ['basics.access-port', 'Access port: one device, one VLAN', 'An access port connects one device and puts it in one VLAN, with no tags.'],
  ].map(([subject, title, terse]) => ({
    id: `explain:concept:${subject}`, class: 'concept', title, subject, platforms: ['*'], tab: 'learn note', terse,
    explained: null, teaching: null, breaks_if_wrong: null, reviewed_on: '2026-10-25', reviewed: false,
    sources: [{ publisher: 'Juniper Networks', doc: 'Security Zones and Interfaces', url: 'https://www.juniper.net/documentation/', read_on: '2026-10-25', note: null }],
  })),
];

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
  await context.route(/\/learn\/explainers$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EXPLAINERS) }));
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const open = async (read) => {
    await page.goto(`${BASE}/drive.html?scene=firmware${read ? '&capability=read' : ''}`);
    try {
      await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    } catch (e) {
      await page.screenshot({ path: SHOTS + 'learn-00-failed-open.png' });
      console.log('page errors: ' + pageErrors.join(' | '));
      console.log((await page.locator('body').innerText()).slice(0, 600));
      throw e;
    }
    await page.waitForTimeout(1500);
  };
  const select = async (hostname) => {
    await page.locator('.react-flow__node-chassis', { hasText: hostname }).first().click();
    await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
    await page.waitForTimeout(200);
  };

  // 1 - a Junos EX switch has a Learn line, marked Unreviewed.
  await open(false);
  await select('switch-2');
  await page.locator('[data-testid="learn-fold"]').waitFor({ timeout: 8_000 });
  await page.evaluate(() => document.querySelectorAll('details.drawing-editor__fold').forEach((d) => { d.open = true; })); // r30-device: the panel's lower sections start folded
  const about = page.locator('[data-testid="learn-about"]');
  await about.waitFor({ timeout: 5_000 });
  const aboutText = await about.innerText();
  check('switch-2 (junos-ex) has a Learn line with the explainer title', aboutText.includes('Junos on EX switches'), aboutText);
  check('it is marked Unreviewed', aboutText.toUpperCase().includes('UNREVIEWED'), aboutText);
  check('backticks are code', (await about.locator('code', { hasText: 'commit' }).count()) === 1);
  await about.scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS + 'learn-01-about.png' });

  // 2 - Read more opens the whole explainer with its sources.
  await about.getByRole('button', { name: 'Read more' }).click();
  await page.waitForSelector('.learn-overlay', { timeout: 5_000 });
  const pageText = (await page.locator('[data-testid="explainer-page"]').textContent()) ?? '';
  check('the explainer shows its sections', pageText.includes('In practice') && pageText.includes('What goes wrong'), pageText.slice(0, 300));
  check('the source is linked safely, with its read date', (await page.locator('.learn-entry__sources a').getAttribute('rel'))?.includes('noopener') === true && pageText.includes('read 2026-09-19'));
  await page.screenshot({ path: SHOTS + 'learn-02-explainer.png' });

  // 3 - the library lists both topics.
  await page.getByRole('button', { name: '← All explainers' }).click();
  await page.waitForSelector('[data-testid="learn-library"]', { timeout: 5_000 });
  const lib = (await page.locator('[data-testid="learn-library"]').textContent()) ?? '';
  check('the library groups by topic', lib.includes('Arista EOS') && lib.includes('Juniper EX'), lib);
  await page.screenshot({ path: SHOTS + 'learn-03-library.png' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.learn-overlay'), null, { timeout: 5_000 });
  check('Esc closes Learn', true);

  // 4 - a Cisco box has no explainer yet, so no Learn line.
  await select('dist-1');
  check('dist-1 (ios-xe) shows no Learn line', (await page.locator('[data-testid="learn-about"]').count()) === 0);

  // 5 - the command palette opens the library.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Open Learn');
  await page.keyboard.press('Enter');
  const libOpened = await page.waitForSelector('[data-testid="learn-library"]', { timeout: 5_000 }).then(() => true, () => false);
  check('Ctrl+K "Open Learn" opens the library', libOpened);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: SHOTS + 'learn-04-library-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');

  // 6 - a reader sees the same Learn line; phone width renders.
  await open(true);
  await select('leaf-1');
  await page.locator('[data-testid="learn-fold"]').waitFor({ timeout: 8_000 });
  await page.evaluate(() => document.querySelectorAll('details.drawing-editor__fold').forEach((d) => { d.open = true; })); // r30-device: the panel's lower sections start folded
  check('a reader sees the EOS Learn line', (await page.locator('[data-testid="learn-about"]').innerText()).includes('Arista EOS'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-testid="learn-about"]').getByRole('button', { name: 'Read more' }).click();
  await page.waitForSelector('.learn-overlay', { timeout: 5_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('the explainer fits a phone width', !overflow);
  await page.screenshot({ path: SHOTS + 'learn-05-phone.png' });

  // 7 - the Show menu's Learn notes on the Diagram look: one note per idea, each opening its explainer.
  await page.setViewportSize({ width: 1600, height: 1000 });
  // The cable-groups scene seeds two designs, so Home opens first (drive-cable-groups.mjs does the same).
  const diagram = async (scene) => {
    await page.goto(`${BASE}/drive.html?scene=${scene}`);
    await page.waitForSelector('.home__design-row', { timeout: 10_000 });
    const row = page.locator('.home__design-row').filter({ has: page.locator('.home__design-name[title="design-drive"]') });
    await row.locator('button', { hasText: 'Canvas' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.getByLabel('Look').getByRole('button', { name: 'Diagram', exact: true }).click();
    await page.waitForSelector('.drawing-diagram-box', { timeout: 10_000 });
    await page.click('button[aria-label="Fit to view"]').then(() => page.waitForTimeout(700));
  };
  await diagram('cable-groups');
  check('no notes until Learn notes is ticked', (await page.locator('.learn-note').count()) === 0);
  await page.getByTestId('shell-show').click();
  await page.getByTestId('show-learn').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const swNote = page.getByTestId('learn-note-role:switch');
  check('the first switch gets one note', (await swNote.count()) === 1 && (await swNote.innerText()).includes('Joins devices'), (await swNote.count()) ? await swNote.innerText() : 'none');
  const trunkNote = page.getByTestId('learn-note-trunk');
  check('a trunk gets a note naming its VLANs', (await trunkNote.count()) === 1 && /carries VLANs? \d/.test(await trunkNote.innerText()), (await trunkNote.count()) ? await trunkNote.innerText() : 'none');
  check('never more than five notes', (await page.locator('.learn-note').count()) <= 5);
  await page.screenshot({ path: SHOTS + 'learn-06-notes.png' });
  await trunkNote.click();
  await page.waitForSelector('.learn-overlay', { timeout: 5_000 });
  check('the note opens its explainer', ((await page.locator('[data-testid="explainer-page"]').textContent()) ?? '').includes('Trunk: several VLANs on one cable'));
  await page.keyboard.press('Escape');

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
