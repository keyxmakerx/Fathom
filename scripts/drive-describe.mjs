// Drives ADR-0060 step 8 end to end: pasting a config anywhere (gate, card, attach or add) and opening a
// device (jot mode: drop equipment, cable to its ports, Inside, Esc out); screenshots land in FATHOM_SHOTS.

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
const PORT = 5341;
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

  const rows = (page) => page.locator('.describe__row');
  const setRow = async (page, i, kind, count, face) => {
    const row = rows(page).nth(i);
    await row.getByLabel('What kind of port').selectOption(kind);
    await row.getByLabel('How many').selectOption(String(count));
    await row.getByLabel('Which face').selectOption(face);
  };
  const openEquipment = async (page) => {
    await page.locator('[data-testid="dock-equipment"]').click();
    await page.waitForSelector('.drawing-palette__search', { timeout: 10_000 });
  };

  const devices = (page) => page.locator('.react-flow__node-chassis');

  // Part 1: a new design, the owner's NUC (ports on the rear, both sides and on top).
  {
    const { context, page, pageErrors } = await open('empty');
    const before = await devices(page).count();
    await openEquipment(page);
    await page.locator('.drawing-palette__search').fill('NUC 13');
    await page.waitForTimeout(200);
    check('a search that finds nothing says so', (await page.getByText('Nothing matches').count()) === 1);
    check('and offers to describe it', (await page.getByRole('button', { name: 'Not here? Describe it' }).count()) === 1);
    await shot(page, 'D1-nothing-matches');
    await page.getByRole('button', { name: 'Not here? Describe it' }).click();
    await page.waitForSelector('.describe', { timeout: 5_000 });
    check('the name starts as what was searched', (await page.getByLabel('Name').inputValue()) === 'NUC 13');
    await shot(page, 'D2-describe-start');
    await setRow(page, 0, 'copper', 1, 'rear');
    await setRow(page, 1, 'copper', 1, 'left');
    await page.getByRole('button', { name: '+ More ports' }).click();
    await setRow(page, 2, 'copper', 1, 'right');
    await page.getByRole('button', { name: '+ More ports' }).click();
    await setRow(page, 3, 'copper', 2, 'top');
    await page.getByRole('button', { name: '+ More ports' }).click();
    await setRow(page, 4, 'power', 1, 'rear');
    const faces = await page.locator('.describe__face-name').allInnerTexts();
    check('the preview draws one strip per face', faces.map((f) => f.toLowerCase()).join(',') === 'rear,left side,right side,top', faces.join(','));
    check('the preview counts every port', (await page.locator('.describe__port').count()) === 6);
    await shot(page, 'D3-describe-nuc');
    await page.locator('.describe__keep').screenshot({ path: SHOTS + 'D3a-keep.png' });
    await page.getByRole('button', { name: 'Use this model' }).click();
    await page.waitForTimeout(800);
    check('the device lands in the design', (await devices(page).count()) === before + 1);
    check('the list comes back', (await page.locator('.drawing-palette__search').count()) === 1);
    check('it is kept under Your models', (await page.locator('.drawing-palette__item--yours', { hasText: 'NUC 13' }).count()) === 1);
    await shot(page, 'D4-your-models');

    // A second one from Your models: one click.
    await page.locator('.drawing-palette__item--yours', { hasText: 'NUC 13' }).click();
    await page.waitForTimeout(800);
    check('Your models adds another in one click', (await devices(page).count()) === before + 2);

    // Open it: every face's ports are there, and each says which face.
    check('it is named from its description', (await page.getByText('nuc-13-1').count()) >= 1 && (await page.getByText('nuc-13-2').count()) >= 1);
    await devices(page).first().click();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.waitForSelector('[data-testid=jot]', { timeout: 10_000 });
    const titles = await page.locator('[data-testid=jot-device] .jot-port').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
    check('the opened device draws all six ports', titles.length === 6, titles.join(' | '));
    check('a side port says which side', titles.some((t) => t.includes('left side')) && titles.some((t) => t.includes('right side')));
    check('a top port says top', titles.some((t) => t.includes('· top ·')));
    const captions = (await page.locator('[data-testid=jot-device] .jot-plate__face').allInnerTexts()).map((t) => t.toLowerCase());
    check('each face is named under its ports', ['rear', 'left side', 'right side', 'top'].every((f) => captions.includes(f)), captions.join(','));
    await shot(page, 'D5-open-nuc');
    check('no uncaught page errors (empty canvas)', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // Part 2: a canvas with racks; a described switch goes into the rack in use, as a click in the list does.
  {
    const { context, page, pageErrors } = await open('canvas');
    const before = await page.locator('.react-flow__node-chassis').count();
    await openEquipment(page);
    await page.getByRole('button', { name: 'Not here? Describe it' }).click();
    await page.getByLabel('Name').fill('');
    await page.getByRole('button', { name: 'Use this model' }).click();
    check('a nameless device is refused in words', (await page.getByRole('alert').filter({ hasText: 'Give it a name.' }).count()) === 1);
    await page.getByLabel('Name').fill('USW Lite 8 PoE');
    await setRow(page, 0, 'copper', 8, 'front');
    await setRow(page, 1, 'sfp', 2, 'front');
    await shot(page, 'D6-describe-switch');
    await page.getByRole('button', { name: 'Use this model' }).click();
    await page.waitForTimeout(800);
    check('the switch goes into a rack', (await page.locator('.react-flow__node-chassis').count()) === before + 1);
    await shot(page, 'D7-switch-in-rack');
    check('no uncaught page errors (racks)', pageErrors.length === 0, pageErrors.join(' | '));
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
