// Drives Back out (sign-off r16-backout) and the LAG step kind on the real App over the `canvas` scene: plan a
// cable and an address, do both, Back out, and see a separate plan holding the reverse steps, newest first, which
// can take a step of its own and, done, takes the cable away again. Usage: bash scripts/build-wasm.sh (once), then
// node scripts/drive-backout.mjs.
// Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT, FATHOM_SHOTS.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, fails, waitForServer } from './drive-lib/kit.mjs';

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
const PORT = 5349;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/backout'}/`;
mkdirSync(SHOTS, { recursive: true });

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

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
    await page.screenshot({ path: SHOTS + 'backout-' + name + '.png' });
    console.log('    wrote ' + SHOTS + 'backout-' + name + '.png');
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
  const form = (page) => T(page, 'plans-add-step');
  const labelled = (page, text) => form(page).getByLabel(text, { exact: true });

  // Amber: a warm hue (about 25 to 55 degrees) with real saturation, in any colour a plan element draws with.
  const AMBER_SCAN = (root) => {
    const parse = (s) => {
      const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?/.exec(s || '');
      return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] } : null;
    };
    const isAmber = (c) => {
      if (!c || c.a === 0) return false;
      const r = c.r / 255, g = c.g / 255, b = c.b / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d < 0.2 || mx < 0.3) return false;
      let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hue = (hue * 60 + 360) % 360;
      const sat = mx === 0 ? 0 : d / mx;
      return hue >= 25 && hue <= 55 && sat > 0.45;
    };
    const props = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor', 'stroke', 'fill'];
    const hits = [];
    // A marked node is scanned alone (its ports draw their own yellow); everything else in a plan surface in full.
    const els = [...document.querySelectorAll(root)].flatMap((r) => (r.classList.contains('react-flow__node') ? [r] : [r, ...r.querySelectorAll('*')]));
    for (const el of els) {
      for (const pseudo of [null, '::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        for (const p of props) {
          if (isAmber(parse(cs[p]))) hits.push(`${el.tagName}.${String(el.className?.baseVal ?? el.className).slice(0, 40)}${pseudo ?? ''} ${p}=${cs[p]}`);
        }
      }
    }
    return { hits, scanned: els.length };
  };
  const amber = async (page, name) => {
    const r = await page.evaluate(AMBER_SCAN, '.plans-band, .plans-panel, .plans-page, .react-flow__node.plan-mark, .plan-mark__wash, .plan-mark__dash, .plan-ghost__wash, .plan-ghost__line, .plan-edge-tag__box, .plan-edge-tag__word');
    check(`${name}: no amber on any plan element`, r.hits.length === 0 && r.scanned > 0, r.hits.slice(0, 4).join(' ; ') || `${r.scanned} elements`);
  };
  const focusNotBody = (page) => page.evaluate(() => document.activeElement !== document.body && document.activeElement != null);
  const SECRET = 'Zq7xK2mPv9Lw4NcR8tYb3HdF6gJs0AeU1oXiV5nQzM2kWp7RyT4uB8cD';
  const JUNOS = `set security ike policy ike-pol pre-shared-key ascii-text ${SECRET}`;

  {
    const { context, page, pageErrors } = await open();
    const fw = page.locator('.react-flow__node-chassis', { hasText: 'fw-01' });
    // Real cables only: once a cable step is planned, its ghost line is drawn as an edge too.
    const edgesBefore = await page.locator('.react-flow__edge').count();
    await fw.click({ button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Plan a change' }).click();
    await page.waitForSelector('[data-testid=plans-panel]', { timeout: 10_000 });
    await settle(page);

    // The LAG kind is offered, and a drawn device with no pasted interfaces says what to do.
    await labelled(page, 'Kind').selectOption('lag');
    await pick(labelled(page, 'Device'), /fw-01/);
    await settle(page, 300);
    const members = await T(page, 'plans-lag-members').innerText();
    check('[lag] a device with no interfaces says to paste its config first', /Paste its config first/.test(members), members);
    await shot(page, '01-lag-no-interfaces');

    // A cable between two free ports, then an address.
    await labelled(page, 'Kind').selectOption('cable');
    await pick(labelled(page, 'From device'), /fw-01/);
    await pick(labelled(page, 'From port'), /^MGMT$/);
    await pick(labelled(page, 'To device'), /sw-02/);
    await pick(labelled(page, 'To port'), /^20$/);
    await form(page).getByRole('button', { name: 'Add step' }).click();
    await settle(page);
    await labelled(page, 'Kind').selectOption('address');
    await pick(labelled(page, 'Device'), /sw-02/);
    await labelled(page, 'New management address').fill('10.0.1.1');
    await form(page).getByRole('button', { name: 'Add step' }).click();
    await settle(page);
    await labelled(page, 'Kind').selectOption('other');
    await labelled(page, 'What changes').fill('Tell the office');
    await form(page).getByRole('button', { name: 'Add step' }).click();
    await settle(page);
    check('[plan] three steps', (await T(page, 'plans-step').count()) === 3, await T(page, 'plans-panel').innerText());

    await page.getByRole('button', { name: 'Start work' }).click();
    await settle(page, 1200);
    check('[do] no Back out before a step is marked', (await T(page, 'plans-back-out').count()) === 0);
    await page.getByRole('button', { name: 'Mark done' }).click();
    await settle(page, 1200);
    await page.getByRole('button', { name: 'Mark done' }).click();
    await settle(page, 1200);
    const edgesDone = await page.locator('.react-flow__edge').count();
    check('[do] the cable step drew a cable', edgesDone === edgesBefore + 1, `${edgesBefore} -> ${edgesDone}`);
    await T(page, 'plans-back-out').waitFor({ timeout: 8000 }).catch(() => {});
    if ((await T(page, 'plans-back-out').count()) === 0) {
      await shot(page, 'debug');
      console.log('DEBUG ' + (await T(page, 'plans-panel').innerText().catch(() => 'no panel')).replace(/\s+/g, ' ').slice(0, 700));
    }
    check('[do] Back out is offered once steps are marked', (await T(page, 'plans-back-out').count()) === 1);
    await T(page, 'plans-back-out').click();
    await settle(page, 300);
    const ask = await T(page, 'plans-back-out-ask').innerText();
    check('[ask] it says what happens: stops, records failed, a new plan of two steps', /records the plan as failed/.test(ask) && /2 steps, newest first/.test(ask), ask.replace(/\s+/g, ' '));
    await shot(page, '02-ask');
    await page.getByRole('button', { name: 'Make the plan back' }).click();
    await settle(page, 1200);
    const bandNow = (await T(page, 'plans-band').innerText()).replace(/\s+/g, ' ');
    check('[back] the new plan is open, being planned', /Back out:/.test(bandNow) && (await T(page, 'plans-panel').getAttribute('data-mode')) === 'plan', bandNow);
    const steps = await T(page, 'plans-step').allInnerTexts();
    check('[back] two reverse steps, newest first', steps.length === 2 && /Undo step 2/.test(steps[0]) && /Undo step 1/.test(steps[1]), steps.map((s) => s.replace(/\s+/g, ' ')).join(' | '));
    await shot(page, '03-back-out-plan');

    // It is an ordinary plan: a step of its own goes in, then it runs.
    if ((await form(page).count()) === 0) await page.getByRole('button', { name: 'Add a step' }).click();
    await labelled(page, 'Kind').selectOption('other');
    await labelled(page, 'What changes').fill('Clear the ARP cache on sw-02');
    await form(page).getByRole('button', { name: 'Add step' }).click();
    await settle(page);
    check('[back] a step of its own can be added', (await T(page, 'plans-step').count()) === 3);
    await page.getByRole('button', { name: 'Start work' }).click();
    await settle(page, 1200);
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Mark done' }).click();
      await settle(page, 1200);
    }
    const edgesAfter = await page.locator('.react-flow__edge').count();
    check('[back] doing it takes the cable away again', edgesAfter === edgesBefore, `${edgesDone} -> ${edgesAfter}`);
    await shot(page, '04-back-out-done');

    const band = (await T(page, 'plans-band').innerText()).replace(/\s+/g, ' ');
    check('[band] the first plan is now recorded', /Change to fw-01 \(recorded\)/.test(band), band);
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
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
