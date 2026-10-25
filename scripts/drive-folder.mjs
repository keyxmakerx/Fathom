// Drives a dropped folder of configs (sign-off r29-pull A): three files dropped on the canvas open one card; the config
// naming a drawn device attaches to it, the one naming no drawn device is a new device, the LLDP list is left with its
// reason; Add writes both and no secret reaches the page. Screenshots land in FATHOM_SHOTS. Usage: bash
// scripts/build-wasm.sh (once), then node scripts/drive-folder.mjs. Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
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
const PORT = 5349;
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

// Step 1: copy the shared throwaway harness into `client/`. Refuses to run
// if any of these already exists, so it never overwrites another run's files.
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fathom — proof preview (throwaway, not shipped)</title>
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

  // -------------------------------------------------------------------------
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  async function open(scene, opts = {}) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=${scene}`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(600);
    return { context, page, pageErrors };
  }
  const shot = async (page, name) => {
    await page.screenshot({ path: SHOTS + name + '.png' });
    console.log('    wrote ' + SHOTS + name + '.png');
  };

  const IKE = 'FATHOMDRIVEike' + 'k7Qz'.repeat(30);
  const SRX = (host) => [
    `set system host-name ${host}`,
    'set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30',
    'set interfaces ge-0/0/1 unit 0 family inet address 10.0.0.1/24',
    `set security ike policy ike-pol pre-shared-key ascii-text ${IKE}`,
    'set security zones security-zone trust interfaces ge-0/0/1.0',
    '',
  ].join('\n');
  const LLDP = [
    'Local Interface    Parent Interface    Chassis Id          Port info          System Name',
    'ge-0/0/0           -                   00:1b:21:3a:4f:10   eth0               nas-1',
    '',
  ].join('\n');
  const FILES = [
    ['srx-edge.conf', SRX('srx-edge')],
    ['srx-branch.conf', SRX('srx-branch')],
    ['lldp.txt', LLDP],
  ];
  const drop = (page, files) => page.evaluate((list) => {
    const data = new DataTransfer();
    for (const [name, text] of list) data.items.add(new File([text], name, { type: 'text/plain' }));
    const target = document.querySelector('.react-flow__pane');
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, files);

  for (const scheme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=folder`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(800);

    await drop(page, FILES);
    const card = page.getByTestId('folder-card');
    await card.waitFor({ timeout: 8000 }).catch(() => {});
    check(`three dropped files open the folder card (${scheme})`, (await card.count()) === 1 && (await page.getByTestId('paste-card').count()) === 0);
    const said = await card.innerText().catch(() => '');
    check(`srx-edge gets its first config, srx-branch is new (${scheme})`, /srx-edge\s+its first config/.test(said) && /srx-branch\s+a new device/.test(said), said.slice(0, 600));
    check(`the LLDP list is left with its reason (${scheme})`, /lldp\.txt: Not a config/.test(said));
    check(`the gate's count is said, never the value (${scheme})`, /The gate destroyed 2 values/.test(said) && !said.includes(IKE), said.slice(0, 600));
    check(`both rows are ticked (${scheme})`, (await card.locator('input[type=checkbox]:checked').count()) === 2);
    await shot(page, `FO-01-card-${scheme}`);

    await card.getByRole('button', { name: 'Add 2' }).click();
    await page.waitForTimeout(900);
    check(`Add closes the card (${scheme})`, (await card.count()) === 0);
    check(`srx-branch is on the canvas (${scheme})`, (await page.locator('.react-flow__node-freeBox', { hasText: 'srx-branch' }).count()) === 1);
    check(`srx-edge is still one box (${scheme})`, (await page.locator('.react-flow__node-freeBox', { hasText: 'srx-edge' }).count()) === 1);
    check(`no secret reached the page (${scheme})`, !(await page.content()).includes(IKE));
    await shot(page, `FO-02-added-${scheme}`);

    // The same folder again: srx-edge now carries a config, so it is compared, and nothing in it changed.
    await drop(page, FILES.slice(0, 1).concat([['srx-other.conf', SRX('srx-other')]]));
    await card.waitFor({ timeout: 8000 }).catch(() => {});
    const again = await card.innerText().catch(() => '');
    check(`a device with a config is compared, not added (${scheme})`, /srx-edge: Nothing changed since the copy in the drawing/.test(again), again.slice(0, 600));
    await shot(page, `FO-03-compare-${scheme}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check(`Esc closes it (${scheme})`, (await card.count()) === 0);
    check(`no uncaught page errors (${scheme})`, pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // One file dropped is a paste: the config card opens.
  {
    const { context, page, pageErrors } = await open('folder');
    await drop(page, [['srx-edge.conf', SRX('srx-edge')]]);
    await page.waitForTimeout(800);
    check('one dropped file opens the paste card', (await page.getByTestId('paste-card').count()) === 1 && (await page.getByTestId('folder-card').count()) === 0);
    check('no uncaught page errors (one file)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }
} finally {
  // Cleanup, even on failure — nothing the harness needs may stay in `client/`.
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
