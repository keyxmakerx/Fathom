// The Cables list, end to end against the real compiled client: open the
// list from the lit Cables lens, add a VLAN group and a type group, the
// draw rule (a ticked group, the exact trunk cable dashed, None, All), a
// tag on a shelf-mounted device catching its cable, the lit path ignoring a
// hidden cable, hide one cable from its editor and bring it back, the list
// surviving a reload, a second design carrying its own separate list, and
// that none of it ever saved a document version.
//
// Uses the shared throwaway harness (`scripts/drive-lib/harness.tsx` +
// `seed.ts` + `catalogue.json`, copied into `client/` and removed below —
// see `drive-config-drawer.mjs` for why a scripted sign-in isn't available).
// `seedCableGroupsScene` (`drive-lib/seed.ts`) seeds two VLANs (one of them
// over a trunk), a tag, a fibre pair and a power lead.
//
// Usage:
//   bash scripts/build-wasm.sh   # once, if the artefact is stale
//   node scripts/drive-cable-groups.mjs
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
const PORT = 18500;
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
    <title>Fathom — Cables list drive preview (throwaway, not shipped)</title>
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

/** Dispatches a real `click` on `[data-cable-id="<id>"]` — `drive-tags.mjs`'s
 * own `clickTheCable`, generalised to a scene with several cables: the
 * SVG path's bounding box is not reliably over its own stroke, so this
 * reaches the DOM node directly rather than a geometric `page.click`. */
async function clickCable(page, cableId) {
  return page.evaluate((id) => {
    const g = document.querySelector(`[data-cable-id="${id}"]`);
    if (!g) return false;
    g.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, cableId);
}

async function drawnCableIds(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-cable-id]')].map((el) => el.getAttribute('data-cable-id')));
}

/** Clicks every currently-drawn cable in turn until the editor panel's own
 * "Kind" field reads `kind` — there is no other way from the DOM alone to
 * tell which opaque cable id is the power lead versus the fibre pair. */
async function selectCableOfKind(page, kind) {
  const ids = await drawnCableIds(page);
  for (const id of ids) {
    await clickCable(page, id);
    await page.waitForTimeout(150);
    const text = await page.locator('.drawing-editor__panel').innerText();
    if (new RegExp(`KIND\\s*\\n\\s*${kind}\\b`, 'i').test(text) || text.toLowerCase().includes(`kind\n${kind}`)) return id;
  }
  throw new Error(`no drawn cable of kind "${kind}" found among ${ids.join(', ')}`);
}

/** Every cabled port's own fill state (`ChassisNode.tsx`'s `--port-sheath`
 * custom property and its `--cabled` class) — "port fill comes from every
 * cable, not only the drawn ones." Keyed and sorted so two snapshots
 * compare equal regardless of DOM traversal order. */
async function cabledPortFillSnapshot(page) {
  const raw = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('[data-port-id]').forEach((el) => {
      if (!el.className.includes('--cabled')) return;
      out[el.getAttribute('data-port-id')] = el.style.getPropertyValue('--port-sheath');
    });
    return out;
  });
  return JSON.stringify(Object.fromEntries(Object.entries(raw).sort()));
}

async function openCableGroupsList(page) {
  await page.locator('.shell-bar__lenses .shell-lens', { hasText: 'Cables' }).click();
  await page.waitForSelector('.cable-groups-pop', { timeout: 5_000 });
}

/** Opens "+ Add a group…", types `query`, and calls `onPickerOpen` (if
 * given — a screenshot, typically) with the picker showing before clicking
 * the matching row and returning to the plain list. */
async function addGroup(page, query, onPickerOpen) {
  await page.locator('.cable-groups-pop__add').click();
  await page.waitForSelector('.cable-groups-pop__search input', { timeout: 5_000 });
  await page.locator('.cable-groups-pop__search input').fill(query);
  await page.waitForSelector('.cable-groups-pop__pick-row', { timeout: 5_000 });
  if (onPickerOpen) await onPickerOpen();
  await page.locator('.cable-groups-pop__pick-row', { hasText: query }).first().click();
  await page.waitForSelector('.cable-groups-pop__row', { timeout: 5_000 });
}

async function tickGroup(page, name) {
  await page.locator('.cable-groups-pop__row', { hasText: name }).locator('input[type="checkbox"]').check();
}

