// Drives the lesson builder (ADR-0066 §2) on the real compiled client: on a design of the person's own, the search
// bar's Build a lesson opens the builder; a lesson is written with a read, a click (answer from the canvas selection)
// and a trace (ends from the selection, expectation recorded from a trace run now); a change step is added, shown
// unfinished, and removed; steps move. Publish makes a copy named Lesson: …, Home lists it, Start makes a Practice
// copy, and the lesson is walked to the end there. Screenshots land in FATHOM_SHOTS. Usage: bash
// scripts/build-wasm.sh (once), then node scripts/drive-lesson-builder.mjs. Overrides: FATHOM_ROOT, PW_CHROMIUM,
// PW_PLAYWRIGHT.
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
const PORT = 18414;
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

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/drive.html?scene=home`);
  await page.waitForSelector('.home-sample__open', { timeout: 15_000 });
  await page.locator('.home-sample__open').click();
  await page.waitForSelector('.react-flow__pane', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  // A rack box is a chassis node; a shelf holds compact occupants; a desk or wall device is a fixture on its surface.
  const box = (host) =>
    page
      .locator('.react-flow__node-chassis', { hasText: host })
      .or(page.locator('.drawing-shelf__compact-occupant', { hasText: host }))
      .or(page.locator('.drawing-surface__fixture-header', { hasText: host }))
      .first();
  const pickBox = async (host) => {
    await page.keyboard.press('Escape');
    const el = box(host);
    const isChassis = await el.evaluate((n) => n.classList.contains('react-flow__node-chassis'));
    // Near the chassis's left end, half way down: the fitted view can draw a 1U box only a few pixels tall.
    const h = (await el.boundingBox())?.height ?? 12;
    await el.click(isChassis ? { position: { x: 20, y: Math.min(6, h / 2) } } : {});
    await page.waitForTimeout(350);
  };

  await page.keyboard.press('Control+k');
  await page.keyboard.type('Build a lesson');
  await page.keyboard.press('Enter');
  const b = page.locator('[data-testid=lesson-builder]');
  check('the search bar opens the builder', await b.waitFor({ timeout: 5_000 }).then(() => true, () => false));
  const bText = async () => (await b.textContent()) ?? '';
  check('the builder says learners get a copy', /Publishing makes a copy for learners/.test(await bText()));
  await shot(page, 'LB-01-builder-open');
  await b.locator('.lesson-build__field', { hasText: 'Title' }).locator('input').fill('Our home lab');
  await b.locator('.lesson-build__field', { hasText: 'What it teaches' }).locator('input').fill('Where the traffic goes in this house.');
  await b.getByRole('button', { name: 'Start writing' }).click();
  await page.waitForTimeout(300);
  check('a draft lesson is started', (await b.getByRole('button', { name: 'Read' }).count()) === 1, (await bText()).slice(0, 200));

  const editor = b.locator('[data-testid=lesson-build-editor]');
  const fill = async (label, value) => {
    const f = editor.locator('.lesson-build__field', { hasText: label }).first();
    await (await f.locator('textarea').count() ? f.locator('textarea') : f.locator('input')).fill(value);
  };
  const add = async () => {
    await b.getByRole('button', { name: /^(Add|Save) the step$/ }).click();
    await page.waitForTimeout(300);
  };

  // A read step.
  await b.getByRole('button', { name: 'Read', exact: true }).click();
  await fill('Title', 'The router');
  await fill('What to read', 'Every packet that leaves the house goes through `router-1`.');
  await add();
  // A click step: the answer is what is selected on the canvas.
  await b.getByRole('button', { name: 'Click the answer' }).click();
  await fill('Title', 'Find it');
  await fill('What to ask', 'Click the router.');
  check('Use the selection waits for a selection', await editor.locator('.lesson-build__pick').first().getByRole('button').isDisabled());
  await pickBox('router-1');
  await editor.locator('.lesson-build__pick', { hasText: 'Answer' }).getByRole('button', { name: 'Use the selection' }).click();
  check('the answer is router-1', /Answerrouter-1/.test((await editor.textContent()) ?? ''), ((await editor.textContent()) ?? '').slice(0, 200));
  await fill('Hint', 'It is the box the internet comes into.');
  await fill('Said once it passes', 'Right: router-1 joins the house to the internet.');
  await add();
  // A trace step: ends from the selection, expectation recorded from a trace run now.
  await b.getByRole('button', { name: 'Trace', exact: true }).click();
  await fill('Title', 'Desktop to NAS');
  await fill('What to ask', 'Trace from desktop-1 to nas-1.');
  await pickBox('desktop-1');
  await editor.locator('.lesson-build__pick').nth(0).getByRole('button', { name: 'Use the selection' }).click();
  await pickBox('nas-1');
  await editor.locator('.lesson-build__pick').nth(1).getByRole('button', { name: 'Use the selection' }).click();
  await editor.getByRole('button', { name: 'Record what it shows now' }).click();
  await page.waitForTimeout(2500);
  const eText = (await editor.textContent()) ?? '';
  check('recording the trace says it reaches, crossing the two switches', /it reaches, crossing (switch-2, switch-1|switch-1, switch-2) it stops/.test(eText), eText.slice(0, 400));
  check('"it reaches" is chosen', await editor.getByRole('radio').first().isChecked());
  await fill('Said once it passes', 'Two switches, no router: they share a subnet.');
  await shot(page, 'LB-02-trace-recorded');
  await add();
  // A change step, left unfinished, then removed.
  await b.getByRole('button', { name: 'Change it and watch' }).click();
  await fill('Title', 'Unfinished');
  await add();
  check('an unfinished step says what it needs', /Pick the check to watch\./.test(await bText()));
  check('Publish waits for every step to be finished', await b.getByRole('button', { name: 'Publish a copy for learners' }).isDisabled());
  await shot(page, 'LB-03-unfinished');
  const steps = b.locator('[data-testid=lesson-build-step]');
  await steps.nth(3).getByRole('button', { name: 'Remove' }).click();
  await page.waitForTimeout(300);
  check('Remove takes the step out', (await steps.count()) === 3);
  // Order: move Find it below Desktop to NAS and back.
  await steps.nth(1).getByRole('button', { name: /down/ }).click();
  await page.waitForTimeout(300);
  check('a step moves down', /Desktop to NAS/.test((await steps.nth(1).textContent()) ?? ''));
  await steps.nth(2).getByRole('button', { name: /up/ }).click();
  await page.waitForTimeout(300);
  check('and back up', /Find it/.test((await steps.nth(1).textContent()) ?? ''));
  // Editing keeps what was there.
  await steps.nth(0).getByRole('button', { name: 'Edit' }).click();
  check('Edit opens the step as it was', (await editor.locator('textarea').first().inputValue()).includes('router-1'));
  await fill('Title', 'The router, first');
  await add();
  check('the edit is saved', /The router, first/.test(await bText()));

  await b.getByRole('button', { name: 'Publish a copy for learners' }).click();
  await page.waitForTimeout(1500);
  check('Publish names the copy', /Published as “Lesson: Our home lab”/.test(await bText()), (await bText()).slice(-300));
  await shot(page, 'LB-04-published');

  // Home lists it; Start makes a Practice copy with the lesson running.
  await page.locator('.shell-bar__brand').first().click();
  await page.waitForSelector('.lessons-list', { timeout: 10_000 });
  await page.waitForTimeout(800);
  const row = page.locator('.lessons-list__row', { hasText: 'Our home lab' });
  check('Home lists the published lesson', (await row.count()) === 1, await page.locator('.lessons-list').innerText());
  check('the row says it was written here', /Written here/.test((await row.textContent()) ?? ''));
  await page.locator('.lessons-list').scrollIntoViewIfNeeded();
  await shot(page, 'LB-05-home');
  await row.getByRole('button', { name: 'Start' }).click();
  const panel = page.locator('[data-testid=lesson-panel]');
  await panel.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const pText = async () => (await panel.textContent()) ?? '';
  check('the practice copy opens at step 1 of 3', /step 1 of 3/i.test(await pText()), (await pText()).slice(0, 200));
  check('the lesson shows no Sources it does not have', (await panel.getByRole('button', { name: 'Sources' }).count()) === 0);
  check('the code in the read step is set as code', (await panel.locator('code').first().textContent()) === 'router-1');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Build a lesson');
  await page.waitForTimeout(400);
  check('a lesson copy offers no builder', (await page.getByText('Build a lesson', { exact: true }).count()) === 0);
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Next' }).click();
  await pickBox('switch-1');
  check('a wrong pick gets the author\'s hint', /Not that one\. It is the box the internet comes into\./.test(await pText()), (await pText()).slice(0, 300));
  await pickBox('router-1');
  check('the right pick passes with the author\'s words', /router-1 joins the house to the internet/.test(await pText()));
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Next' }).click();
  await panel.getByRole('button', { name: 'Trace it' }).click();
  await page.waitForTimeout(2500);
  check('the trace step passes in the copy', /they share a subnet/.test(await pText()), (await pText()).slice(0, 300));
  await shot(page, 'LB-06-practice-trace');
  await panel.getByRole('button', { name: 'Finish' }).click();
  check('the lesson is done', /Lesson done/.test(await pText()));
  await page.locator('.shell-bar__brand').first().click();
  await page.waitForSelector('.lessons-list', { timeout: 10_000 });
  await page.waitForTimeout(600);
  check('Home shows the written lesson done', /done/.test((await page.locator('.lessons-list__row', { hasText: 'Our home lab' }).textContent()) ?? ''));
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
