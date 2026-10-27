// Drives the guided lessons (ADR-0066 item 1.3, round 10 lessons B) on the real compiled client: Home lists the three
// lessons with Start; Start makes a copy of the small-office sample and opens it with the lesson beside the canvas;
// the firewall policy-order lesson is walked to the end (a wrong pick gets the hint, the right one passes, Trace it
// opens the trace with block-cameras matching first), Home then shows it done and the next lesson can continue
// where it was left. Screenshots land in FATHOM_SHOTS. Usage: bash scripts/build-wasm.sh (once), then
// node scripts/drive-lessons.mjs. Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
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
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CLIENT = ROOT + '/client';
const DRIVE_LIB = ROOT + '/scripts/drive-lib';
const PORT = 18413;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
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

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/drive.html?scene=home`);
  await page.waitForSelector('.lessons-list', { timeout: 15_000 });
  await page.waitForTimeout(500);
  const rows = page.locator('.lessons-list__row');
  check('Home lists three lessons', (await rows.count()) === 3, String(await rows.count()));
  const listText = await page.locator('.lessons-list').innerText();
  for (const t of ["VLANs: why the camera can't see the NAS", 'Single points of failure', 'Firewall policy order']) {
    check(`the list has "${t}"`, listText.includes(t));
  }
  check('each lesson names its network', (listText.match(/Small office/g) ?? []).length === 3);
  await page.locator('.lessons-list').scrollIntoViewIfNeeded();
  await shot(page, 'LS-01-home-lessons');

  // Start the firewall lesson.
  await page.locator('[data-testid=lesson-firewall-policy-order]').getByRole('button', { name: 'Start' }).click();
  await page.waitForSelector('[data-testid=lesson-panel]', { timeout: 30_000 });
  await page.waitForSelector('.react-flow__pane', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const panel = page.locator('[data-testid=lesson-panel]');
  const panelText = async () => (await panel.textContent()) ?? '';
  check('the lesson opens beside the canvas at step 1 of 4', /step 1 of 4/i.test(await panelText()), (await panelText()).slice(0, 120));
  const names = (await page.locator('.react-flow__node').allInnerTexts()).join(' ');
  for (const host of ['fw-1', 'switch-1', 'switch-2', 'switch-3']) check(`the copy has ${host} on the canvas`, names.includes(host));
  await shot(page, 'LS-02-lesson-read');

  check('Read more opens the firewall explainer', (await panel.getByRole('button', { name: 'Read more' }).count()) === 1);
  await panel.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(300);
  check('step 2 asks for a pick on the canvas', /Pick it on the canvas/.test(await panelText()));
  check('Next waits for the answer', await panel.getByRole('button', { name: 'Next' }).isDisabled());

  const box = (host) => page.locator('.react-flow__node-chassis', { hasText: host }).first();
  await box('switch-1').click({ position: { x: 20, y: 6 } });
  await page.waitForTimeout(400);
  check('a wrong pick gets the hint', /Not that one\./.test(await panelText()), (await panelText()).slice(0, 300));
  await shot(page, 'LS-03-wrong-pick');
  await box('fw-1').click({ position: { x: 20, y: 6 } });
  await page.waitForTimeout(400);
  check('the right pick passes and says why', /Its office port and its cameras port/.test(await panelText()), (await panelText()).slice(0, 300));
  check('Next is open after the right pick', !(await panel.getByRole('button', { name: 'Next' }).isDisabled()));
  await shot(page, 'LS-04-right-pick');
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(300);

  check('step 3 offers Trace it', (await panel.getByRole('button', { name: 'Trace it' }).count()) === 1);
  await panel.getByRole('button', { name: 'Trace it' }).click();
  await page.waitForSelector('[data-testid=trace-panel]', { timeout: 10_000 });
  await page.waitForTimeout(2500);
  const hops = (await page.locator('[data-testid=trace-hop]').allInnerTexts()).join(' | ').replace(/\s+/g, ' ');
  check('the trace on the canvas crosses fw-1', /fw-1/.test(hops), hops.slice(0, 300));
  check('the trace lists block-cameras before allow-viewer', hops.indexOf('block-cameras') >= 0 && hops.indexOf('block-cameras') < hops.indexOf('allow-viewer'), hops.slice(0, 600));
  check('the lesson passes the trace step', /Junos stops at the first match/.test(await panelText()), (await panelText()).slice(0, 300));
  await shot(page, 'LS-05-trace');
  await panel.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(300);
  check('the last step sets the command as code', (await panel.locator('code').first().textContent())?.startsWith('insert security policies'));
  await panel.getByRole('button', { name: 'Finish' }).click();
  await page.waitForTimeout(300);
  check('the lesson says it is done', /Lesson done/.test(await panelText()));
  await panel.getByRole('button', { name: 'Sources' }).click();
  check('the sources name the Juniper page and its read date', /Reordering Security Policies.*read 2026-10-25/s.test(await panelText()));
  await shot(page, 'LS-06-done');

  // Back on Home the lesson is done; start the VLANs lesson, take one step, leave, and continue from there.
  await page.locator('.shell-bar__brand').first().click();
  await page.waitForSelector('.lessons-list', { timeout: 10_000 });
  await page.waitForTimeout(500);
  const fwRow = page.locator('[data-testid=lesson-firewall-policy-order]');
  check('Home shows the firewall lesson done', /done/.test(await fwRow.innerText()));
  await page.locator('[data-testid=lesson-vlans]').getByRole('button', { name: 'Start' }).click();
  await page.waitForSelector('[data-testid=lesson-panel]', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await panel.getByRole('button', { name: 'Next' }).click();
  await panel.getByRole('button', { name: 'Trace it' }).click();
  await page.waitForTimeout(2500);
  check('the VLANs lesson passes camera-1 to camera-2 through switch-1', /switch-1 joins them directly/.test(await panelText()), (await panelText()).slice(0, 300));
  await page.locator('.shell-bar__brand').first().click();
  await page.waitForSelector('.lessons-list', { timeout: 10_000 });
  await page.waitForTimeout(500);
  const vlanRow = page.locator('[data-testid=lesson-vlans]');
  check('Home offers to continue the VLANs lesson at step 2', /Continue · 2 of 6/.test((await vlanRow.textContent()) ?? ''), (await vlanRow.textContent()) ?? '');
  await shot(page, 'LS-07-home-continue');
  await vlanRow.getByRole('button', { name: /Continue/ }).click();
  await page.waitForSelector('[data-testid=lesson-panel]', { timeout: 30_000 });
  check('Continue reopens the copy at step 2', /step 2 of 6/i.test(await panelText()));

  // The VLANs lesson's change steps, done by hand in Inventory's Networks the way the prompt says.
  await panel.getByRole('button', { name: 'Trace it' }).click();
  await page.waitForTimeout(2000);
  await panel.getByRole('button', { name: 'Next' }).click();
  await panel.getByRole('button', { name: 'Trace it' }).click();
  await page.waitForTimeout(2500);
  check('camera-1 to nas-1 goes up to fw-1 and back down', /comes back down into VLAN 10/.test(await panelText()), (await panelText()).slice(0, 300));
  await panel.getByRole('button', { name: 'Next' }).click();
  await page.keyboard.press('Escape');
  await box('fw-1').click({ position: { x: 20, y: 6 } });
  await page.waitForTimeout(400);
  await panel.getByRole('button', { name: 'Next' }).click();
  check('step 5 watches Checks', /Watching Checks/.test(await panelText()), (await panelText()).slice(0, 300));
  // A trace still open holds the bar, with the other views folded away: close it first, as a learner would.
  const exitTask = page.getByTestId('shell-task-exit');
  if (await exitTask.isVisible()) await exitTask.click();
  await page.getByRole('link', { name: 'Inventory' }).or(page.getByRole('button', { name: 'Inventory' })).or(page.getByRole('tab', { name: 'Inventory' })).first().click();
  await page.waitForTimeout(800);
  await page.getByText('Networks', { exact: true }).first().click();
  await page.waitForSelector('.networks-panel', { timeout: 10_000 });
  async function moveTo(fromId, toId) {
    // The VLAN row that has switch-2 port 1 in it: its "on" column names switch-2.
    const rows = page.locator('.networks-grid__cell--name', { hasText: new RegExp(`^VLAN ${fromId}\\b`) });
    for (let i = 0; i < (await rows.count()); i++) {
      await rows.nth(i).click();
      await page.waitForTimeout(250);
      if ((await page.locator('.networks-grid__open-actions button', { hasText: /^detach switch-2 · 1$/ }).count()) === 1) break;
      await rows.nth(i).click();
    }
    await page.waitForTimeout(300);
    const detach = page.locator('.networks-grid__open-actions button', { hasText: /^detach switch-2 · (port)?1$/ });
    const offered = await page.locator('.networks-grid__open-actions button').allTextContents();
    check(`VLAN ${fromId} offers to detach switch-2's port 1`, (await detach.count()) === 1, offered.join(' | '));
    await detach.first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Add network' }).click();
    const side = page.locator('.networks-panel__side');
    await side.locator('.networks-editor__row', { hasText: 'vlan id' }).locator('input').fill(String(toId));
    const row = side.locator('.networks-editor__attach-row').first();
    await row.locator('select').nth(0).selectOption({ label: 'switch-2' });
    await row.locator('select').nth(1).selectOption({ label: '1' });
    await side.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(1500);
    const err = await side.locator('.networks-editor__error').count() ? await side.locator('.networks-editor__error').textContent() : '';
    check(`switch-2 port 1 moved from VLAN ${fromId} to VLAN ${toId}`, err === '', err ?? '');
  }
  await moveTo(10, 30);
  check('Checks fires and the lesson passes the change step', /desk run now has VLAN 10 at switch-1 and VLAN 30 at switch-2/.test(await panelText()), (await panelText()).slice(0, 300));
  await shot(page, 'LS-08-change-fires');
  await panel.getByRole('button', { name: 'Next' }).click();
  await moveTo(30, 10);
  check('putting it back clears the warning and passes the last step', /Clear again/.test(await panelText()), (await panelText()).slice(0, 300));
  await shot(page, 'LS-09-change-clears');

  // A narrow window: the panel fits and folds.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(400);
  const bb = await panel.boundingBox();
  check('at phone width the panel fits the window', bb != null && bb.x >= 0 && bb.x + bb.width <= 390, JSON.stringify(bb));
  await shot(page, 'LS-10-phone');
  await panel.getByRole('button', { name: 'Hide' }).click();
  check('Hide folds the panel to its title', (await panel.getByRole('button', { name: 'Show' }).count()) === 1 && (await panel.locator('[data-testid=lesson-step]').count()) === 0);
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await context.close();

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
