// Drives who is plugged in where (sign-off r29-fill, mockup r29-autofill-a): select a switch, paste its MAC table
// onto the canvas, add the router's ARP table in the card, see a new device and a cable to a drawn port suggested,
// add them as one undo step. Screenshots land in FATHOM_SHOTS. Usage: bash scripts/build-wasm.sh (once), then
// node scripts/drive-hosts.mjs. Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
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
const PORT = 5348;
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

  const MACS = [
    'Vlan    Mac Address       Type        Ports',
    '----    -----------       --------    -----',
    ' 100    9c54.1631.8bd1    DYNAMIC     Gi1/0/5',
    ' 100    000f.fe84.bb73    DYNAMIC     Gi1/0/7',
    ' 200    000a.b837.b5dd    DYNAMIC     Gi1/0/24',
    ' 200    000f.206f.dc5d    DYNAMIC     Gi1/0/24',
    'Total Mac Addresses for this criterion: 4',
    '',
  ].join('\n');
  const ARP = [
    'Protocol  Address       Age(min)Hardware Addr  Type Interface',
    'Internet  192.168.10.20 9       9c54.1631.8bd1 ARPA Vlan100',
    '',
  ].join('\n');

  for (const scheme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=hosts`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(800);
    const boxesBefore = await page.locator('.react-flow__node-freeBox').count();

    await page.locator('.react-flow__node-freeBox', { hasText: 'switch-1' }).first().click();
    await page.evaluate((text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    }, MACS);
    await page.waitForTimeout(500);
    const card = page.getByTestId('hosts-card');
    check(`a pasted MAC table opens the hosts card, not the config card (${scheme})`, (await card.count()) === 1 && (await page.getByTestId('paste-card').count()) === 0);
    const first = await card.innerText().catch(() => '');
    check(`one new device, one cable to nas-1, one port left (${scheme})`, /new: host-318bd1/.test(first) && /nas-1/.test(first) && /2 addresses/.test(first) && /another switch or an access point/.test(first), first.slice(0, 500));
    check(`the cable to the drawn port shows as a dashed line (${scheme})`, (await page.locator('[data-plan-ghost]').count()) === 1);
    await shot(page, `HO-01-read-${scheme}`);

    await card.locator('textarea').fill(ARP);
    await card.getByRole('button', { name: 'Read addresses' }).click();
    await page.waitForTimeout(300);
    const named = await card.innerText();
    check(`the ARP table names the new device (${scheme})`, /new: host-192-168-10-20/.test(named) && /1 address read/.test(named), named.slice(0, 500));
    await shot(page, `HO-02-addresses-${scheme}`);

    await card.getByRole('button', { name: /Add 1 device and 2 cables/i }).click();
    await page.waitForTimeout(700);
    check(`Add closes the card (${scheme})`, (await page.getByTestId('hosts-card').count()) === 0);
    check(`the new device is on the canvas (${scheme})`, (await page.locator('.react-flow__node-freeBox', { hasText: 'host-192-168-10-20' }).count()) === 1);
    check(`no dashed lines remain (${scheme})`, (await page.locator('[data-plan-ghost]').count()) === 0);
    await shot(page, `HO-03-added-${scheme}`);

    await page.mouse.click(1100, 800);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(500);
    check(`one undo takes it all back (${scheme})`, (await page.locator('.react-flow__node-freeBox').count()) === boxesBefore);
    check(`no uncaught page errors (${scheme})`, pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // A MAC table typed into the cables card's box switches it over.
  {
    const { context, page, pageErrors } = await open('hosts');
    await page.locator('.react-flow__node-freeBox', { hasText: 'switch-1' }).first().click({ button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Suggest cables from its neighbours (LLDP)' }).click();
    const card = page.getByTestId('suggest-card');
    await card.waitFor({ timeout: 5000 });
    check('the cables card says a MAC table works too', /show mac address-table/.test(await card.innerText()));
    await card.locator('textarea').fill(MACS);
    await card.getByRole('button', { name: 'Read it' }).click();
    await page.waitForTimeout(400);
    check('a MAC table read in the cables card opens the hosts card', (await page.getByTestId('hosts-card').count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check('Esc closes it', (await page.getByTestId('hosts-card').count()) === 0);
    check('no uncaught page errors (menu)', pageErrors.length === 0, pageErrors.join(' | '));
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
