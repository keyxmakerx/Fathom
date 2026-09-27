// Drives the Networks list's Docker section (ADR-0058) through the real App in a real
// browser, fetch answered by the shared harness; every save is loaded through a second real
// engine, so a save the server would refuse fails.
// Scene: `docker` (one sketch host, no rack) — a bridge network with a subnet, two containers
// with addresses, and a published port 8080 to 80/tcp, all added through the real editor.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-docker.mjs.
// Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT, FATHOM_SHOTS.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDriveCpuThrottle } from './drive-lib/cpuThrottle.mjs';

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
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });
const DOCKER_SHOT = SHOTS + 'docker.png';
const DOCKER_OPEN_SHOT = SHOTS + 'docker-open.png';

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
 * on Racks when there's exactly one org/design — this harness's mocked
 * backend always offers exactly that — so this crosses the "Inventory" tab. */
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

async function saveLoadFailures(page) {
  return page.evaluate(() => window.__saveLoadFailures__ ?? []);
}

async function saveCount(page) {
  return page.evaluate(() => window.__saveCount__ ?? 0);
}

async function checkEveryScene(page, sceneName) {
  const count = await saveCount(page);
  check(`${sceneName}: scene saved at least once`, count > 0, `saveCount=${count}`);
  const failures = await saveLoadFailures(page);
  check(`${sceneName}: every saved payload loaded through the engine`, failures.length === 0, failures.join(' | '));
}

async function openAddNetworkEditor(page) {
  await page.locator('.networks-panel__add').click();
  const editor = page.locator('.networks-panel__side');
  await editor.waitFor({ state: 'visible' });
  await editor.locator('.networks-editor__fchips .networks-panel__fchip', { hasText: 'Docker' }).click();
  return editor;
}

async function fillAddDockerNetwork(page, { name, host, subnet }) {
  const editor = await openAddNetworkEditor(page);
  await editor.locator('input').first().fill(name); // the "name" field, first text input
  // Two selects for a bridge network (default driver): driver first, host second.
  await editor.locator('select').nth(1).selectOption({ label: host }); // "on" — the host device
  if (subnet) await editor.locator('input[placeholder="172.18.0.0/16"]').fill(subnet);
  await editor.locator('button.networks-editor__save').click();
}

function dockerRow(page, name) {
  return page.locator('.networks-grid__cell--name', { hasText: name }).first();
}

async function openAttachContainerForm(page) {
  await page.locator('.networks-grid__open .networks-grid__link', { hasText: 'attach a container' }).click();
  return page.locator('.networks-grid__open .networks-editor__attach-row').last();
}

/** Names a brand-new container and attaches it — the form's default mode
 * when no unattached candidate exists on this host yet. */
async function fillAttachNewContainer(page, { name, address }) {
  const form = await openAttachContainerForm(page);
  await form.locator('input[placeholder="gitea"]').fill(name);
  if (address) await form.locator('input[placeholder="172.18.0.3/16 (optional)"]').fill(address);
  await form.locator('button.networks-editor__save').click();
}

/** Picks an already-live container from the dropdown — the form's default
 * mode once one exists that this network could take. */
