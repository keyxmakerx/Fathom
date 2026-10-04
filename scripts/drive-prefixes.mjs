// Proves the Prefixes and VLANs kinds (round 9, r9-ipam-a) against the real compiled client: the rail
// counts them, a prefix opens to a grid and its addresses with the next free one, a clash reads
// "same address twice", a typed address lands on a device interface, a prefix with no owner is
// refused, and pasted rows are one undo step. Same harness as drive-inventory.mjs.
// Usage: node scripts/drive-prefixes.mjs  (FATHOM_SHOTS picks the screenshot dir)
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
  const shot = async (name) => {
    await page.screenshot({ path: SHOTS + name });
    console.log('    wrote ' + SHOTS + name);
  };

  await page.goto(`${BASE}/drive.html?scene=ipam`);
  await page.waitForSelector('.drawing', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  await page.waitForSelector('.inventory-place__rail', { timeout: 15_000 });
  const rail = () => page.locator('.inventory-place__rail').innerText().then((t) => t.replace(/\s+/g, ' '));

  // 1 - the rail counts prefixes and VLANs, after Networks.
  await page.waitForFunction(() => /Prefixes\s*3/.test(document.querySelector('.inventory-place__rail')?.textContent ?? ''), null, { timeout: 5_000 }).catch(() => {});
  const railText = await rail();
  check('the rail counts 3 prefixes', /Prefixes 3/.test(railText), railText);
  check('the rail counts 1 VLAN', /VLANs 1/.test(railText), railText);
  check('Prefixes and VLANs come after Networks', /Networks \d+ Prefixes 3 VLANs 1/.test(railText), railText);

  // 2 - the prefix table.
  await page.locator('.inventory-place__kind', { hasText: 'Prefixes' }).click();
  await page.waitForSelector('.inv-table__row', { timeout: 5_000 });
  const rowsText = await page.locator('.inv-table__row').allInnerTexts();
  check('three prefix rows', rowsText.length === 3, String(rowsText.length));
  const storage = rowsText.find((t) => t.includes('10.0.20.0/24')) ?? '';
  check('the storage prefix shows VLAN, site, used and gateway', /20 · Storage/.test(storage) && /Premises/.test(storage) && /3\/254/.test(storage) && /10\.0\.20\.1\s+fw-01/.test(storage), storage.replace(/\s+/g, ' '));
  check('the used column draws a bar', (await page.locator('.inv-table__bar').count()) === 3);
  await shot('prefixes-01-table.png');

  // 3 - sorting by used.
  await page.getByRole('columnheader', { name: 'Used' }).click();
  const first = (await page.locator('.inv-table__row').first().innerText()).replace(/\s+/g, ' ');
  check('sorting by used puts the emptiest first', first.includes('172.16.0.0/16'), first);

  // 4 - open a prefix: grid, addresses, next free.
  await page.locator('.inv-table__row', { hasText: '10.0.20.0/24' }).first().click();
  await page.waitForSelector('.ipam-grid', { timeout: 5_000 });
  check('the grid has one cell per usable address', (await page.locator('.ipam-grid__cell').evaluateAll((els) => els.filter((e) => e.closest('.ipam-grid')).length)) === 254);
  check('three cells are used or shared', (await page.locator('.ipam-grid [data-state=used], .ipam-grid [data-state=shared]').count()) === 3);
  check('one cell is ringed (on two devices)', (await page.locator('.ipam-grid [data-state=shared]').count()) === 1);
  const pageText = (await page.locator('.ipam-page').innerText()).replace(/\s+/g, ' ');
  check('the page says 3/254 used and the next free address', /3\/254 used · next free 10\.0\.20\.2/.test(pageText), pageText.slice(0, 200));
  const listText = (await page.locator('.ipam-list').innerText()).replace(/\s+/g, ' ');
  check('addresses show what they are on', /10\.0\.20\.15 nas-01 eth0 typed/.test(listText), listText);
  check('the free stretches are listed with the next free one', /10\.0\.20\.2–14 free · next free 10\.0\.20\.2/.test(listText) && /10\.0\.20\.17–254 free/.test(listText), listText);
  check('a clash reads "same address twice" with who else has it', /also on cam-07/.test(listText) && /also on nas-02/.test(listText) && (listText.match(/same address twice/g) ?? []).length === 2, listText);
  check('full is not a warning: no danger colour on the page', (await page.locator('.ipam-page [class*=danger]').count()) === 0);
  await shot('prefixes-02-page.png');

  // 5 - a big range gets a coarse grid.
  await page.locator('.inv-table__row', { hasText: '172.16.0.0/16' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.ipam-grid .ipam-grid__cell').length === 256);
  check('a /16 draws 256 coarse squares', true);
  check('the coarse grid says how many addresses a square is', (await page.locator('.ipam-legend').innerText()).includes('256 addresses'));
  await shot('prefixes-03-coarse.png');

  // 6 - typing an address writes it to a device interface; one undo removes it.
  await page.locator('.inv-table__row', { hasText: '10.0.20.0/24' }).first().click();
  await page.waitForSelector('.ipam-grid');
  const form = page.getByRole('form', { name: 'Add an address' });
  await form.getByLabel('Address').fill('10.0.20.2');
  await form.getByLabel('Device').selectOption({ label: 'nas-01' });
  await form.getByLabel('Interface').selectOption({ index: 1 });
  await form.getByRole('button', { name: 'Add address' }).click();
  await page.waitForFunction(() => /4\/254 used/.test(document.querySelector('.ipam-page')?.textContent ?? ''), null, { timeout: 5_000 });
  const after = (await page.locator('.ipam-list').innerText()).replace(/\s+/g, ' ');
  check('the typed address is listed on nas-01 and the next free moves on', /10\.0\.20\.2 nas-01 eth0 typed/.test(after) && /next free 10\.0\.20\.3/.test((await page.locator('.ipam-page').innerText()).replace(/\s+/g, ' ')), after);
  await shot('prefixes-04-added.png');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(() => /3\/254 used/.test(document.querySelector('.ipam-page')?.textContent ?? ''), null, { timeout: 5_000 });
  check('one Undo takes the address away again', true);

  // 7 - an address outside the prefix is refused in plain words.
  await form.getByLabel('Address').fill('10.9.9.9/24');
  await form.getByLabel('Device').selectOption({ label: 'nas-01' });
  await form.getByLabel('Interface').selectOption({ index: 1 });
  await form.getByRole('button', { name: 'Add address' }).click();
  check('an address outside the prefix is refused plainly', (await page.locator('.ipam-form__error').innerText()).includes('not inside 10.0.20.0/24'));

  // 8 - a new prefix with no device interface is refused, not left orphaned.
  await page.getByRole('button', { name: '+ Add a prefix' }).click();
  await page.getByLabel('Prefix', { exact: true }).fill('10.0.40.0/24');
  await page.getByRole('button', { name: 'Add prefix' }).click();
  check('a prefix with no owner is refused with a plain message', (await page.locator('.ipam-form__error').innerText()).includes('Put it on a device interface'));
  check('no orphan prefix was made', /Prefixes 3/.test(await rail()));
  const add = page.getByRole('complementary', { name: 'Add a prefix' });
  await add.getByLabel('Address').fill('10.0.40.1');
  await add.getByLabel('Device').selectOption({ label: 'fw-01' });
  await add.getByLabel('Interface').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Add prefix' }).click();
  await page.waitForFunction(() => /Prefixes\s*4/.test((document.querySelector('.inventory-place__rail')?.textContent ?? '').replace(/\s+/g, ' ')), null, { timeout: 5_000 });
  check('with an owner the prefix is made and opens', (await page.locator('.ipam-page').innerText()).includes('10.0.40.0/24'));
  await shot('prefixes-05-new.png');

  // 9 - paste rows: header row, two good rows and one without an owner; one undo takes them all.
  await page.getByRole('button', { name: 'Paste rows' }).click();
  await page.getByLabel('Pasted rows').fill('Prefix\tAddress\tDevice\tInterface\n10.0.50.0/24\t10.0.50.1/24\tfw-01\tge-0/0/1\n10.0.51.0/24\t10.0.51.1/24\tnas-01\teth0\n10.0.52.0/24\t10.0.52.1/24\t\t');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForFunction(() => /Prefixes\s*6/.test((document.querySelector('.inventory-place__rail')?.textContent ?? '').replace(/\s+/g, ' ')), null, { timeout: 5_000 });
  const notice = await page.locator('.inv-toolbar__notice').innerText();
  check('pasting names the row it could not place', /2 added, 1 not added/.test(notice) && notice.includes('Put it on a device interface'), notice);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(() => /Prefixes\s*4/.test((document.querySelector('.inventory-place__rail')?.textContent ?? '').replace(/\s+/g, ' ')), null, { timeout: 5_000 });
  check('one Undo takes the whole paste away', true);

  // 10 - VLANs.
  await page.locator('.inventory-place__kind', { hasText: 'VLANs' }).click();
  await page.waitForSelector('.inv-table__row');
  const vlanRow = (await page.locator('.inv-table__row').first().innerText()).replace(/\s+/g, ' ');
  check('the VLAN row shows number, name, prefix and device', /20 Storage 10\.0\.20\.0\/24/.test(vlanRow) && vlanRow.includes('fw-01'), vlanRow);
  await page.locator('.inv-table__row').first().click();
  await page.waitForSelector('.ipam-page');
  check('the VLAN page lists its prefix and members', (await page.locator('.ipam-page').innerText()).includes('10.0.20.0/24'));
  await page.getByRole('button', { name: '+ Add a VLAN' }).click();
  await page.getByLabel('VLAN number').fill('30');
  await page.getByLabel('Name').fill('Cameras');
  await page.getByRole('button', { name: 'Add VLAN' }).click();
  check('a VLAN with no device is refused', (await page.locator('.ipam-form__error').innerText()).includes('Put it on a device'));
  await page.getByLabel('Device').selectOption({ label: 'cam-07' });
  await page.getByRole('button', { name: 'Add VLAN' }).click();
  await page.waitForFunction(() => /VLANs\s*2/.test((document.querySelector('.inventory-place__rail')?.textContent ?? '').replace(/\s+/g, ' ')), null, { timeout: 5_000 });
  check('with a device the VLAN is made', true);
  await shot('prefixes-06-vlans.png');

  const saveCount = await page.evaluate(() => window.__saveCount__ ?? 0);
  check('the scene saved', saveCount > 0, `saveCount=${saveCount}`);
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
