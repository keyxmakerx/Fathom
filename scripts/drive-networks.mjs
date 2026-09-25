// Drives the Networks list (ADR-0058) through the real App in a real browser, fetch answered by the
// shared harness; every save is loaded through a second real engine, so a save the server would refuse fails.
// Scenes: `networks` (five sketch devices; the networks are added through the editor) and
// `networks-010` (the same design served as schema 0.10, decision 6).
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-networks.mjs.
// Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT, FATHOM_SHOTS.
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
const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });
const NETWORKS_SHOT = SHOTS + 'networks.png';
const NETWORKS_OPEN_SHOT = SHOTS + 'networks-open.png';

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

const fails = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) fails.push(name);
}

// ---------------------------------------------------------------------------
const WASM_ARTIFACT = CLIENT + '/public/engine/fathom_wasm.wasm';
if (!existsSync(WASM_ARTIFACT)) {
  console.log('==> building the wasm artefact (missing): bash scripts/build-wasm.sh');
  execFileSync('bash', [ROOT + '/scripts/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
check('the wasm artefact exists', existsSync(WASM_ARTIFACT), WASM_ARTIFACT);

// Never overwrite a file someone already has there.
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

/** Home -> Inventory -> the Networks kind. Direct entry (ADR-0046 §3) lands
 * on Racks when there is exactly one organisation and one design — this
 * harness's mocked backend always offers exactly that — so every scene
 * crosses the bar's "Inventory" tab, never Home's per-design button. */
async function openNetworksList(page) {
  await page.waitForSelector('.shell-bar__tab', { timeout: 15_000 });
  await page.locator('.shell-bar__tab', { hasText: 'Inventory' }).click();
  await page.waitForSelector('.inventory-place__kind', { timeout: 15_000 });
  await page.locator('.inventory-place__kind', { hasText: 'Networks' }).click();
  await page.waitForSelector('.networks-panel', { timeout: 15_000 });
}

function summaryText(page) {
  return page.locator('.networks-panel__summary').innerText();
}

/** Every save this scene has made so far, checked against the real engine
 * inside the page itself — asserted empty at each call site below. */
async function saveLoadFailures(page) {
  return page.evaluate(() => window.__saveLoadFailures__ ?? []);
}

/** How many saves this scene's mocked backend has answered so far ("assert
 * each scene saved at least once" — a scene that never wrote anything is
 * not proof of anything, even if its empty `saveLoadFailures` list looks
 * green). */
async function saveCount(page) {
  return page.evaluate(() => window.__saveCount__ ?? 0);
}

/** Both drive checks, run after EVERY scene: the engine-load check, and
 * that the scene actually saved at least once. */
async function checkEveryScene(page, sceneName) {
  const count = await saveCount(page);
  check(`${sceneName}: scene saved at least once`, count > 0, `saveCount=${count}`);
  const failures = await saveLoadFailures(page);
  check(`${sceneName}: every saved payload loaded through the engine`, failures.length === 0, failures.join(' | '));
}

async function openEditor(page, kind) {
  await page.locator('.networks-panel__add').click();
  const editor = page.locator('.networks-panel__side');
  await editor.waitFor({ state: 'visible' });
  await editor.locator('.networks-editor__fchips .networks-panel__fchip', { hasText: kind }).click();
  return editor;
}

/** Fills attach row `index` (0-based) of the open editor — the board's
 * "Attach interfaces · N chosen" list. Adds a fresh blank row first when
 * `index` is beyond how many exist yet. */
async function fillAttachRow(page, editor, index, { device, port, tagged, gateway, address }) {
  const rows = editor.locator('.networks-editor__attach-row');
  while ((await rows.count()) <= index) {
    await editor.locator('.networks-editor__add-attach').click();
  }
  const row = rows.nth(index);
  await row.locator('select').first().selectOption({ label: device });
  await page.waitForTimeout(100);
  await row.locator('select').nth(1).selectOption({ label: port });
  if (tagged) await row.locator('label', { hasText: 'tagged' }).locator('input').check();
  if (gateway) await row.locator('label', { hasText: 'gateway' }).locator('input').check();
  if (address !== undefined) await row.locator('input[placeholder="10.8.0.1/24"]').fill(address);
}

async function fillAddVlan(page, { device, port, vlanId, name, gateway, gatewayAddress, subnet }) {
  const editor = await openEditor(page, 'VLAN');
  if (name !== undefined) await editor.locator('input').first().fill(name);
  await editor.locator('input[placeholder="50"]').fill(String(vlanId));
  if (subnet !== undefined) await editor.locator('input[placeholder="10.0.50.0/24"]').fill(subnet);
  await fillAttachRow(page, editor, 0, { device, port, gateway });
  if (gateway) await editor.locator('input[placeholder="10.0.50.1/24"]').fill(gatewayAddress);
  await editor.locator('button.networks-editor__save').click();
}

async function fillAddSubnet(page, { device, port, prefix, address, name }) {
  const editor = await openEditor(page, 'Subnet');
  if (name !== undefined) await editor.locator('input').first().fill(name);
  await editor.locator('input[placeholder="10.0.50.0/24"]').fill(prefix);
  await fillAttachRow(page, editor, 0, { device, port, address });
  await editor.locator('button.networks-editor__save').click();
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

  // -------------------------------------------------------------------------
  // Scene 1 — networks: add a VLAN on two cabled sketch devices; add an
  // uncabled second VLAN with the same id; add a subnet; undo and redo each.
  // -------------------------------------------------------------------------
  {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=networks`);
    await openNetworksList(page);

    check('networks: starts with nothing to show', (await summaryText(page)).includes('0 networks'), await summaryText(page));

    // --- VLAN 10 on sketch-a, then sketch-b (cabled): one joined row -------
    await fillAddVlan(page, { device: 'sketch-a', port: 'Et1', vlanId: 10, name: 'Servers' });
    await page.waitForTimeout(200);
    check('vlan 10 (sketch-a): 1 network', (await summaryText(page)).includes('1 network ·'), await summaryText(page));

    await fillAddVlan(page, { device: 'sketch-b', port: 'Et1', vlanId: 10 });
    await page.waitForTimeout(200);
    check('vlan 10 (+ sketch-b, cabled): still 1 network — joined', (await summaryText(page)).includes('1 network ·'), await summaryText(page));
    const joinedRow = page.locator('.networks-grid__cell--name', { hasText: 'VLAN 10' });
    const joinedRowText = await joinedRow.innerText();
    check('vlan 10 row is not marked "not joined"', !joinedRowText.includes('not joined'), joinedRowText);
    await joinedRow.click();
    let membersAfterJoin = await page.locator('.networks-grid__member').allInnerTexts();
    check('vlan 10 row expands to 2 members', membersAfterJoin.length === 2, membersAfterJoin.join(' | '));
    check('open row names both devices', membersAfterJoin.some((t) => t.includes('sketch-a')) && membersAfterJoin.some((t) => t.includes('sketch-b')), membersAfterJoin.join(' | '));

    // Screenshot the open row here, on the joined VLAN 10 row.
    await page.evaluate(() => document.querySelector('.networks-panel__grid-area')?.scrollTo({ left: 0, top: 0 }));
    await page.waitForTimeout(150);
    await page.screenshot({ path: NETWORKS_OPEN_SHOT });
    console.log('    wrote ' + NETWORKS_OPEN_SHOT);

    await joinedRow.click(); // collapse again

    // undo the sketch-b attach, then redo it
    await page.locator('.shell-chip', { hasText: 'Undo' }).click();
    await page.waitForTimeout(300);
    await joinedRow.click();
    let afterUndo = await page.locator('.networks-grid__member').allInnerTexts();
    check('vlan 10: undo removes sketch-b, sketch-a remains', afterUndo.some((t) => t.includes('sketch-a')) && !afterUndo.some((t) => t.includes('sketch-b')), afterUndo.join(' | '));
    await joinedRow.click();
    await page.locator('.shell-chip', { hasText: 'Redo' }).click();
    await page.waitForTimeout(300);
    await joinedRow.click();
    let afterRedo = await page.locator('.networks-grid__member').allInnerTexts();
    check('vlan 10: redo restores sketch-b', afterRedo.some((t) => t.includes('sketch-a')) && afterRedo.some((t) => t.includes('sketch-b')), afterRedo.join(' | '));
    await joinedRow.click();

    // --- VLAN 20 on sketch-c, then sketch-d (uncabled): two marked rows ----
    await fillAddVlan(page, { device: 'sketch-c', port: 'Et1', vlanId: 20 });
    await fillAddVlan(page, { device: 'sketch-d', port: 'Et1', vlanId: 20 });
    await page.waitForTimeout(200);
    const vlan20Rows = await page.locator('.networks-grid__cell--name', { hasText: 'VLAN 20' }).allInnerTexts();
    check('vlan 20: two separate rows (uncabled)', vlan20Rows.length === 2, vlan20Rows.join(' | '));
    check(
      'vlan 20: both rows marked "same id, not joined"',
      vlan20Rows.every((t) => t.includes('not joined')),
      vlan20Rows.join(' | '),
    );
    check('networks: 3 networks total (1 joined vlan 10 + 2 unjoined vlan 20 rows)', (await summaryText(page)).includes('3 networks'), await summaryText(page));

    // undo sketch-d's vlan 20 attach, then redo it
    await page.locator('.shell-chip', { hasText: 'Undo' }).click();
    await page.waitForTimeout(300);
    check('vlan 20: undo leaves one row', (await page.locator('.networks-grid__cell--name', { hasText: 'VLAN 20' }).count()) === 1);
    await page.locator('.shell-chip', { hasText: 'Redo' }).click();
    await page.waitForTimeout(300);
    check('vlan 20: redo restores both rows', (await page.locator('.networks-grid__cell--name', { hasText: 'VLAN 20' }).count()) === 2);

    // --- the rail's Networks count, read from a DIFFERENT kind, follows
    // the live document off its debounced timer rather than staying at 0
    // on arrival or stale after an undo made without ever opening
    // Networks. ------------------------------
    await page.locator('.inventory-place__kind', { hasText: 'Devices' }).click();
    await page.waitForTimeout(400); // past the 250ms debounce
    const railOnArrival = await page.locator('.inventory-place__kind', { hasText: 'Networks' }).locator('.inventory-place__count').innerText();
    check('rail: Networks reads 3 on arrival at Devices, not 0 or "…"', railOnArrival === '3', railOnArrival);

    await page.locator('.shell-chip', { hasText: 'Undo' }).click(); // drops one VLAN 20 row: 3 -> 2
    await page.waitForTimeout(400);
    const railAfterUndo = await page.locator('.inventory-place__kind', { hasText: 'Networks' }).locator('.inventory-place__count').innerText();
    check('rail: Networks follows an undo made while still on Devices', railAfterUndo === '2', railAfterUndo);

    await page.locator('.shell-chip', { hasText: 'Redo' }).click(); // back to 3, leaves state as the rest of this scene expects
    await page.waitForTimeout(400);
    await page.locator('.inventory-place__kind', { hasText: 'Networks' }).click();
    await page.waitForSelector('.networks-panel', { timeout: 15_000 });

    // --- a subnet on sketch-e -----------------------------------------------
    await fillAddSubnet(page, { device: 'sketch-e', port: 'wg0', prefix: '10.9.0.0/24', address: '10.9.0.1/24', name: 'Road warriors' });
    await page.waitForTimeout(200);
    check('subnet: 1 subnet listed', (await summaryText(page)).includes('1 subnet ·'), await summaryText(page));
    const subnetRowText = await page.locator('.networks-grid__cell--name', { hasText: 'wg0' }).innerText();
    check('subnet row names the interface and the description', subnetRowText.includes('wg0') && subnetRowText.includes('Road warriors'), subnetRowText);

    await page.locator('.shell-chip', { hasText: 'Undo' }).click();
    await page.waitForTimeout(300);
    check('subnet: undo removes it', (await summaryText(page)).includes('0 subnets'), await summaryText(page));
    await page.locator('.shell-chip', { hasText: 'Redo' }).click();
    await page.waitForTimeout(300);
    check('subnet: redo restores it', (await summaryText(page)).includes('1 subnet ·'), await summaryText(page));

    check('networks: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await checkEveryScene(page, 'networks');

    // Scroll the grid back to its left edge — clicking through rows and
    // buttons above can leave it scrolled right, and the saved screenshot
    // should show the list from "network" onward, not mid-scroll.
    await page.evaluate(() => {
      document.querySelector('.networks-panel__grid-area')?.scrollTo({ left: 0, top: 0 });
      document.querySelector('.inventory-place__main')?.scrollTo({ left: 0, top: 0 });
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: NETWORKS_SHOT });
    console.log('    wrote ' + NETWORKS_SHOT);
    await page.close();
  }

  // -------------------------------------------------------------------------
  // Scene 2 — networks-010: a design declared at schema 0.10 still opens.
  // -------------------------------------------------------------------------
  {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=networks-010`);
    await openNetworksList(page);
    check('0.10 design: Networks list opens with no uncaught errors', pageErrors.length === 0, pageErrors.join(' | '));
    // The seeded devices carry no VLAN or subnet of their own -- open+render
    // is the whole proof they were read at all; a write below is "assert
    // each scene saved at least once" — a 0.10-declared design must still
    // SAVE (not just open) through the real engine.
    await page.locator('.inventory-place__kind', { hasText: 'Devices' }).click();
    const deviceCount = await page.locator('.inventory-place__kind', { hasText: 'Devices' }).locator('.inventory-place__count').innerText();
    check('0.10 design: all 5 sketch devices are read back', deviceCount === '5', deviceCount);

    await page.locator('.inventory-place__kind', { hasText: 'Networks' }).click();
    await page.waitForSelector('.networks-panel', { timeout: 15_000 });
    await fillAddSubnet(page, { device: 'sketch-e', port: 'wg0', prefix: '10.9.0.0/24', address: '10.9.0.1/24', name: 'Road warriors' });
    await page.waitForTimeout(200);
    check('0.10 design: the write lands', (await summaryText(page)).includes('1 subnet ·'), await summaryText(page));

    check('networks-010: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await checkEveryScene(page, 'networks-010');

    await page.screenshot({ path: SHOTS + 'networks-010.png' });
    console.log('    wrote ' + SHOTS + 'networks-010.png');
    await page.close();
  }

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