async function fillAttachExistingContainer(page, { containerLabel, address }) {
  const form = await openAttachContainerForm(page);
  await form.locator('select').selectOption({ label: containerLabel });
  if (address) await form.locator('input[placeholder="172.18.0.3/16 (optional)"]').fill(address);
  await form.locator('button.networks-editor__save').click();
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
  // Scene — docker: a spaced, non-ASCII network name, two containers, a
  // published port, a detach; undo/redo each; every save loads through
  // the real engine.
  // -------------------------------------------------------------------------
  const page = await context.newPage();
  await applyDriveCpuThrottle(page);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/drive.html?scene=docker`);
  await openNetworksList(page);

  check('docker: starts with nothing to show', (await summaryText(page)).includes('0 networks'), await summaryText(page));

  // --- add the bridge network, a spaced non-ASCII name (ADR-0058's Text,
  // not Identifier: dockerd refuses only a blank name) -------------------
  const NETWORK_NAME = 'app net · café';
  await fillAddDockerNetwork(page, { name: NETWORK_NAME, host: 'dock-01', subnet: '172.18.0.0/16' });
  await page.waitForTimeout(200);
  check('app net · café: 1 Docker network', (await summaryText(page)).includes('1 Docker network'), await summaryText(page));

  const row = dockerRow(page, NETWORK_NAME);
  await row.click();
  await page.waitForSelector('.networks-grid__open', { timeout: 5_000 });

  // --- attach a brand-new container, with an address ----------------------
  await fillAttachNewContainer(page, { name: 'gitea', address: '172.18.0.3/16' });
  await page.waitForTimeout(200);
  let members = await page.locator('.networks-grid__member').allInnerTexts();
  check('gitea attached with its address', members.some((t) => t.includes('gitea') && t.includes('172.18.0.3/16')), members.join(' | '));

  // --- publish a port on gitea ---------------------------------------------
  await page.locator('.networks-grid__open .networks-grid__link', { hasText: 'publish a port' }).first().click();
  const portForm = page.locator('.networks-grid__open .networks-editor__attach-row').last();
  await portForm.locator('input[placeholder="80"]').fill('80');
  await portForm.locator('input[placeholder="8080 (optional)"]').fill('8080');
  await portForm.locator('button.networks-editor__save').click();
  await page.waitForTimeout(200);
  members = await page.locator('.networks-grid__member').allInnerTexts();
  check('gitea publishes 8080:80/tcp', members.some((t) => t.includes('8080:80/tcp')), members.join(' | '));

  // --- attach a second, brand-new container, no address stated ------------
  await fillAttachNewContainer(page, { name: 'grafana' });
  await page.waitForTimeout(200);
  members = await page.locator('.networks-grid__member').allInnerTexts();
  check('grafana attached, not published', members.some((t) => t.includes('grafana') && t.includes('not published')), members.join(' | '));

  // Screenshot the open row — board A draws the Docker networks group only
  // collapsed; this open state is this stream's own design.
  await page.waitForTimeout(150);
  await page.screenshot({ path: DOCKER_OPEN_SHOT });
  console.log('    wrote ' + DOCKER_OPEN_SHOT);

  // --- undo the second attach, then redo it — one batch, no orphan --------
  await page.locator('.shell-chip', { hasText: 'Undo' }).click();
  await page.waitForTimeout(300);
  members = await page.locator('.networks-grid__member').allInnerTexts();
  check('undo removes grafana, gitea remains', !members.some((t) => t.includes('grafana')) && members.some((t) => t.includes('gitea')), members.join(' | '));
  await page.locator('.shell-chip', { hasText: 'Redo' }).click();
  await page.waitForTimeout(300);
  members = await page.locator('.networks-grid__member').allInnerTexts();
  check('redo restores grafana', members.some((t) => t.includes('grafana')), members.join(' | '));

  // --- remove is refused while containers are attached: no button at all --
  const removeLink = page.locator('.networks-grid__open .networks-grid__link', { hasText: 'remove network' });
  check('remove network is not offered while containers are attached', (await removeLink.count()) === 0);

  // --- a second network, then gitea (already existing) attaches to it too -
  await row.click(); // collapse app net · café
  await fillAddDockerNetwork(page, { name: 'db_net', host: 'dock-01' });
  await page.waitForTimeout(200);
  check('db_net: 2 Docker networks', (await summaryText(page)).includes('2 Docker network'), await summaryText(page));
  const dbRow = dockerRow(page, 'db_net');
  await dbRow.click();
  await page.waitForSelector('.networks-grid__open', { timeout: 5_000 });
  await fillAttachExistingContainer(page, { containerLabel: 'gitea · this host', address: '172.19.0.2/16' });
  await page.waitForTimeout(200);
  members = await page.locator('.networks-grid__open .networks-grid__member').allInnerTexts();
  check('gitea (existing) attached to db_net too', members.some((t) => t.includes('gitea') && t.includes('172.19.0.2/16')), members.join(' | '));

  // --- detach gitea from db_net: gitea stays live, still on app net · café
  await page.locator('.networks-grid__open .networks-grid__link', { hasText: 'detach gitea' }).click();
  await page.waitForTimeout(200);
  members = await page.locator('.networks-grid__open .networks-grid__member').allInnerTexts();
  check('detach: gitea leaves db_net, db_net now empty', !members.some((t) => t.includes('gitea')), members.join(' | '));
  await dbRow.click(); // collapse db_net
  await row.click(); // reopen app net · café
  await page.waitForSelector('.networks-grid__open', { timeout: 5_000 });
  members = await page.locator('.networks-grid__open .networks-grid__member').allInnerTexts();
  check('detach: gitea is still on app net · café', members.some((t) => t.includes('gitea')), members.join(' | '));

  check('docker: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await checkEveryScene(page, 'docker');

  await page.evaluate(() => {
    document.querySelector('.networks-panel__grid-area')?.scrollTo({ left: 0, top: 0 });
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: DOCKER_SHOT });
  console.log('    wrote ' + DOCKER_SHOT);
  await page.close();

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