async function untickGroup(page, name) {
  await page.locator('.cable-groups-pop__row', { hasText: name }).locator('input[type="checkbox"]').uncheck();
}

async function removeGroup(page, name) {
  await page.locator('.cable-groups-pop__row', { hasText: name }).locator('.cable-groups-pop__remove').click();
}

/** Every cable id currently drawing dashed — `[data-cable-id]`'s own child
 * `path` carries `stroke-dasharray` when `CableEdge.tsx` reads `dashed`
 * true; walked back up to the cable id rather than counted, so a caller can
 * assert exactly WHICH cable, not just that some cable is dashed. */
async function dashedCableIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-cable-id] path')]
      .filter((p) => p.getAttribute('stroke-dasharray'))
      .map((p) => p.closest('[data-cable-id]').getAttribute('data-cable-id')),
  );
}

/** Opens `designId` from Home in the Racks place — with two designs seeded
 * ("Show me a second design" below), ADR-0046 §3's own "exactly one place
 * to go lands there directly" no longer fires, so every open (the first
 * one included) goes through Home's own design row rather than a direct
 * landing. */
async function openDesignInRacks(page, designId) {
  await page.waitForSelector('.home__design-row', { timeout: 10_000 });
  // An EXACT match on the id span itself, not a substring of the row's
  // whole text — `design-drive` is itself a substring of `design-drive-2`.
  const row = page.locator('.home__design-row').filter({ has: page.locator(`.home__design-name[title="${designId}"]`) });
  await row.locator('button', { hasText: 'Canvas' }).click();
  await page.waitForSelector('.drawing', { timeout: 15_000 });
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

  // Two designs are seeded for this scene (the second, below, proves it
  // keeps its own list), so ADR-0046 §3's "exactly one place to go" never
  // fires — this opens `design-drive` from Home like a person choosing
  // between two would, rather than landing on Racks directly.
  await page.goto(`${BASE}/drive.html?scene=cable-groups`);
  await openDesignInRacks(page, 'design-drive');
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-chassis').length === 8, null, { timeout: 15_000 });
  check('every device in the scene is on the drawing', (await page.locator('.react-flow__node-chassis').count()) === 8);

  const initialCables = await drawnCableIds(page);
  check('every cable draws on open ("All", nothing stored yet)', initialCables.length === 6, initialCables.join(', '));

  // -------------------------------------------------------------------------
  // 1 — open the list from the lit Cables lens.
  // -------------------------------------------------------------------------
  await openCableGroupsList(page);
  check('the list opens as a popover under the Cables lens', await page.locator('.cable-groups-pop__title', { hasText: 'Cables · groups' }).isVisible());
  await page.screenshot({ path: SHOTS + 'cable-groups-01-list.png' });
  console.log('    wrote ' + SHOTS + 'cable-groups-01-list.png');

  // -------------------------------------------------------------------------
  // 1b — the trunk cable's own id, by its "uplinks" tag (the seed's own
  // choice: the tag names exactly the trunk cable, nothing else) — read
  // once, alone, before any other group is ticked, so later steps can
  // assert exactly WHICH cable draws dashed rather than merely that one
  // does.
  // -------------------------------------------------------------------------
  await addGroup(page, 'uplinks');
  await tickGroup(page, 'uplinks');
  await page.waitForTimeout(200);
  const uplinksOnly = await drawnCableIds(page);
  check('the "uplinks" tag names exactly the trunk cable', uplinksOnly.length === 1, uplinksOnly.join(', '));
  const trunkCableId = uplinksOnly[0];
  await removeGroup(page, 'uplinks');
  await page.waitForTimeout(200);

  // -------------------------------------------------------------------------
  // 1c — a tag on a shelf-mounted device catches its cable.
  // -------------------------------------------------------------------------
  await addGroup(page, 'shelfgear');
  await tickGroup(page, 'shelfgear');
  await page.waitForTimeout(200);
  const shelfgearOnly = await drawnCableIds(page);
  check("a tag on a shelf device catches exactly its own cable", shelfgearOnly.length === 1, shelfgearOnly.join(', '));
  await removeGroup(page, 'shelfgear');
  await page.waitForTimeout(200);

  // -------------------------------------------------------------------------
  // 2 — add a VLAN group and tick it: only its cables draw, exactly the
  // trunk cable dashed, and every port keeps its fill.
  // -------------------------------------------------------------------------
  const portFillBefore = await cabledPortFillSnapshot(page);
  await addGroup(page, 'VLAN 30', async () => {
    await page.screenshot({ path: SHOTS + 'cable-groups-02-picker.png' });
    console.log('    wrote ' + SHOTS + 'cable-groups-02-picker.png');
  });
  await tickGroup(page, 'VLAN 30');
  await page.waitForTimeout(200);

  const afterVlan = await drawnCableIds(page);
  check('ticking the VLAN group draws only its own two cables', afterVlan.length === 2, afterVlan.join(', '));
  const dashedAfterVlan = await dashedCableIds(page);
  check('exactly the trunk cable draws dashed', dashedAfterVlan.length === 1 && dashedAfterVlan[0] === trunkCableId, dashedAfterVlan.join(', '));
  const portFillAfterVlan = await cabledPortFillSnapshot(page);
  check('every cabled port keeps exactly the same fill', portFillAfterVlan === portFillBefore);
  await page.screenshot({ path: SHOTS + 'cable-groups-03-filtered.png' });
  console.log('    wrote ' + SHOTS + 'cable-groups-03-filtered.png');

  // -------------------------------------------------------------------------
  // 2b — ticking Copper too (the trunk is an unmarked-media, "copper" cable)
  // keeps the trunk dashed: only another ticked VLAN group carrying it
  // untagged may solidify it, never a type group.
  // -------------------------------------------------------------------------
  await tickGroup(page, 'Copper');
  await page.waitForTimeout(200);
  const dashedWithCopperToo = await dashedCableIds(page);
  check('VLAN 30 plus Copper keeps the trunk dashed', dashedWithCopperToo.includes(trunkCableId), dashedWithCopperToo.join(', '));
  await untickGroup(page, 'Copper');
  await page.waitForTimeout(200);

  // -------------------------------------------------------------------------
  // 3 — add Fibre: both groups' cables draw. Fibre is already on the list
  // ("with nothing stored for a design, the list starts with the types
  // that occur in the view, all unticked" — this scene carries a fibre
  // cable from the start) — ticking it is "adding" it to what draws, the
  // picker's own job (already shown above) not needed a second time for a
  // group already listed.
  // -------------------------------------------------------------------------
  await tickGroup(page, 'Fibre');
  await page.waitForTimeout(200);
  const afterFibre = await drawnCableIds(page);
  check('ticking Fibre too draws the union of both groups', afterFibre.length === 3, afterFibre.join(', '));

  // -------------------------------------------------------------------------
  // 4 — None, then All.
  // -------------------------------------------------------------------------
  await page.locator('.cable-groups-pop__fchip', { hasText: 'None' }).click();
  await page.waitForTimeout(200);
  const afterNone = await drawnCableIds(page);
  check('None hides every cable', afterNone.length === 0, afterNone.join(', '));

  await page.locator('.cable-groups-pop__fchip', { hasText: 'All' }).click();
  await page.waitForTimeout(200);
  const afterAll = await drawnCableIds(page);
  check('All unticks every group and draws every cable again', afterAll.length === 6, afterAll.join(', '));

  // -------------------------------------------------------------------------
  // 5 — hide a cable from its editor: the chip reads "1 hidden"; "show"
  // brings it back.
  // -------------------------------------------------------------------------
  const powerCableId = await selectCableOfKind(page, 'power');
  await page.locator('.drawing-editor__hide-cable button', { hasText: 'Hide this cable' }).click();
  await page.waitForTimeout(200);
  const afterHide = await drawnCableIds(page);
  check('the hidden cable stops drawing', !afterHide.includes(powerCableId) && afterHide.length === 5, afterHide.join(', '));
  const hiddenChipText = await page.locator('[data-testid="shell-hidden-cables-chip"]').innerText();
  check('the bar shows "1 hidden · show"', /1 hidden/.test(hiddenChipText), hiddenChipText);
  await page.screenshot({ path: SHOTS + 'cable-groups-04-hidden-chip.png' });
  console.log('    wrote ' + SHOTS + 'cable-groups-04-hidden-chip.png');
  check(
    'the cable\'s own panel now offers "Show this cable"',
    await page.locator('.drawing-editor__hide-cable button', { hasText: 'Show this cable' }).isVisible(),
  );

  // The lit path only reads drawn cables: the cable this editor panel is
  // still open on is now hidden, so it must light nothing and dim nothing
  // — every other drawn cable's own opacity reads plain "1", never the
  // dimmed value a live selection would otherwise apply.
  const opacitiesWhileSelectedCableHidden = await page.evaluate(() =>
    [...document.querySelectorAll('[data-cable-id]')].map((el) => el.style.opacity),
  );
  check(
    'a selected cable that is hidden dims nothing else',
    opacitiesWhileSelectedCableHidden.every((o) => o === '1' || o === ''),
    opacitiesWhileSelectedCableHidden.join(', '),
  );

  await page.locator('[data-testid="shell-hidden-cables-chip"] .shell-chip__link').click();
  await page.waitForTimeout(200);
  const afterShow = await drawnCableIds(page);
  check('"show" brings every hidden cable back', afterShow.length === 6, afterShow.join(', '));
  check('the hidden chip is gone', (await page.locator('[data-testid="shell-hidden-cables-chip"]').count()) === 0);

  // -------------------------------------------------------------------------
  // 5b — nothing done so far ever saved a document version. Checked HERE,
  // before the reload just below wipes `window.__requests__` clean — a
  // check placed after the reload would only ever see requests the reload
  // itself made, never catch a real leak from any step above it.
  // -------------------------------------------------------------------------
  const versionPostsBeforeReload = await page.evaluate(
    () => (window.__requests__ ?? []).filter((r) => r.method === 'POST' && r.url.includes('/versions')),
  );
  check(
    'no group toggle, hide/show, add or remove saved a version',
    versionPostsBeforeReload.length === 0,
    JSON.stringify(versionPostsBeforeReload),
  );

  // -------------------------------------------------------------------------
  // 6 — reload: the list and the ticks are still there.
  // -------------------------------------------------------------------------
  await openCableGroupsList(page);
  await tickGroup(page, 'VLAN 30');
  await page.waitForTimeout(200);
  await page.reload();
  // Two designs, `openDesignInRacks`'s own reasoning: a reload restarts the
  // app fresh, back on Home, so this design is reopened the same way it was
  // the first time rather than assumed to still be showing.
  await openDesignInRacks(page, 'design-drive');
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-chassis').length === 8, null, { timeout: 15_000 });
  const afterReload = await drawnCableIds(page);
  check('the ticked group still filters the drawing after reload', afterReload.length === 2, afterReload.join(', '));
  await openCableGroupsList(page);
  const vlanRowAfterReload = page.locator('.cable-groups-pop__row', { hasText: 'VLAN 30' });
  check('the VLAN 30 group is still listed and still ticked', await vlanRowAfterReload.locator('input[type="checkbox"]').isChecked());
  const fibreRowAfterReload = page.locator('.cable-groups-pop__row', { hasText: 'Fibre' });
  check('the Fibre group is still listed too', await fibreRowAfterReload.count() === 1);

  // -------------------------------------------------------------------------
  // 7 — open a second design: it has its own list.
  // -------------------------------------------------------------------------
  await page.keyboard.press('Escape');
  await page.locator('.shell-bar__brand').click();
  await page.waitForSelector('.home__design-row', { timeout: 10_000 });
  check('the second design is listed on Home', await page.locator('.home__design-row', { has: page.locator('.home__design-name[title="design-drive-2"]') }).count() === 1);
  await openDesignInRacks(page, 'design-drive-2');
  await openCableGroupsList(page);
  const secondDesignRows = await page.locator('.cable-groups-pop__row').count();
  check('the second design opens with no groups of its own', secondDesignRows === 0, `${secondDesignRows} row(s)`);

  // -------------------------------------------------------------------------
  // 8 — nothing since the reload saved a version either, and every saved
  // payload loaded clean through the engine.
  // -------------------------------------------------------------------------
  const versionPostsAfterReload = await page.evaluate(
    () => (window.__requests__ ?? []).filter((r) => r.method === 'POST' && r.url.includes('/versions')),
  );
  check('nothing since the reload saved a version either', versionPostsAfterReload.length === 0, JSON.stringify(versionPostsAfterReload));
  const saveLoadFailures = await page.evaluate(() => window.__saveLoadFailures__ ?? []);
  check('every saved payload (there were none) loaded through the engine', saveLoadFailures.length === 0, saveLoadFailures.join(' | '));

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
