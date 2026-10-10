// Drives the sample home lab and the five first steps (r15-start): Home with no design shows the sample card and
// Getting started at 0 of 5; Open sample makes a design of its own and opens it on the canvas; a trace from the
// desktop reaches the NAS through both switches; back on Home the trace step is ticked; Hide moves the list under
// Help. Screenshots land in FATHOM_SHOTS. Usage: bash scripts/build-wasm.sh (once), then
// node scripts/drive-sample.mjs. Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
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

  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=home`);
    await page.waitForSelector('.home-sample', { timeout: 15_000 });
    await page.waitForTimeout(500);
    check(`[${scheme}] Home offers the sample home lab`, /Open the sample home lab/.test(await page.locator('.home-sample').innerText()));
    const steps = page.locator('.first-steps');
    check(`[${scheme}] Getting started reads 0 of 5`, /0 of 5/i.test(await steps.innerText()));
    check(`[${scheme}] five steps are listed`, (await page.locator('.first-steps__step').count()) === 5);
    await shot(page, `SN-01-home-${scheme}`);

    if (scheme === 'dark') {
      check(`no uncaught page errors (${scheme})`, pageErrors.length === 0, pageErrors.join(' | '));
      await context.close();
      continue;
    }

    await page.getByRole('button', { name: 'Open sample' }).click();
    await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
    await page.waitForTimeout(2000);
    const names = await page.locator('.react-flow__node').allInnerTexts();
    const all = names.join(' ');
    for (const host of ['router-1', 'switch-1', 'switch-2', 'nas-1', 'desktop-1', 'ap-1']) {
      check(`the sample opens with ${host} on the canvas`, all.includes(host));
    }
    await shot(page, 'SN-02-sample-canvas');

    // The trace starts from a racked device; the canvas offers it on a rack's devices.
    const router = page.locator('.react-flow__node-chassis', { hasText: 'router-1' }).first();
    await router.click({ button: 'right', position: { x: 20, y: 6 } });
    const item = page.locator('.drawing-context-menu__item', { hasText: 'Trace a path from here' });
    check('the router offers Trace a path from here', (await item.count()) === 1);
    if ((await item.count()) === 1) {
      await item.click();
      await page.waitForSelector('[data-testid=trace-panel]', { timeout: 5_000 });
      await page.locator('[data-testid=trace-to]').fill('192.168.10.50');
      await page.waitForTimeout(1200);
      const hops = await page.locator('[data-testid=trace-hop]').allInnerTexts();
      const text = hops.join(' | ').replace(/\s+/g, ' ');
      check('the trace crosses switch-1 and switch-2', /switch-1/.test(text) && /switch-2/.test(text), text.slice(0, 400));
      check('the trace ends at the desktop', /desktop-1/.test(hops.at(-1) ?? ''), hops.at(-1));
      await shot(page, 'SN-03-trace');
    }

    await page.locator('.shell-bar__brand').first().click();
    await page.waitForSelector('.first-steps, .home__help', { timeout: 10_000 });
    await page.waitForTimeout(500);
    const after = await page.locator('.first-steps').innerText().catch(() => '');
    check('back on Home the trace step is ticked', /1 of 5/i.test(after), after.slice(0, 80));
    check('the sample is listed by name', (await page.getByText('Sample home lab').count()) >= 1);
    await shot(page, 'SN-04-home-after');

    await page.locator('.first-steps__hide').click();
    await page.waitForTimeout(300);
    check('Hide takes the list away', (await page.locator('.first-steps').count()) === 0);
    check('it lives under Help after that', (await page.locator('.home__panel').getByRole('button', { name: 'Getting started' }).count()) === 1);
    await shot(page, 'SN-05-hidden');
    await page.locator('.home__panel').getByRole('button', { name: 'Getting started' }).click();
    check('Getting started comes back from Help', (await page.locator('.first-steps').count()) === 1);
    check(`no uncaught page errors (${scheme})`, pageErrors.length === 0, pageErrors.join(' | '));
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
