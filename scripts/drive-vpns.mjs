// Drives the VPNs layer (sign-off r16-overlay) on the real App over the `canvas` scene: add a tailnet of three
// devices and a two-device NetBird tunnel by hand in Inventory, see a key, a bad route and a bad address refused,
// then tick Show > VPNs on the Diagram look and see one badge with three dashed spokes, one dashed line between
// the two, the addresses under the boxes, and the card a badge opens. Usage: bash scripts/build-wasm.sh (once),
// then node scripts/drive-vpns.mjs.
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
  || '/opt/pw-browsers/chromium';
const CLIENT = ROOT + '/client';
const DRIVE_LIB = ROOT + '/scripts/drive-lib';
const PORT = 5351;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/vpns'}/`;
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
  const shot = async (page, name) => {
    await page.screenshot({ path: SHOTS + 'vpns-' + name + '.png' });
    console.log('    wrote ' + SHOTS + 'vpns-' + name + '.png');
  };
  async function open({ w = 1400, h = 900, dark = false } = {}) {
    const context = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light' });
    // A real paste (Ctrl+V of what the page's own clipboard holds) needs these.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=canvas`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(1200);
    return { context, page, pageErrors };
  }
  const T = (page, id) => page.locator(`[data-testid=${id}]`);
  const settle = (page, ms = 700) => page.waitForTimeout(ms);
  const optionTexts = (sel) => sel.locator('option').allInnerTexts();
  // Pick an option by a pattern on its text (the design's own names, never typed ids).
  async function pick(sel, re) {
    const texts = await optionTexts(sel);
    const i = texts.findIndex((t) => re.test(t));
    if (i < 0) throw new Error(`no option ${re} in ${texts.join(' | ')}`);
    await sel.selectOption({ index: i });
    return texts[i];
  }


  const vpns = (page) => page.locator('section.vpns');
  async function toInventory(page) {
    await page.locator('.shell-bar__tab', { hasText: 'Inventory' }).click();
    await page.waitForSelector('.inventory-place__kind', { timeout: 15_000 });
    await page.locator('.inventory-place__kind', { hasText: 'Networks' }).click();
    await page.waitForSelector('section.vpns', { timeout: 15_000 });
  }
  async function addVpn(page, name, provider, range) {
    await vpns(page).getByRole('button', { name: 'Add VPN' }).click();
    const f = page.getByRole('form', { name: 'Add VPN' });
    await f.getByLabel('Name').fill(name);
    await f.getByLabel('Provider').selectOption(provider);
    await f.getByLabel('Range').fill(range);
    await f.getByRole('button', { name: 'Add VPN' }).click();
    await settle(page, 400);
  }
  async function addMember(page, re, address) {
    const f = page.getByRole('form', { name: 'Add a device to the VPN' });
    await pick(f.getByLabel('Device'), re);
    await f.getByLabel('Its VPN address').fill(address);
    await f.getByRole('button', { name: 'Add' }).click();
    await settle(page, 400);
  }
  const member = (page, host) => vpns(page).locator('.vpns__member', { hasText: host });

  for (const dark of [false, true]) {
    const tag = dark ? 'dark' : 'light';
    const { context, page, pageErrors } = await open({ dark });
    await toInventory(page);
    check(`[${tag}] Inventory shows the VPNs section, empty`, /No VPNs yet/.test(await vpns(page).innerText()));

    await addVpn(page, 'Home tailnet', 'tailscale', '100.64.0.0/10');
    check(`[${tag}] the new VPN is open for its members`, (await page.getByRole('form', { name: 'Add a device to the VPN' }).count()) === 1);
    await addMember(page, /^fw-01$/, '100.71.4.20');
    await addMember(page, /^core-sw-01$/, '100.71.4.2');
    await addMember(page, /^sw-02$/, '100.71.4.9');
    check(`[${tag}] three members`, (await vpns(page).locator('.vpns__member').count()) === 3);

    // sw-02 is the exit node and offers a route; a key or a non-prefix in the routes is refused.
    await member(page, 'sw-02').getByLabel('Exit node').check();
    await settle(page, 400);
    await member(page, 'sw-02').getByLabel('sw-02 subnet routes').fill('10.0.10.0/24, 2WF+k/FE9kbKAlAY1+B/UTfUyDHuo2ufDyiYu17aQ+U=');
    await member(page, 'sw-02').getByRole('button', { name: 'Save' }).click();
    await settle(page, 300);
    const refused = await member(page, 'sw-02').locator('.vpns__error').innerText().catch(() => '');
    check(`[${tag}] a key pasted as a route is refused`, /is not a route/.test(refused), refused);
    await member(page, 'sw-02').getByLabel('sw-02 subnet routes').fill('10.0.10.0/24');
    await member(page, 'sw-02').getByRole('button', { name: 'Save' }).click();
    await settle(page, 400);
    check(`[${tag}] the route is kept`, (await member(page, 'sw-02').getByLabel('sw-02 subnet routes').inputValue()) === '10.0.10.0/24');
    await member(page, 'fw-01').getByLabel('fw-01 VPN address').fill('fd7a:115c:a1e0::1');
    await member(page, 'fw-01').getByRole('button', { name: 'Save' }).click();
    await settle(page, 300);
    check(`[${tag}] an IPv6 address is refused, not guessed`, /is not an IPv4 address/.test(await member(page, 'fw-01').locator('.vpns__error').innerText().catch(() => '')));
    await shot(page, `01-inventory-${tag}`);

    await addVpn(page, 'netbird-home', 'netbird', '100.80.0.0/16');
    await addMember(page, /^fw-01$/, '100.80.1.1');
    await addMember(page, /^core-sw-01$/, '100.80.1.2');
    const listed = await vpns(page).locator('.vpns__row-head').allInnerTexts();
    check(`[${tag}] two VPNs listed`, listed.length === 2 && /Home tailnet/.test(listed[0]) && /3 members/.test(listed[0]) && /netbird-home/.test(listed[1]), listed.map((t) => t.replace(/\s+/g, ' ')).join(' | '));

    await page.locator('.shell-bar__tab', { hasText: 'Canvas' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    // The bar folds the look switch into the View menu when it is narrow.
    if ((await page.getByLabel('Look').count()) > 0) await page.getByLabel('Look').getByRole('button', { name: 'Diagram', exact: true }).click();
    else {
      await page.getByTestId('shell-view-menu').click();
      await page.getByRole('group', { name: 'View' }).getByText('Diagram', { exact: true }).click();
    }
    await page.waitForSelector('.drawing-diagram-box');
    check(`[${tag}] VPNs are off by default: nothing drawn`, (await page.locator('.drawing-vpn__badge').count()) === 0);
    await page.getByTestId('shell-show').click();
    await page.getByTestId('show-vpns').click();
    await page.keyboard.press('Escape');
    await settle(page, 600);
    await page.click('button[aria-label="Fit to view"]').then(() => settle(page, 700));
    const badges = await page.locator('.drawing-vpn__badge').allInnerTexts();
    check(`[${tag}] one badge for the tailnet, one named line for the tunnel`, badges.length === 2 && badges.some((t) => /Home tailnet/.test(t) && /3 members/.test(t)) && badges.some((t) => /netbird-home/.test(t) && !/members/.test(t)), badges.join(' | '));
    const spokes = await page.locator('.drawing-vpn__spoke').count();
    check(`[${tag}] three spokes and one line`, spokes === 4, String(spokes));
    const dashed = await page.locator('.drawing-vpn__spoke').first().evaluate((el) => getComputedStyle(el).strokeDasharray);
    check(`[${tag}] the lines are dashed`, dashed !== 'none' && dashed !== '', dashed);
    const words = await page.locator('.drawing-diagram-box__words').allInnerTexts();
    check(`[${tag}] each member's VPN address is under its box`, ['100.71.4.20', '100.71.4.2', '100.71.4.9'].every((a) => words.some((w) => w.split(' · ').includes(a))), words.join(' | '));
    // No badge sits on a box.
    const clash = await page.evaluate(() => {
      const r = (e) => e.getBoundingClientRect();
      const boxes = [...document.querySelectorAll('.drawing-diagram-box')].map(r);
      return [...document.querySelectorAll('.drawing-vpn__badge:not(.drawing-vpn__badge--line)')].map(r).some((b) => boxes.some((a) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
    });
    check(`[${tag}] the badge sits on no box`, !clash);
    await shot(page, `02-canvas-${tag}`);

    await page.locator('.drawing-vpn__badge', { hasText: 'Home tailnet' }).click();
    await settle(page, 300);
    const card = (await page.locator('.drawing-vpn-card').innerText()).replace(/\s+/g, ' ');
    check(`[${tag}] the card says range, members, exit node and route`, /Tailnet · Tailscale/i.test(card) && /100\.64\.0\.0\/10/.test(card) && /100\.71\.4\.2/.test(card) && /Exit node sw-02/.test(card) && /10\.0\.10\.0\/24 via sw-02/.test(card), card);
    await shot(page, `03-card-${tag}`);
    await page.locator('.react-flow__pane').click({ position: { x: 400, y: 60 } });
    await settle(page, 300);
    check(`[${tag}] clicking the canvas closes the card`, (await page.locator('.drawing-vpn-card').count()) === 0);

    await page.getByTestId('shell-show').click();
    await page.getByTestId('show-vpns').click();
    await page.keyboard.press('Escape');
    await settle(page, 400);
    check(`[${tag}] unticking takes the VPNs away`, (await page.locator('.drawing-vpn__badge').count()) === 0 && (await page.locator('.drawing-vpn__spoke').count()) === 0);
    check(`[${tag}] no uncaught page errors`, pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  await browser.close();
  browser = null;
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
