// Drives cable suggestions (sign-off r15-cables, mockup r15-f3): right-click a switch, paste its LLDP neighbour
// list, see the ticked cables as dashed lines, add them as one undo step; and a list pasted onto the canvas opening
// the same card. Screenshots land in FATHOM_SHOTS. Usage: bash scripts/build-wasm.sh (once), then
// node scripts/drive-suggest.mjs. Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
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
const PORT = 5347;
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

  const LIST = [
    'Local Interface    Parent Interface    Chassis Id          Port info     System Name',
    'ge-0/0/1           -                   00:00:5e:00:53:01   ether2        router-1',
    'ge-0/0/4           -                   00:00:5e:00:53:02   eth0          ap-lobby',
    'ge-0/0/7           -                   00:00:5e:00:53:03   eth0          nas-1',
    'ge-0/0/9           -                   00:00:5e:00:53:04   eth0          ap-office',
    '',
  ].join('\n');

  for (const scheme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=suggest`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(800);

    // Edges drawn before the card opens: the dashed lines are edges too, so they are counted apart.
    const before = await page.locator('.react-flow__edge').count();
    const sw = page.locator('.react-flow__node-freeBox', { hasText: 'switch-1' }).first();
    await sw.click({ button: 'right' });
    const item = page.locator('.drawing-context-menu__item', { hasText: 'Suggest cables from its neighbours (LLDP)' });
    check(`right-click on a switch offers suggestions (${scheme})`, (await item.count()) === 1);
    await item.click();
    const card = page.getByTestId('suggest-card');
    await card.waitFor({ timeout: 5000 });
    const intro = await card.innerText();
    check(`the card says what it does in one line (${scheme})`, /Fathom suggests each cable as a dashed line/.test(intro), intro.slice(0, 200));
    check(`the card says how to get the list (${scheme})`, /show lldp neighbors/.test(intro) && /lldpcli show neighbors/.test(intro));
    await shot(page, `SG-01-ask-${scheme}`);

    await card.locator('textarea').fill(LIST);
    await card.getByRole('button', { name: 'Read it' }).click();
    await page.waitForTimeout(400);
    const read = await card.innerText();
    check(`three cables ticked, one left (${scheme})`, /Add 3 cables/i.test(read) && /ap-office has no port called eth0/.test(read), read.slice(0, 400));
    const ghosts = await page.locator('[data-plan-ghost]').count();
    check(`the ticked cables show as dashed lines (${scheme})`, ghosts === 3, String(ghosts));
    await shot(page, `SG-02-suggested-${scheme}`);

    await card.getByRole('checkbox').nth(1).uncheck();
    await page.waitForTimeout(250);
    check(`unticking takes its line away (${scheme})`, (await page.locator('[data-plan-ghost]').count()) === 2);
    await card.getByRole('checkbox').nth(1).check();
    await page.waitForTimeout(250);

    await card.getByRole('button', { name: /Add 3 cables/i }).click();
    await page.waitForTimeout(600);
    check(`Add closes the card (${scheme})`, (await page.getByTestId('suggest-card').count()) === 0);
    check(`no dashed lines remain (${scheme})`, (await page.locator('[data-plan-ghost]').count()) === 0);
    // Boxes on the open canvas join by drawn lines; their cables show inside a device and in its details.
    const details = await page.getByText('3 of 4 cabled').count();
    check(`the switch's details say three of its four ports are cabled (${scheme})`, details >= 1);
    await shot(page, `SG-03-added-${scheme}`);
    if (scheme === 'dark') {
      await page.locator('.react-flow__node-freeBox', { hasText: 'switch-1' }).first().dblclick();
      await page.waitForSelector('[data-testid=jot]', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(600);
      await shot(page, 'SG-03b-inside-switch');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    await page.mouse.click(1100, 800);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(500);
    check(`one undo takes all three back (${scheme})`, (await page.getByText('3 of 4 cabled').count()) === 0 && (await page.locator('.react-flow__edge').count()) === before);
    check(`no uncaught page errors (${scheme})`, pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // A neighbour list pasted onto the canvas with the switch selected opens the same card, already read.
  {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=suggest`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.locator('.react-flow__node-freeBox', { hasText: 'switch-1' }).first().click();
    await page.evaluate((text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    }, LIST);
    await page.waitForTimeout(500);
    const card = page.getByTestId('suggest-card');
    check('a pasted list opens the suggestions, not the config card', (await card.count()) === 1 && (await page.getByTestId('paste-card').count()) === 0);
    check('the pasted list is read for the selected switch', /Add 3 cables/i.test(await card.innerText().catch(() => '')));
    await shot(page, 'SG-04-pasted');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check('Esc closes the card and its lines', (await card.count()) === 0 && (await page.locator('[data-plan-ghost]').count()) === 0);
    check('no uncaught page errors (paste)', pageErrors.length === 0, pageErrors.join(' | '));
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
