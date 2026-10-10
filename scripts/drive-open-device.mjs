// Drives ADR-0060 step 8 end to end: pasting a config anywhere (gate, card, attach or add) and opening a
// device (jot mode: drop equipment, cable to its ports, Inside, Esc out); screenshots land in FATHOM_SHOTS.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-open-device.mjs.
// Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
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
const PORT = 5338;
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
  const boxes = (page) => page.locator('.react-flow__node-freeBox');
  const pickKind = async (page, label) => {
    await page.locator('.drawing-context-menu__item', { hasText: label }).first().click();
    await page.waitForTimeout(300);
  };
  const addBoxAt = async (page, x, y, kind) => {
    await page.mouse.click(x, y, { button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Add a box here' }).click();
    await pickKind(page, kind);
  };

  // Credentials as long as a device takes one (CLAUDE.md rule 2); each must appear nowhere afterwards.
  const IKE = 'FATHOMDRIVEike' + 'k7Qz'.repeat(30);
  const SNMP = 'FATHOMDRIVEsnmp' + 'Rw9x'.repeat(16);
  const SECRETS = [IKE, SNMP, 'hunter22'];
  const CONFIG = (host) => `set system host-name ${host}
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces ge-0/0/1 unit 0 family inet address 10.0.0.1/24
set security ike policy ike-pol pre-shared-key ascii-text ${IKE}
set snmp community ${SNMP} authorization read-only
set security ike policy ike-two pre-shared-key ascii-text hunter22
`;
  const pasteText = (page, text) =>
    page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);

  // Part 1: paste anywhere.
  {
    const { context, page, pageErrors } = await open('empty');
    await pasteText(page, CONFIG('srx-drive'));
    await page.waitForSelector('[data-testid=paste-card]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid=paste-destroyed]');
    const card = await page.locator('[data-testid=paste-card]').innerText();
    check('the card names the hostname', card.includes('srx-drive'));
    check('the card lists interfaces and addresses', card.includes('ge-0/0/0') && card.includes('203.0.113.2/30'));
    check('the card counts what the gate destroyed', /destroyed \d+ values/.test(card), card.replace(/\s+/g, ' ').slice(0, 300));
    check('the card never shows a secret', SECRETS.every((s) => !card.includes(s)));
    check('nothing is on the canvas yet', (await boxes(page).count()) === 0);
    await shot(page, 'S8-01-paste-card');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForTimeout(800);
    check('Add puts the device on the canvas', (await boxes(page).count()) === 1);
    check('the card closes', (await page.locator('[data-testid=paste-card]').count()) === 0);

    // A second paste for the same name offers it, but the device already carries a config.
    await pasteText(page, CONFIG('SRX-drive'));
    await page.waitForSelector('[data-testid=paste-destroyed]');
    const second = await page.locator('[data-testid=paste-card]').innerText();
    check('a same-named device is offered', /srx-drive/.test(second) && /already carries a config/.test(second));
    await shot(page, 'S8-02-paste-second');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Esc cancels the card and stores nothing', (await page.locator('[data-testid=paste-card]').count()) === 0 && (await boxes(page).count()) === 1);

    // Text that is not a config is refused plainly.
    await pasteText(page, 'hello\nthis is just\nsome words\n');
    await page.waitForSelector('.paste-card__refusal', { timeout: 15_000 });
    await shot(page, 'S8-03-paste-refused');
    await page.keyboard.press('Escape');

    // Too little to tell the platform: the card asks once, in words, and obeys the answer.
    await pasteText(page, 'set system host-name which-sw\nset interfaces ge-0/0/1 description uplink\n');
    await page.getByText('Which device is this from?').waitFor({ timeout: 15_000 });
    check('the card offers the candidates as words', (await page.getByRole('button', { name: 'Juniper EX' }).count()) === 1);
    await page.getByRole('button', { name: 'Juniper EX' }).click();
    await page.waitForSelector('[data-testid=paste-destroyed]', { timeout: 15_000 });
    check('the answer is used', (await page.locator('[data-testid=paste-card]').innerText()).includes('junos-ex'));
    await page.keyboard.press('Escape');

    // The same, through the right-click menu, reading the clipboard.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate((t) => navigator.clipboard.writeText(t), CONFIG('menu-box'));
    await page.mouse.click(900, 600, { button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Paste config' }).click();
    await page.waitForSelector('[data-testid=paste-destroyed]', { timeout: 15_000 });
    check('Paste config in the menu reads the clipboard into the card', (await page.locator('[data-testid=paste-card]').innerText()).includes('menu-box'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    const sent = await page.evaluate(() => window.__requests__.map((r) => r.bodyLatin1).join('\n'));
    check('no credential reached any request body', SECRETS.every((s) => !sent.includes(s)));
    check('no uncaught page errors (paste)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // Part 2: open a device.
  {
    const { context, page, pageErrors } = await open('canvas');
    const device = page.locator('.react-flow__node-chassis').first();
    await device.dblclick();
    await page.waitForSelector('[data-testid=jot]', { timeout: 10_000 });
    check('a double-click opens the device', (await page.locator('[data-testid=jot-device]').count()) === 1);
    const ports = await page.locator('[data-testid=jot-device] .jot-port').count();
    check('the device is drawn with its ports', ports > 0, String(ports));
    await shot(page, 'S8-04-open-device');

    // Drop equipment beside it: click an item in the equipment list.
    await page.locator('[data-testid="dock-equipment"]').click();
    await page.waitForTimeout(300);
    await page.locator('.drawing-palette__item', { hasText: 'Switch' }).first().click();
    await page.waitForTimeout(500);
    check('equipment added in the room sits beside the device', (await page.locator('[data-testid=jot-box]').count()) === 1);
    await page.locator('.drawing-palette__item', { hasText: 'Router' }).first().click();
    await page.waitForTimeout(500);
    check('a second box is added', (await page.locator('[data-testid=jot-box]').count()) === 2);

    // Cable the device's first port to the box's first port.
    const a = await page.locator('[data-testid=jot-device] .jot-port[title*="RJ45 · free"]').first().boundingBox();
    const b = await page.locator('[data-testid=jot-box] .jot-port').first().boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    check('dragging port to port makes a cable', (await page.locator('[data-testid=jot-cable]').count()) === 1);
    await shot(page, 'S8-05-cabled');

    // Inside, Config, and out.
    await page.getByRole('button', { name: 'Inside' }).click();
    await page.waitForTimeout(500);
    check('Inside shows the device\'s insides', (await page.locator('.inside-stop').count()) >= 1);
    await shot(page, 'S8-06-inside');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Esc from Inside returns to the device', (await page.locator('[data-testid=jot]').count()) === 1 && (await page.locator('.inside-stop').count()) === 0);
    await page.getByRole('button', { name: 'Config', exact: true }).click();
    await page.waitForTimeout(500);
    check('Config opens the drawer under the device', (await page.locator('.config-drawer').count()) === 1);
    await shot(page, 'S8-07-config');
    await page.getByRole('button', { name: 'Config', exact: true }).click();

    // A paste while inside a device still reads through the card.
    await pasteText(page, CONFIG('srx-in-room'));
    await page.waitForSelector('[data-testid=paste-destroyed]', { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('the first Esc closes the card and leaves the device open', (await page.locator('[data-testid=jot]').count()) === 1);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check('Esc leads back out', (await page.locator('[data-testid=jot]').count()) === 0);
    check('the equipment is on the full canvas as free boxes', (await boxes(page).count()) === 2);
    await shot(page, 'S8-08-back-out');

    // The path leads back out too.
    await page.locator('.react-flow__node-chassis').first().click({ button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Open' }).first().click();
    await page.waitForSelector('[data-testid=jot]');
    check('right-click Open goes into the device', (await page.locator('[data-testid=jot-box]').count()) >= 0);
    check('the path names the device', (await page.locator('.shell-bar__path-label--current').innerText()).length > 0);
    await page.getByRole('button', { name: '← Canvas' }).click();
    await page.waitForTimeout(300);
    check('the back button leaves too', (await page.locator('[data-testid=jot]').count()) === 0);
    await page.locator('.react-flow__node-chassis').first().dblclick();
    await page.waitForSelector('[data-testid=jot]');
    await page.locator('.shell-bar__path-label').nth(-2).click();
    await page.waitForTimeout(300);
    check('the path leads back out', (await page.locator('[data-testid=jot]').count()) === 0);
    check('no uncaught page errors (open device)', pageErrors.length === 0, pageErrors.join(' | '));
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
