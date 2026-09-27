// Proves ADR-0059 (tags) end to end against the real compiled client: a
// device and a cable each take a tag, "Add tag" suggests an existing one,
// a tag renames, untagging removes only the edge, undo brings it back, and
// quick search finds a device by its tag — through document/tags.ts and
// handleEdit/applyDocChange, the same path every edit takes.
//
// Uses the shared throwaway harness (`scripts/drive-lib/harness.tsx` +
// `seed.ts` + `catalogue.json`, copied into `client/` and removed below —
// see `drive-config-drawer.mjs` for why a scripted sign-in isn't available).
// `seedTagsScene` (`drive-lib/seed.ts`) is `seedConnectedDevices`'s own two
// devices and cable, with `core-01` already carrying one tag ("core") so
// the suggestion list has something to offer.
//
// Usage:
//   bash scripts/build-wasm.sh   # once, if the artefact is stale
//   node scripts/drive-tags.mjs
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
// Playwright is not a repo dependency (ADR-0032 gate zero) — reached by
// absolute path, like every other `scripts/drive-*`.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
// Not shared with any other `scripts/drive-*.mjs` — `grep -h "PORT = "
// scripts/drive-*.mjs` before picking a new one.
const PORT = 18321;
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
    <title>Fathom — ADR-0059 proof preview (throwaway, not shipped)</title>
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

  await page.goto(`${BASE}/drive.html?scene=tags`);
  await page.waitForSelector('.drawing', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-chassis').length === 2, null, { timeout: 15_000 });
  check('both devices are on the drawing', (await page.locator('.react-flow__node-chassis').count()) === 2);

  // -------------------------------------------------------------------------
  // 1 — a device already carries a tag (seeded); tag it a second time with a
  // brand-new name, one chip created.
  // -------------------------------------------------------------------------
  await page.locator('.react-flow__node-chassis', { hasText: 'core-01' }).click();
  await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
  const seededChips = await page.locator('.drawing-editor__panel .tag-chip .tag-chip__name').allTextContents();
  check('core-01 already carries the seeded "core" tag', seededChips.includes('core'), seededChips.join(', '));
  await page.screenshot({ path: SHOTS + 'tags-01-device-chip.png' });
  console.log('    wrote ' + SHOTS + 'tags-01-device-chip.png');

  // Backspace and Delete while typing in "Add tag" edit the field, never
  // the selected device (c8e19f5).
  const deviceTagInput = page.locator('.drawing-editor__panel .tag-chips__input');
  await deviceTagInput.click();
  await deviceTagInput.pressSequentially('ab');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  check(
    'Backspace/Delete in "Add tag" with the device selected leaves both devices in place',
    (await page.locator('.react-flow__node-chassis').count()) === 2,
  );
  await deviceTagInput.fill('');

  await page.locator('.drawing-editor__panel .tag-chips__input').fill('rack-a');
  await page.locator('.drawing-editor__panel .tag-chips__input').press('Enter');
  await page.waitForTimeout(300);
  const afterNewTag = await page.locator('.drawing-editor__panel .tag-chip .tag-chip__name').allTextContents();
  check('a new tag "rack-a" is created and shown as a chip', afterNewTag.includes('rack-a'), afterNewTag.join(', '));
  await page.screenshot({ path: SHOTS + 'tags-02-device-two-chips.png' });
  console.log('    wrote ' + SHOTS + 'tags-02-device-two-chips.png');

  // Enter on a name that is only a PREFIX of an existing tag ("rack-a")
  // creates a new tag by that exact typed name, never the one it prefixes
  // — the highlight defaults to the new-tag row unless the typed text
  // equals a suggestion exactly.
  await deviceTagInput.fill('rack');
  await page.waitForSelector('.drawing-editor__panel [role="listbox"]', { timeout: 5_000 });
  const listboxCount = await page.locator('.drawing-editor__panel [role="listbox"]').count();
  const optionCount = await page.locator('.drawing-editor__panel [role="option"]').count();
  check('the suggestion list carries listbox and option roles', listboxCount === 1 && optionCount > 0, `listbox=${listboxCount} option=${optionCount}`);
  await deviceTagInput.press('Enter');
  await page.waitForTimeout(300);
  const afterPrefixEnter = await page.locator('.drawing-editor__panel .tag-chip .tag-chip__name').allTextContents();
  check(
    'Enter on "rack" (a prefix, not an exact match) creates "rack", not "rack-a" again',
    afterPrefixEnter.includes('rack') && afterPrefixEnter.filter((n) => n === 'rack-a').length === 1,
    afterPrefixEnter.join(', '),
  );

  // -------------------------------------------------------------------------
  // 2 — the cable takes a tag too, picked from the suggestion list ("Add
  // tag" suggests existing tags as you type).
  // -------------------------------------------------------------------------
  const cableClicked = await clickTheCable(page);
  check('the cable in the scene was found and clicked', cableClicked);
  await page.waitForTimeout(300);
  const cablePanelText = await page.locator('.drawing-editor__panel').innerText();
  check(
    'the cable\'s own panel opened (shows "Ownership", a cable-only field)',
    cablePanelText.toLowerCase().includes('ownership'),
    cablePanelText.slice(0, 200),
  );

  // Backspace and Delete while typing in "Add tag" edit the field, never
  // the selected cable (c8e19f5).
  const cableTagInput = page.locator('.drawing-editor__panel .tag-chips__input');
  await cableTagInput.click();
  await cableTagInput.pressSequentially('xy');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  check(
    'Backspace/Delete in "Add tag" with the cable selected leaves the cable in place',
    (await page.evaluate(() => document.querySelectorAll('[data-cable-id]').length)) === 1,
  );
  await cableTagInput.fill('');

  await page.locator('.drawing-editor__panel .tag-chips__input').fill('co');
  await page.waitForSelector('.drawing-editor__panel .tag-chips__suggestions', { timeout: 5_000 });
  const suggestionTexts = await page.locator('.drawing-editor__panel .tag-chips__suggestion').allTextContents();
  check('the suggestion list offers the existing "core" tag', suggestionTexts.some((t) => t.includes('core')), suggestionTexts.join(' | '));
  await page.screenshot({ path: SHOTS + 'tags-03-suggestions.png' });
  console.log('    wrote ' + SHOTS + 'tags-03-suggestions.png');

  await page.locator('.drawing-editor__panel .tag-chips__suggestion', { hasText: 'core' }).first().click();
  await page.waitForTimeout(300);
  const cableChipsAfterPick = await page.locator('.drawing-editor__panel .tag-chip .tag-chip__name').allTextContents();
  check('the cable now carries the picked "core" tag', cableChipsAfterPick.includes('core'), cableChipsAfterPick.join(', '));
  await page.screenshot({ path: SHOTS + 'tags-04-cable-tagged.png' });
  console.log('    wrote ' + SHOTS + 'tags-04-cable-tagged.png');

  // Enter on a name that matches an existing tag EXACTLY (ignoring case)
  // reuses it rather than creating a duplicate node — the highlight starts
  // on that suggestion's own row, not the new-tag row.
  await cableTagInput.fill('rack-a');
  await page.waitForSelector('.drawing-editor__panel .tag-chips__suggestion', { timeout: 5_000 });
  const newRowShown = await page.locator('.drawing-editor__panel .tag-chips__suggestion--new').count();
  check('typing an exact existing name offers no "new tag" row', newRowShown === 0);
  await cableTagInput.press('Enter');
  await page.waitForTimeout(300);
  const cableChipsAfterExact = await page.locator('.drawing-editor__panel .tag-chip .tag-chip__name').allTextContents();
  check('Enter on the exact name reuses "rack-a" on the cable', cableChipsAfterExact.includes('rack-a'), cableChipsAfterExact.join(', '));

  // -------------------------------------------------------------------------
  // 3 — rename that tag (from the cable's own panel); the device's chip,
  // reached through the same tag node, reads the new name too.
  // -------------------------------------------------------------------------
  await page.locator('.drawing-editor__panel .tag-chip__name', { hasText: 'core' }).first().click();
  await page.locator('.drawing-editor__panel input.tag-chip__rename').fill('core-network');
  await page.locator('.drawing-editor__panel input.tag-chip__rename').press('Enter');
  await page.waitForTimeout(300);
  const cableChipsAfterRename = await page.locator('.drawing-editor__panel .tag-chip .tag-chip__name').allTextContents();
  check('the renamed chip reads "core-network" on the cable', cableChipsAfterRename.includes('core-network'), cableChipsAfterRename.join(', '));

  await page.locator('.react-flow__node-chassis', { hasText: 'core-01' }).click();
  await page.waitForTimeout(300);
  const deviceChipsAfterRename = await page.locator('.drawing-editor__panel .tag-chip .tag-chip__name').allTextContents();
  check('the same rename reads through on the device\'s own chip', deviceChipsAfterRename.includes('core-network'), deviceChipsAfterRename.join(', '));
  await page.screenshot({ path: SHOTS + 'tags-05-renamed.png' });
  console.log('    wrote ' + SHOTS + 'tags-05-renamed.png');

  // Clicking a chip's own name, then clicking elsewhere with nothing typed,
  // is not a rename — it must save nothing (round 2 item 4).
  const saveCountBeforeNoOp = await page.evaluate(() => window.__saveCount__ ?? 0);
  await page.locator('.drawing-editor__panel .tag-chip__name', { hasText: 'core-network' }).first().click();
  await page.waitForSelector('.drawing-editor__panel input.tag-chip__rename', { timeout: 5_000 });
  await page.locator('.drawing-editor__panel .drawing-editor__title').click();
  await page.waitForTimeout(300);
  const saveCountAfterNoOp = await page.evaluate(() => window.__saveCount__ ?? 0);
  check('clicking a chip name then clicking away with no edit saves nothing', saveCountAfterNoOp === saveCountBeforeNoOp, `${saveCountBeforeNoOp} -> ${saveCountAfterNoOp}`);

  // -------------------------------------------------------------------------
  // 4 — untag: remove "rack-a" from the device.
  // -------------------------------------------------------------------------
  await page.locator('.drawing-editor__panel button[aria-label="remove tag rack-a"]').click();
  await page.waitForTimeout(300);
  const deviceChipsAfterUntag = await page.locator('.drawing-editor__panel .tag-chip .tag-chip__name').allTextContents();
  check('untagging removes only "rack-a"', !deviceChipsAfterUntag.includes('rack-a') && deviceChipsAfterUntag.includes('core-network'), deviceChipsAfterUntag.join(', '));
  await page.screenshot({ path: SHOTS + 'tags-06-untagged.png' });
  console.log('    wrote ' + SHOTS + 'tags-06-untagged.png');

  // -------------------------------------------------------------------------
  // 5 — undo: the untag comes back off, "rack-a" returns.
  // -------------------------------------------------------------------------
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  const deviceChipsAfterUndo = await page.locator('.drawing-editor__panel .tag-chip .tag-chip__name').allTextContents();
  check('undo brings "rack-a" back', deviceChipsAfterUndo.includes('rack-a'), deviceChipsAfterUndo.join(', '));
  await page.screenshot({ path: SHOTS + 'tags-07-undo.png' });
  console.log('    wrote ' + SHOTS + 'tags-07-undo.png');

  // -------------------------------------------------------------------------
  // 6 — quick search finds core-01 by its renamed tag.
  // -------------------------------------------------------------------------
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.shell-search--open', { timeout: 5_000 });
  await page.locator('.shell-search__input').fill('core-net');
  await page.waitForTimeout(300);
  const searchRows = await page.locator('.shell-search__row').allTextContents();
  check('quick search finds core-01 by its tag', searchRows.some((t) => t.includes('core-01') && t.includes('tag: core-network')), searchRows.join(' | '));
  await page.screenshot({ path: SHOTS + 'tags-08-search.png' });
  console.log('    wrote ' + SHOTS + 'tags-08-search.png');
  await page.keyboard.press('Escape');

  // Every save this scene made, loaded back through a second real engine
  // (`drive-lib/harness.tsx`'s own mocked backend) — `drive-networks.mjs`'s
  // own "assert each scene saved at least once" pairing.
  const saveCount = await page.evaluate(() => window.__saveCount__ ?? 0);
  check('the scene saved at least once', saveCount > 0, `saveCount=${saveCount}`);
  const saveLoadFailures = await page.evaluate(() => window.__saveLoadFailures__ ?? []);
  check('every saved payload loaded through the engine', saveLoadFailures.length === 0, saveLoadFailures.join(' | '));

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
