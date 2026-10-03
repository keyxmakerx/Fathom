// Drives "It's down" (ADR-0061 troubleshooting) on the real App over the `canvas` scene: right-click, the checklist,
// answers by key and by button, Why?, the point block, the fade, Plan a fix opening the plan, Save as an issue and
// the device history, a read holder, phone width and dark mode. Usage: bash scripts/build-wasm.sh (once), then
// node scripts/drive-troubleshoot.mjs. Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT, FATHOM_SHOTS.
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
const PORT = 5343;
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
  const shot = async (page, name) => {
    await page.screenshot({ path: SHOTS + 'trouble-' + name + '.png' });
    console.log('    wrote ' + SHOTS + 'trouble-' + name + '.png');
  };
  async function open({ w = 1400, h = 900, dark = false, read = false } = {}) {
    const context = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light' });
    // A real paste (Ctrl+V of what the page's own clipboard holds) needs these.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=canvas${read ? '&capability=read' : ''}`);
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
  const form = (page) => T(page, 'trouble-panel');
  const focusNotBody = (page) => page.evaluate(() => document.activeElement !== document.body && document.activeElement != null);
  const SECRET = 'Zq7xK2mPv9Lw4NcR8tYb3HdF6gJs0AeU1oXiV5nQzM2kWp7RyT4uB8cD';
  const JUNOS = `set security ike policy ike-pol pre-shared-key ascii-text ${SECRET}`;
  // A short key, as a real device takes (Junos 8 to 63 characters): the gate must hold for it too.
  const SHORT = 'Sk7q2Zr9';
  const JUNOS_SHORT = `set security ike policy ike-pol pre-shared-key ascii-text ${SHORT}`;
  // The cable strokes on the canvas: [colour channel spread] per drawn cable path, halos and washes left out.
  const cableStrokes = (page) => page.evaluate(() => [...document.querySelectorAll('.drawing-cable path:not(.drawing-cable__halo):not(.plan-mark__wash)')].map((p) => {
    const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(getComputedStyle(p).stroke);
    return m ? Math.max(+m[1], +m[2], +m[3]) - Math.min(+m[1], +m[2], +m[3]) : 0;
  }));
  const step = (page, state) => page.locator(`[data-testid=trouble-step][data-state=${state}]`);
  const answers = (page) => page.locator('[data-testid=trouble-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-answer')));
  const opened = async (page, host = 'fw-01') => {
    await page.locator('.react-flow__node-chassis', { hasText: host }).click({ button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: "It's down" }).click();
    await page.waitForSelector('[data-testid=trouble-panel]', { timeout: 10_000 });
    await settle(page, 900);
  };
  // No colour of the app's own on the panel or the lit chain: a computed-style scan for any hue that is not ink.
  const INK_SCAN = (root) => {
    const parse = (s) => {
      const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?/.exec(s || '');
      return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] } : null;
    };
    const coloured = (c) => {
      if (!c || c.a === 0) return false;
      const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
      return mx - mn > 40;
    };
    const props = ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'outlineColor'];
    const hits = [];
    const els = [...document.querySelectorAll(root)].flatMap((r) => [r, ...r.querySelectorAll('*')]);
    for (const el of els) {
      const cs = getComputedStyle(el);
      for (const p of props) if (coloured(parse(cs[p]))) hits.push(`${el.tagName}.${String(el.className?.baseVal ?? el.className).slice(0, 40)} ${p}=${cs[p]}`);
    }
    return { hits, scanned: els.length };
  };
  const ink = async (page, name) => {
    const r = await page.evaluate(INK_SCAN, '[data-testid=trouble-panel]');
    check(`${name}: the panel draws in ink, no colour`, r.hits.length === 0 && r.scanned > 0, r.hits.slice(0, 4).join(' ; ') || `${r.scanned} elements`);
  };

  // ---------------------------------------------------------------- 1. the whole flow, light, desktop
  {
    const { context, page, pageErrors } = await open();
    check('[flow] no panel before it is asked for', (await T(page, 'trouble-panel').count()) === 0);
    const before = await cableStrokes(page);
    check('[canvas] before a session the cables carry their sheath colours', before.some((d) => d > 40), before.join(','));
    await opened(page);
    const title = (await T(page, 'trouble-title').innerText()).replace(/\s+/g, ' ');
    check('[flow] right-click It\'s down opens the panel with the header', /^fw-01 is down . 1 of \d+$/i.test(title), title);
    const total = await page.locator('[data-testid=trouble-step]').count();
    check('[flow] the checklist has the chain steps, one open', total >= 4 && (await step(page, 'current').count()) === 1, String(total));
    const first = (await step(page, 'current').innerText()).replace(/\s+/g, ' ');
    check("[flow] with no power link recorded, step 1 asks a question and says Fathom doesn't know in its detail", /^1 . Is fw-01 getting power\?/.test(first) && /Fathom doesn't know what powers fw-01/.test(first), first);
    check('[flow] focus is inside the panel, not on the body', await page.evaluate(() => document.activeElement?.closest('[data-testid=trouble-panel]') != null));
    const fadedAtStart = await page.locator('.react-flow__node.checks-faded').count();
    const fullAtStart = await page.locator('.react-flow__node:not(.checks-faded)').count();
    check('[flow] the canvas fades what is off the chain and keeps the chain', fadedAtStart > 0 && fullAtStart >= 1, `${fadedAtStart} faded, ${fullAtStart} full`);
    const strokes = await cableStrokes(page);
    check('[canvas] every cable draws in ink while it runs', strokes.length >= 1 && strokes.every((d) => d <= 12), strokes.join(','));
    check('[canvas] a chain cable carries the lit halo', (await page.locator('.drawing-cable__halo').count()) >= 1);
    check('[flow] nothing to save or plan before an answer: no footer, no hint', (await T(page, 'trouble-plan').count()) === 0 && (await T(page, 'trouble-save').count()) === 0 && (await page.locator('.trouble-hint').count()) === 0);
    check('[flow] later rows carry their own Why?', (await page.locator('[data-testid=trouble-step][data-state=later] .trouble-why-btn').count()) >= 3);
    check('[flow] the note is behind a link, not an open field', (await page.getByRole('button', { name: 'Add what you saw' }).count()) === 1 && (await page.locator('.trouble-input').count()) === 0);
    await ink(page, '[flow] opened');
    await shot(page, '01-opened');

    // Why? opens the card, Esc closes the card then the panel folds.
    await page.locator('[data-testid=trouble-step][data-state=current] .trouble-why-btn').click();
    await settle(page, 300);
    check('[why] Why? opens the card with text', (await T(page, 'trouble-why').count()) === 1 && (await T(page, 'trouble-why').innerText()).length > 20);
    await shot(page, '02-why');
    await page.keyboard.press('Escape');
    await settle(page, 300);
    check('[why] the first Esc closes the card and keeps the panel', (await T(page, 'trouble-why').count()) === 0 && (await T(page, 'trouble-panel').count()) === 1);
    check('[why] focus is not on the body', await focusNotBody(page));

    // Answer by key: 1 = OK on step 1, 3 = Can't tell on step 2, then Not OK on step 3 by button.
    await page.keyboard.press('1');
    await settle(page, 300);
    check('[keys] 1 answers OK and the next step opens', (await answers(page))[0] === 'ok' && /2 of/i.test(await T(page, 'trouble-title').innerText()), (await answers(page)).join(','));
    check('[keys] focus follows to the open step', await focusNotBody(page));
    await page.keyboard.press('3');
    await settle(page, 300);
    check("[keys] 3 answers Can't tell", (await answers(page))[1] === 'cant_tell');
    check('[footer] the footer appears with the first answer, Plan a fix off with its reason', (await T(page, 'trouble-plan').getAttribute('aria-disabled')) === 'true' && /Nothing is suspect yet/.test(await T(page, 'trouble-panel').innerText()));
    const point1 = await T(page, 'trouble-point').innerText();
    check('[point] with only OK and Can\'t tell it says everything looks fine so far, naming no cause', /Everything Fathom can check looks fine so far/.test(point1) && !/the problem is/i.test(point1), point1.replace(/\s+/g, ' '));
    // Tab reaches the buttons, Enter answers.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const onWhich = await page.evaluate(() => document.activeElement?.textContent ?? '');
    console.log('    after two Tabs focus is on: ' + onWhich);
    const notOk = page.locator('[data-testid=trouble-step][data-state=current] [data-answer=not_ok]');
    await notOk.focus();
    await page.keyboard.press('Enter');
    await settle(page, 400);
    check('[keys] focus on Not OK then Enter answers it', (await answers(page))[2] === 'not_ok', (await answers(page)).join(','));
    const point2 = (await T(page, 'trouble-point').innerText()).replace(/\s+/g, ' ');
    check('[point] a Not OK points at suspects and says Fathom does not decide', /Your answers point at/.test(point2) && /doesn't decide/.test(point2) && !/the problem is/i.test(point2), point2);
    check('[point] tests that would tell them apart are listed', (await page.locator('.trouble-test').count()) >= 1);
    check('[point] the header says narrowed', /narrowed/i.test(await T(page, 'trouble-title').innerText()), await T(page, 'trouble-title').innerText());
    check('[point] once narrowed no further card opens by itself', (await step(page, 'current').count()) === 0);
    // A key on a later row is not an answer to anything.
    await page.locator('[data-testid=trouble-step][data-state=later] .trouble-step__head').first().focus();
    await page.keyboard.press('1');
    await settle(page, 300);
    check('[keys] 1 on a later row answers nothing', (await answers(page)).filter((a) => a === 'ok').length === 1, (await answers(page)).join(','));
    check('[glyph] answered steps show as glyphs, not colours', /✓/.test(await T(page, 'trouble-steps').innerText()) && /✗/.test(await T(page, 'trouble-steps').innerText()));
    check('[canvas] the suspect carries a word, not colour alone', (await page.locator('.react-flow__node.trouble-suspect').count()) >= 1);
    check('[plan] Plan a fix is live once something is suspect', (await T(page, 'trouble-plan').getAttribute('aria-disabled')) === 'false');
    check('[affected] Also affected is shown', /also affected/i.test(await T(page, 'trouble-panel').innerText()));
    await ink(page, '[flow] narrowed');
    await shot(page, '03-narrowed');

    // A typed note is stored as typed; a real paste goes through the gate.
    await page.locator('[data-testid=trouble-step][data-state=current] button', { hasText: 'Why?' }).first().focus().catch(() => {});
    await T(page, 'trouble-steps').locator('.trouble-step__head').first().click();
    await settle(page, 300);
    check('[keys] clicking row 1 opens it and the header says 1 of', /\b1 of \d/i.test(await T(page, 'trouble-title').innerText()), await T(page, 'trouble-title').innerText());
    await page.getByRole('button', { name: 'Add what you saw' }).click();
    const note = page.getByLabel('What you saw (optional)');
    await note.fill('Light is off. Rotate the pre-shared key later.\n');
    check('[note] the field says typed text is stored as typed', /does not redact what you type, only what you paste/.test(await T(page, 'trouble-panel').innerText()));
    await page.evaluate((t) => navigator.clipboard.writeText(t), JUNOS);
    await note.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+V');
    check('[note] the paste landed in the field', (await note.inputValue()).includes(SECRET));
    await page.evaluate((t) => navigator.clipboard.writeText(t), '\n' + JUNOS_SHORT);
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+V');
    check('[note] a short key pasted too', (await note.inputValue()).includes(SHORT));
    await page.keyboard.press('Escape');
    await settle(page, 300);
    check('[note] Esc leaves the note and keeps the panel', (await T(page, 'trouble-panel').count()) === 1);
    // A note that was only typed is kept exactly as typed.
    await T(page, 'trouble-steps').locator('.trouble-step__head').nth(1).click();
    await settle(page, 300);
    await page.getByRole('button', { name: 'Add what you saw' }).click();
    await page.getByLabel('What you saw (optional)').fill('Cable looked fine. Rotate the pre-shared key later.');

    // Plan a fix: saves the issue, makes the plan, links it, opens it.
    const savesBefore = await page.evaluate(() => window.__saveCount__);
    await T(page, 'trouble-plan').click();
    await page.waitForSelector('[data-testid=plans-panel]', { timeout: 10_000 });
    await settle(page, 1200);
    check('[plan] Plan a fix opens the plan in the plans surface', (await T(page, 'plans-panel').count()) === 1);
    const band = (await T(page, 'plans-band').innerText()).replace(/\s+/g, ' ');
    check('[plan] the plan is titled Fix: fw-01 is down', /Fix: fw-01 is down/.test(band + (await T(page, 'plans-panel').innerText())), band);
    const steps = await T(page, 'plans-step').count();
    check('[plan] one step per suspect', steps >= 1, String(steps));
    check('[plan] the saves were made', (await page.evaluate(() => window.__saveCount__)) > savesBefore);
    const posted = await page.evaluate(() => window.__requests__.filter((r) => r.method === 'POST').map((r) => r.bodyLatin1));
    check('[gate] no saved document contains the pasted secret', posted.every((b) => !b.includes(SECRET) && !b.includes('Zq7xK2mPv9Lw4N')));
    check('[gate] nor the short pasted key', posted.every((b) => !b.includes(SHORT)), SHORT);
    check('[gate] a note that was only typed is stored as typed', posted.some((b) => b.includes('Cable looked fine. Rotate the pre-shared key later.')));
    check('[gate] every save loads through the engine', (await page.evaluate(() => window.__saveLoadFailures__)).length === 0, (await page.evaluate(() => window.__saveLoadFailures__)).join(' | '));
    await shot(page, '04-plan-opened');
    await context.close();

    check('[flow] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  }

  // ---------------------------------------------------------------- 2. Save as an issue, the history, Mark closed
  {
    const { context, page, pageErrors } = await open();
    await opened(page);
    await page.keyboard.press('2');
    await settle(page, 300);
    check('[save] 2 answers Not OK', (await answers(page))[0] === 'not_ok');
    await T(page, 'trouble-save').click();
    await settle(page, 1000);
    check('[save] Save as an issue says it is saved to the history', (await T(page, 'trouble-saved').count()) === 1, await T(page, 'trouble-panel').innerText());
    check('[save] the answers are then read only', (await page.locator('[data-testid=trouble-step][data-state=current] [data-answer]:not([disabled])').count()) === 0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await settle(page, 400);
    check('[save] Close after saving closes without asking', (await T(page, 'trouble-panel').count()) === 0 && (await T(page, 'trouble-confirm').count()) === 0);
    check('[save] the canvas is back at full strength', (await page.locator('.react-flow__node.checks-faded').count()) === 0);
    await page.locator('.react-flow__node-chassis', { hasText: 'fw-01' }).click();
    await settle(page, 600);
    check('[history] the device page lists the saved issue', (await T(page, 'device-issues').count()) === 1 && (await T(page, 'device-issue').count()) === 1, await T(page, 'device-issues').innerText().catch(() => ''));
    await T(page, 'device-issue').click();
    await settle(page, 600);
    check('[history] opening it shows the saved answers read only', (await T(page, 'trouble-saved-head').count()) === 1 && /✗/.test(await T(page, 'trouble-steps').innerText().catch(() => '')) || (await page.locator('.trouble-steps--saved').count()) === 1);
    check('[history] it shows the frozen sentence', (await T(page, 'trouble-outcome').count()) === 1 && /Your answers point at/.test(await T(page, 'trouble-outcome').innerText()));
    await T(page, 'trouble-close-issue').click();
    await settle(page, 800);
    check('[history] Mark closed closes it', /closed/.test(await T(page, 'trouble-saved-head').innerText()), await T(page, 'trouble-saved-head').innerText());
    check('[history] Mark closed is gone once closed', (await T(page, 'trouble-close-issue').count()) === 0);
    await T(page, 'trouble-close').click();
    await settle(page, 300);

    // The Issue page in the Inventory: rows open it, keyboard too; Show on canvas goes back with it open.
    await page.getByText('Inventory', { exact: true }).first().click();
    await page.getByRole('button', { name: /^Issues/ }).click();
    await settle(page, 500);
    const row = page.locator('[data-testid=issues-list] tbody tr').first();
    check('[inventory] the Issues list has a keyboard-reachable row', (await row.getAttribute('tabindex')) === '0');
    await row.focus();
    await page.keyboard.press('Enter');
    await settle(page, 400);
    const ip = (await T(page, 'issue-page').innerText()).replace(/\s+/g, ' ');
    check('[inventory] Enter opens the Issue page: heading, Opened line, table, notes', /fw-01 is down/.test(ip) && /Opened .* · closed/i.test(ip) && /CHECK/i.test(ip) && /ANSWER/i.test(ip) && /NOTES/i.test(ip), ip.slice(0, 300));
    check('[inventory] the table has a row per check', (await page.locator('.issue-page__table tbody tr').count()) >= 4);
    await shot(page, '06-issue-page');
    await T(page, 'issue-show-on-canvas').click();
    await page.waitForSelector('[data-testid=trouble-panel]', { timeout: 10_000 });
    await settle(page, 600);
    check('[inventory] Show on canvas opens the saved issue on the canvas', (await T(page, 'trouble-saved-head').count()) === 1 && (await page.locator('.react-flow__node-chassis').count()) >= 1);
    await context.close();

    check('[save] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  }

  // ---------------------------------------------------------------- 3. close with unsaved answers asks
  {
    const { context, page, pageErrors } = await open();
    await opened(page);
    await page.keyboard.press('1');
    await settle(page, 300);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await settle(page, 300);
    check('[close] Close with unsaved answers asks first', (await T(page, 'trouble-confirm').count()) === 1);
    await page.getByRole('button', { name: 'Keep going' }).click();
    await settle(page, 300);
    check('[close] Keep going keeps the panel and the answer', (await T(page, 'trouble-panel').count()) === 1 && (await answers(page))[0] === 'ok');
    // Esc with focus on the canvas is the canvas's own: the panel stays.
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 300 } });
    await page.keyboard.press('Escape');
    await settle(page, 300);
    check("[close] Esc with focus on the canvas does not touch the panel", (await T(page, 'trouble-panel').count()) === 1);
    await T(page, 'trouble-step').first().focus();
    await page.keyboard.press('Escape');
    await settle(page, 400);
    check('[close] Esc inside the panel folds it and keeps the session', (await T(page, 'trouble-folded').count()) === 1 && (await T(page, 'trouble-panel').count()) === 0);
    check('[close] the fold leaves focus on the Open button', await page.evaluate(() => document.activeElement?.textContent?.startsWith('Open') === true && document.activeElement.closest('[data-testid=trouble-folded]') != null));
    await T(page, 'trouble-folded').getByRole('button', { name: /^Open/ }).click();
    await settle(page, 400);
    check('[close] opening it again finds the answer where it was', (await answers(page))[0] === 'ok');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Close anyway' }).click();
    await settle(page, 400);
    check('[close] Close anyway drops the session and nothing was saved', (await T(page, 'trouble-panel').count()) === 0 && (await page.evaluate(() => window.__saveCount__)) === 0);
    check('[close] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 3b. an open plan panel is folded when a session starts
  {
    const { context, page, pageErrors } = await open();
    await page.locator('.react-flow__node-chassis', { hasText: 'fw-01' }).click({ button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Plan a change' }).click();
    await page.waitForSelector('[data-testid=plans-panel]', { timeout: 10_000 });
    await opened(page, 'sw-02');
    check('[plans] starting a session folds the open plan panel, so the two never overlap', (await T(page, 'plans-panel').count()) === 0 && (await T(page, 'trouble-panel').count()) === 1);
    check('[plans] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 4. a read holder
  {
    const { context, page, pageErrors } = await open({ read: true });
    await page.locator('.react-flow__node-chassis', { hasText: 'fw-01' }).click({ button: 'right' });
    await settle(page, 400);
    const items = await page.locator('.drawing-context-menu__item').allInnerTexts();
    check("[read] the right-click menu does not offer It's down", !items.some((t) => /It's down/.test(t)), items.join(' | '));
    await page.keyboard.press('Escape');
    await page.locator('.react-flow__node-chassis', { hasText: 'fw-01' }).click();
    await settle(page, 500);
    check("[read] the device page has no It's down button", (await T(page, 'its-down-button').count()) === 0);
    check('[read] nothing opened', (await T(page, 'trouble-panel').count()) === 0);
    check('[read] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 5. phone width and dark mode
  for (const opts of [
    { tag: 'dark', w: 1400, h: 900, dark: true },
    { tag: 'phone', w: 390, h: 800, dark: false },
    { tag: 'phone-dark', w: 390, h: 800, dark: true },
  ]) {
    const { tag } = opts;
    const { context, page, pageErrors } = await open(opts);
    if (opts.w === 390) {
      // At phone width the canvas is narrow; the right-click still works on a device.
      await page.locator('.react-flow__node-chassis', { hasText: 'fw-01' }).click({ button: 'right', force: true });
      await page.locator('.drawing-context-menu__item', { hasText: "It's down" }).click();
      await page.waitForSelector('[data-testid=trouble-panel]', { timeout: 10_000 });
      await settle(page, 700);
    } else {
      await opened(page);
    }
    await page.keyboard.press('1');
    await page.keyboard.press('2');
    await settle(page, 400);
    const overflow = await page.evaluate(() => {
      const e = document.querySelector('[data-testid=trouble-panel]');
      return e && e.scrollWidth > e.clientWidth + 1 ? `${e.scrollWidth}>${e.clientWidth}` : '';
    });
    check(`[${tag}] the panel does not overflow sideways`, overflow === '', overflow);
    const box = await T(page, 'trouble-panel').boundingBox();
    if (opts.w === 390) {
      const lit = await page.locator('.react-flow__node-chassis:not(.checks-faded)').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().bottom));
      check(`[${tag}] the lit chain is above the panel, not under it`, lit.length > 0 && box != null && lit.every((b) => b <= box.y + 4), `${lit.map(Math.round).join(',')} vs panel top ${box?.y}`);
    }
    check(`[${tag}] the panel is on screen`, box != null && box.x >= -1 && box.x + box.width <= opts.w + 1, JSON.stringify(box));
    await ink(page, `[${tag}]`);
    await shot(page, `05-${tag}-panel`);
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
