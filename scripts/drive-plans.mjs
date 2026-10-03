// Drives the maintenance plans flow (ADR-0061 round 7) on the real App over the `canvas` scene: Plan a change,
// steps, Do, Went differently, Record, Show changes, list view and print, phone width, dark mode, keyboard,
// the gate, no amber. Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-plans.mjs.
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
  const shot = async (page, name) => {
    await page.screenshot({ path: SHOTS + 'plans-' + name + '.png' });
    console.log('    wrote ' + SHOTS + 'plans-' + name + '.png');
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

  // ---------------------------------------------------------------- 1. the whole flow, light, desktop
  {
    const { context, page, pageErrors } = await open();
    const fw = page.locator('.react-flow__node-chassis', { hasText: 'fw-01' });
    check('[flow] no plans surface before a plan is opened', (await T(page, 'plans-band').count()) === 0 && (await T(page, 'plans-panel').count()) === 0);

    await fw.click({ button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Plan a change' }).click();
    await page.waitForSelector('[data-testid=plans-panel]', { timeout: 10_000 });
    await settle(page);
    check('[flow] right-click Plan a change opens the band', (await T(page, 'plans-band').count()) === 1);
    check('[flow] and the panel in Plan mode', (await T(page, 'plans-panel').getAttribute('data-mode')) === 'plan');
    check('[flow] the band names the plan for the device', /fw-01/.test(await T(page, 'plans-band').innerText()), (await T(page, 'plans-band').innerText()).replace(/\s+/g, ' '));
    check('[flow] the add-step form is open with Move chosen', (await form(page).count()) === 1 && /Move/i.test(await labelled(page, 'Kind').evaluate((e) => e.options[e.selectedIndex].text)));
    check('[flow] focus is inside the form, not on the body', await page.evaluate(() => document.activeElement?.closest('[data-testid=plans-add-step]') != null));
    check('[flow] Start work is off with no steps', await page.getByRole('button', { name: 'Start work' }).isDisabled());
    await shot(page, '01-plan-empty');

    // A move step: the device is filled in from the right-click.
    await pick(labelled(page, 'To rack'), /A-04/);
    await labelled(page, 'Rack unit').fill('11');
    await form(page).getByRole('button', { name: 'Add step' }).click();
    await settle(page);
    check('[flow] a move step is added', (await T(page, 'plans-step').count()) === 1, await T(page, 'plans-panel').innerText());

    // An address step.
    await labelled(page, 'Kind').selectOption('address');
    await pick(labelled(page, 'Device'), /sw-02/);
    await labelled(page, 'New management address').fill('10.0.1.1');
    // Typed words about a secret are not a secret: stored as typed, and the form says so (ADR-0053 section 6).
    const TYPED_WORDS = 'Rotate the pre-shared key on fw-01';
    await labelled(page, 'What changes (optional)').fill(TYPED_WORDS);
    check('[typed] the add-step form says typed text is stored as typed', /does not redact what you type, only what you paste/.test(await form(page).locator('[data-testid=plans-typed]').innerText()));
    await form(page).getByRole('button', { name: 'Add step' }).click();
    await settle(page);
    check('[flow] an address step is added', (await T(page, 'plans-step').count()) === 2);
    check('[typed] typed "Rotate the pre-shared key" is stored intact', (await T(page, 'plans-panel').innerText()).includes(TYPED_WORDS), (await T(page, 'plans-panel').innerText()).replace(/\s+/g, ' ').slice(0, 300));

    // A cable step onto a port that already has a cable: the checks will refuse it on the day.
    await labelled(page, 'Kind').selectOption('cable');
    await pick(labelled(page, 'From device'), /fw-01/);
    const fromPorts = await optionTexts(labelled(page, 'From port'));
    console.log('    from ports: ' + fromPorts.slice(0, 6).join(' | '));
    await labelled(page, 'From port').selectOption({ index: 2 });
    await pick(labelled(page, 'To device'), /sw-02/);
    const toPorts = await optionTexts(labelled(page, 'To port'));
    console.log('    to ports: ' + toPorts.slice(0, 6).join(' | '));
    await labelled(page, 'To port').selectOption({ index: 1 });
    await form(page).getByRole('button', { name: 'Add step' }).click();
    await settle(page);
    check('[flow] a cable step is added', (await T(page, 'plans-step').count()) === 3, await T(page, 'plans-panel').innerText());
    await settle(page, 1200);
    check('[flow] the canvas marks devices with a dashed outline in the plan colour', (await page.locator('.react-flow__node.plan-mark--plan.plan-mark--dashed').count()) >= 2, String(await page.locator('.react-flow__node.plan-mark').count()));
    const markStyle = await page.locator('.react-flow__node.plan-mark--plan').first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, color: cs.outlineColor, word: getComputedStyle(el, '::after').content };
    });
    check('[flow] the mark is dashed indigo (not amber)', markStyle.style === 'dashed' && markStyle.color === 'rgb(75, 63, 196)', JSON.stringify(markStyle));
    check('[flow] the mark carries a word, not colour alone', /PLANNED|STEP/i.test(markStyle.word), markStyle.word);
    check('[flow] a ghost or marked cable is drawn for the cable step', (await page.locator('.plan-ghost__line, .plan-mark__dash').count()) >= 1);
    const touches = await T(page, 'plans-panel').innerText();
    check('[flow] What it touches is shown', /What it touches/i.test(touches) && (await T(page, 'plans-touches').count()) + (await page.locator('.plans-note', { hasText: /touched/ }).count()) >= 1, touches.replace(/\s+/g, ' ').slice(0, 400));
    await amber(page, '[flow] planning');
    await shot(page, '02-planned');

    // Start work.
    await page.getByRole('button', { name: 'Start work' }).click();
    await settle(page, 1200);
    check('[do] Start work moves the panel to Do', (await T(page, 'plans-panel').getAttribute('data-mode')) === 'do');
    check('[do] focus moves into the panel, not the body', await focusNotBody(page));
    const liveButtons = async () => page.locator('[data-testid=plans-panel] .plans-checklist button').allInnerTexts();
    check('[do] only the current step has buttons', (await T(page, 'plans-step').and(page.locator('[data-state=current]')).count()) === 1 && (await liveButtons()).join('|') === 'Mark done|Went differently', (await liveButtons()).join('|'));
    check('[do] the band is teal-staged', (await T(page, 'plans-band').getAttribute('data-stage')) === 'doing');
    const faded = await page.locator('.react-flow__node.checks-faded').count();
    const full = await page.locator('.react-flow__node:not(.checks-faded)').count();
    check('[do] the canvas fades to the current step', faded > 0 && full >= 1, `${faded} faded, ${full} full`);
    const tealMark = await page.locator('.react-flow__node.plan-mark--do, .react-flow__node.plan-mark--done').first().evaluate((el) => getComputedStyle(el).outlineColor).catch(() => 'none');
    console.log('    do mark outline: ' + tealMark);
    await amber(page, '[do]');
    await shot(page, '03-do');

    // Mark done in order.
    await page.getByRole('button', { name: 'Mark done' }).click();
    await settle(page, 1000);
    check('[do] step 1 is marked done and step 2 is current', (await page.locator('[data-testid=plans-step][data-state=done]').count()) === 1 && (await page.locator('[data-testid=plans-step][data-state=current]').count()) === 1, await T(page, 'plans-panel').innerText());
    check('[do] focus follows to the next step, not the body', await focusNotBody(page));
    check('[do] the next step still has the only live buttons', (await liveButtons()).join('|') === 'Mark done|Went differently');
    await page.getByRole('button', { name: 'Mark done' }).click();
    await settle(page, 1000);
    check('[do] step 2 is marked done', (await page.locator('[data-testid=plans-step][data-state=done]').count()) === 2);

    // Step 3: the checks refuse the Done and offer Went differently.
    await page.getByRole('button', { name: 'Mark done' }).click();
    await settle(page, 1200);
    const refused = await T(page, 'plans-refused').count();
    check('[do] a refused Done says so and why', refused === 1, await T(page, 'plans-panel').innerText());
    if (refused === 1) {
      const rt = await T(page, 'plans-refused').innerText();
      check('[do] the refusal offers Went differently', /Went differently/.test(rt), rt.replace(/\s+/g, ' '));
      check('[do] the refusal has a Fix and Why?', /Fix:/.test(rt) && /Why\?/.test(rt));
      check('[do] the refusal is announced once (the card, no second notice)', (await page.locator('[data-testid=plans-panel] [role=alert]').count()) === 1);
      check('[do] the step stays current after a refusal', (await page.locator('[data-testid=plans-step][data-state=current]').count()) === 1);
      await shot(page, '04-refused');
      await page.locator('[data-testid=plans-refused]').getByRole('button', { name: 'Why?' }).click();
      await settle(page, 300);
      check('[do] Why? opens the card', (await page.locator('.checks-why, [data-testid=checks-why]').count()) >= 1);
      await page.keyboard.press('Escape');
      await settle(page, 300);
      check('[do] Esc closes the card and focus is not on the body', (await page.locator('[data-testid=checks-why]').count()) === 0 && (await focusNotBody(page)));
    }
    // Went differently: the note is required.
    await page.getByRole('button', { name: 'Went differently' }).click();
    await settle(page, 300);
    const save = page.getByRole('button', { name: 'Save, went differently' });
    check('[do] the note field takes focus', await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'));
    check('[do] Save is off with no note', await save.isDisabled());
    await page.keyboard.type('   ');
    check('[do] a blank note does not enable Save', await save.isDisabled());
    await page.keyboard.press('Escape');
    await settle(page, 300);
    check('[do] Esc cancels the form and focus returns to its button', await page.evaluate(() => document.activeElement?.textContent === 'Went differently'));
    await page.getByRole('button', { name: 'Went differently' }).click();
    await page.keyboard.type('Port was in use, patched to a spare instead.');
    await save.click();
    await settle(page, 1200);
    check('[do] Went differently is saved with its note', (await page.locator('.plans-step--recorded[data-state=went_differently]', { hasText: 'Port was in use' }).count()) === 1, await T(page, 'plans-panel').innerText());

    // Record.
    check('[record] the panel moves to Record', (await T(page, 'plans-panel').getAttribute('data-mode')) === 'record', await T(page, 'plans-panel').innerText());
    check('[record] focus is inside the panel, not the body', await focusNotBody(page));
    check('[record] Record is off until an outcome is chosen', await page.getByRole('button', { name: 'Record', exact: true }).isDisabled());
    const chips = await T(page, 'plans-panel').locator('.plans-chip').allInnerTexts();
    console.log('    outcomes: ' + chips.join(' | '));
    await T(page, 'plans-panel').locator('.plans-chip').nth(1).click();
    check('[record] a chosen outcome is pressed', (await T(page, 'plans-panel').locator('.plans-chip[aria-pressed=true]').count()) === 1);
    // Typed first, then a REAL paste (clipboard, Ctrl+V into the textarea): the paste is what sends it through the gate.
    const wrong = page.getByLabel('What went wrong');
    check('[record] the record field says typed text is stored as typed', /does not redact what you type, only what you paste/.test(await T(page, 'plans-panel').locator('[data-testid=plans-typed]').innerText()));
    await wrong.fill('Switch rejected the key.\n');
    await page.evaluate((t) => navigator.clipboard.writeText(t), JUNOS);
    await wrong.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+V');
    check('[record] the paste landed in the field', (await wrong.inputValue()).includes(SECRET), (await wrong.inputValue()).slice(0, 80));
    await shot(page, '05-record');
    await amber(page, '[record]');
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await settle(page, 1500);
    check('[record] the plan is recorded', (await T(page, 'plans-panel').getAttribute('data-stage')) === 'recorded');
    check('[record] the band is in ink (recorded)', (await T(page, 'plans-band').getAttribute('data-stage')) === 'recorded');
    const shownRecord = await T(page, 'plans-panel').innerText();
    check('[record] the secret is not on screen', !shownRecord.includes(SECRET), shownRecord.replace(/\s+/g, ' ').slice(0, 300));
    const requests = await page.evaluate(() => window.__requests__.filter((r) => r.method === 'POST').map((r) => r.bodyLatin1));
    check('[record] saves were made', requests.length >= 5, String(requests.length));
    check('[record] no saved document contains the secret', requests.every((b) => !b.includes(SECRET) && !b.includes('Zq7xK2mPv9Lw4N')));
    const rec = await T(page, 'plans-panel').locator('.plans-record').innerText();
    console.log('    stored record reads: ' + rec.replace(/\s+/g, ' '));
    check('[record] the stored text is a marker or quarantine sketch, not the line', /REDACTED|<word>|\[/i.test(rec) && !/pre-shared-key ascii-text \S{20}/.test(rec), rec);
    check('[record] History line names the devices', /Saved to the history of/.test(await T(page, 'plans-history').innerText().catch(() => '')));
    check('[record] focus is not on the body', await focusNotBody(page));
    await amber(page, '[recorded]');
    await shot(page, '06-recorded');

    // Show these changes.
    await T(page, 'plans-show-changes').click();
    await settle(page, 1200);
    check('[record] Show these changes presses and fades the canvas', (await T(page, 'plans-show-changes').getAttribute('aria-pressed')) === 'true' && (await page.locator('.react-flow__node.checks-faded').count()) > 0);
    const recMark = await page.locator('.react-flow__node.plan-mark').first().evaluate((el) => getComputedStyle(el).outlineStyle).catch(() => 'none');
    check('[record] recorded marks are solid, not dashed', recMark !== 'dashed', recMark);
    await amber(page, '[show changes]');
    await shot(page, '07-show-changes');
    await page.mouse.move(5, 5);
    await page.keyboard.press('Escape');
    await settle(page, 400);
    check('[record] Esc clears Show these changes', (await T(page, 'plans-show-changes').getAttribute('aria-pressed')) === 'false');

    // List view.
    await page.getByRole('button', { name: 'List view' }).click();
    await settle(page, 600);
    check('[list] the list page opens', (await T(page, 'plans-page').count()) === 1);
    check('[list] it has a table of steps', (await page.locator('.plans-table tbody tr').count()) === 3);
    const lp = await T(page, 'plans-page').innerText();
    check('[list] it shows What it touches and Notes', /What it touches/i.test(lp) && /Notes/i.test(lp));
    check('[list] the notes carry the step note and the outcome', /Port was in use/.test(lp) && /Switch rejected the key/.test(lp));
    check('[list] the secret is not on the page', !lp.includes(SECRET));
    check('[list] the panel is gone behind it', (await T(page, 'plans-panel').count()) === 0);
    await settle(page, 300);
    await amber(page, '[list]');
    await shot(page, '08-list');

    // Delete does nothing under the page: select a device first, then press it everywhere.
    await page.getByRole('button', { name: 'Back to canvas' }).click();
    await settle(page, 400);
    check('[list] Back to canvas returns focus to the List view button', await page.evaluate(() => document.activeElement?.id != null && document.activeElement.textContent === 'List view'));
    check('[list] the canvas is back', (await T(page, 'plans-page').count()) === 0);
    await context.close();
  }

  // ---------------------------------------------------------------- 2. Delete under the list view
  {
    const { context, page, pageErrors } = await open();
    const nodes = () => page.locator('.react-flow__node-chassis').count();
    const before = await nodes();
    const fw = page.locator('.react-flow__node-chassis', { hasText: 'fw-01' });
    await fw.click({ button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Plan a change' }).click();
    await page.waitForSelector('[data-testid=plans-panel]');
    await settle(page);
    await fw.click();
    await settle(page, 400);
    const savesBefore = await page.evaluate(() => window.__saveCount__);
    await page.getByRole('button', { name: 'List view' }).click();
    await settle(page, 500);
    check('[delete] the list view is open', (await T(page, 'plans-page').count()) === 1);
    check('[delete] the canvas under it is inert', await page.evaluate(() => [...document.querySelectorAll('.react-flow')].every((e) => e.closest('[inert]') != null || e.closest('[aria-hidden=true]') != null)));
    for (const key of ['Delete', 'Backspace']) {
      await page.keyboard.press(key);
      await page.locator('body').press(key).catch(() => {});
      await T(page, 'plans-print').focus();
      await page.keyboard.press(key);
    }
    await page.mouse.click(700, 500);
    await page.keyboard.press('Delete');
    await settle(page, 800);
    check('[delete] Delete does nothing while the list view is open', (await nodes()) === before && (await page.evaluate(() => window.__saveCount__)) === savesBefore, `${await nodes()} of ${before}`);
    await page.getByRole('button', { name: 'Back to canvas' }).click();
    await settle(page, 600);
    check('[delete] the device is still on the canvas after Back', (await nodes()) === before);
    check('[delete] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 3. keyboard order
  {
    const { context, page, pageErrors } = await open();
    await page.locator('.react-flow__node-chassis', { hasText: 'fw-01' }).click({ button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Plan a change' }).click();
    await page.waitForSelector('[data-testid=plans-panel]');
    await settle(page);
    await pick(labelled(page, 'To rack'), /A-04/);
    await labelled(page, 'Rack unit').fill('11');
    await page.keyboard.press('Enter');
    await settle(page, 800);
    check('[keys] Enter in the form adds the step', (await T(page, 'plans-step').count()) === 1);
    // Tab through the panel: always an element, in DOM order, never the body.
    await T(page, 'plans-panel').getByRole('button', { name: 'Fold the plan panel' }).focus();
    const order = [];
    let fellToBody = 0;
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      const d = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        return { text: (a.getAttribute('aria-label') || a.textContent || a.id || a.tagName).trim().slice(0, 24), inPanel: a.closest('[data-testid=plans-panel]') != null, tag: a.tagName };
      });
      if (d == null) { fellToBody += 1; order.push('(BODY)'); }
      else order.push(d.inPanel ? d.text : '(outside) ' + d.text);
    }
    console.log('    tab order: ' + order.join(' > '));
    // Past the last control the browser wraps through its own chrome: one body stop, right after the panel's last control.
    const wrapAt = order.indexOf('(BODY)');
    check('[keys] Tab never drops focus to the body except at the document wrap', fellToBody <= 1 && (wrapAt === -1 || /Open the trail/.test(order[wrapAt - 1] ?? '') || wrapAt === order.length - 1), `${fellToBody} at ${wrapAt}`);
    check('[keys] Tab reaches the Start work button', order.includes('Start work'));
    check('[keys] the panel header comes before its body in the tab order', order.indexOf('Fold the plan panel') === -1 || order.indexOf('Start work') > -1);
    // Reorder and remove: the button that was pressed may go or turn off; focus must stay in the panel.
    await pick(labelled(page, 'Device'), /sw-02/);
    await pick(labelled(page, 'To rack'), /A-04/);
    await labelled(page, 'Rack unit').fill('9');
    await form(page).getByRole('button', { name: 'Add step' }).click();
    await settle(page, 700);
    await page.getByRole('button', { name: 'Move step 1 down' }).click();
    await settle(page, 300);
    check('[keys] after Down on the first step focus is not on the body', await focusNotBody(page), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
    await page.getByRole('button', { name: 'Move step 2 up' }).click();
    await settle(page, 300);
    check('[keys] after Up focus is not on the body', await focusNotBody(page), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
    await page.getByRole('button', { name: 'Remove step 2' }).click();
    await settle(page, 600);
    check('[keys] after Remove focus is not on the body', await focusNotBody(page), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
    check('[keys] Remove took one step off', (await T(page, 'plans-step').count()) === 1);
    // Fold and reopen.
    await T(page, 'plans-panel').getByRole('button', { name: 'Fold the plan panel' }).click();
    await settle(page, 300);
    check('[keys] Fold hides the panel and leaves an Open panel button', (await T(page, 'plans-panel').count()) === 0 && (await page.getByRole('button', { name: 'Open panel' }).count()) === 1);
    check('[keys] focus is not lost to the body after Fold', await focusNotBody(page));
    await page.getByRole('button', { name: 'Open panel' }).click();
    await settle(page, 300);
    check('[keys] Open panel shows it again', (await T(page, 'plans-panel').count()) === 1);
    check('[keys] focus is not lost to the body after Open panel', await focusNotBody(page));
    // New plan from the band: its form takes focus, Cancel and Make plan hand it on.
    await page.getByRole('button', { name: 'New plan' }).click();
    await settle(page, 300);
    check('[keys] New plan puts focus in its title field', await page.evaluate(() => document.activeElement?.closest('[data-testid=plans-new]') != null));
    await page.getByRole('button', { name: 'Cancel' }).click();
    await settle(page, 300);
    check('[keys] Cancel on the new-plan form leaves focus on a control', await focusNotBody(page));
    await page.getByRole('button', { name: 'New plan' }).click();
    await page.keyboard.type('Second plan');
    await page.keyboard.press('Enter');
    await settle(page, 800);
    check('[keys] Make plan opens the new plan and focus is not on the body', (await T(page, 'plans-band').innerText()).includes('Second plan') && (await focusNotBody(page)), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
    await page.locator('.plans-band__pick select').selectOption({ index: 1 });
    await settle(page, 500);
    // Close plan, Plans chip.
    await page.getByRole('button', { name: 'Close plan' }).click();
    await settle(page, 400);
    check('[keys] Close plan removes the marks and the panel', (await T(page, 'plans-panel').count()) === 0 && (await page.locator('.plan-mark').count()) === 0);
    check('[keys] focus is not lost to the body after Close plan', await focusNotBody(page));
    check('[keys] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 4. dark mode and a phone
  for (const [tag, opts] of [['dark', { dark: true }], ['phone', { w: 390, h: 844 }], ['phone-dark', { w: 390, h: 844, dark: true }]]) {
    const { context, page, pageErrors } = await open(opts);
    await page.locator('.react-flow__node-chassis', { hasText: 'fw-01' }).click({ button: 'right' });
    await page.locator('.drawing-context-menu__item', { hasText: 'Plan a change' }).click();
    await page.waitForSelector('[data-testid=plans-panel]');
    await settle(page);
    await pick(labelled(page, 'To rack'), /A-04/);
    await labelled(page, 'Rack unit').fill('11');
    await form(page).getByRole('button', { name: 'Add step' }).click();
    await settle(page, 800);
    await labelled(page, 'Kind').selectOption('address');
    await pick(labelled(page, 'Device'), /sw-02/);
    await labelled(page, 'New management address').fill('10.0.1.1');
    await form(page).getByRole('button', { name: 'Add step' }).click();
    await settle(page, 1000);
    const inside = async (sel) => {
      const b = await page.locator(sel).first().boundingBox();
      const vw = opts.w ?? 1400;
      return b != null && b.x >= -1 && b.x + b.width <= vw + 1;
    };
    check(`[${tag}] the panel fits the width`, await inside('[data-testid=plans-panel]'), JSON.stringify(await T(page, 'plans-panel').boundingBox()));
    check(`[${tag}] the band fits the width`, await inside('[data-testid=plans-band]'), JSON.stringify(await T(page, 'plans-band').boundingBox()));
    if (opts.w === 390) {
      const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 6).map((e) => `${e.tagName}.${String(e.className?.baseVal ?? e.className).slice(0, 30)} ${Math.round(e.getBoundingClientRect().right)}`));
      console.log('    wider than the window: ' + wide.join(' ; '));
    }
    // The shell bar is wider than a phone with or without a plan (not the plan's); the plan's own parts must fit.
    const overflow = await page.evaluate(() => ['plans-band', 'plans-panel'].map((id) => document.querySelector(`[data-testid=${id}]`)).filter((e) => e && e.scrollWidth > e.clientWidth + 1).map((e) => `${e.dataset.testid} ${e.scrollWidth}>${e.clientWidth}`));
    check(`[${tag}] the band and panel do not overflow sideways`, overflow.length === 0, overflow.join(' ; '));
    await shot(page, `10-${tag}-panel`);
    await amber(page, `[${tag}]`);
    const col = await page.evaluate(() => {
      const el = document.querySelector('.react-flow__node.plan-mark--plan');
      return el ? getComputedStyle(el).outlineColor : null;
    });
    if (tag.includes('dark')) check(`[${tag}] the plan colour is the light indigo`, col === 'rgb(164, 156, 242)', String(col));
    await page.getByRole('button', { name: 'Start work' }).click();
    await settle(page, 1000);
    await shot(page, `11-${tag}-do`);
    await amber(page, `[${tag} do]`);
    await page.getByRole('button', { name: 'Mark done' }).click();
    await settle(page, 700);
    await page.getByRole('button', { name: 'Went differently' }).click();
    await page.keyboard.type('Different address.');
    await page.getByRole('button', { name: 'Save, went differently' }).click();
    await settle(page, 1000);
    await T(page, 'plans-panel').locator('.plans-chip').first().click();
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await settle(page, 1000);
    await page.getByRole('button', { name: 'List view' }).click();
    await settle(page, 600);
    check(`[${tag}] the list page fits the width`, await page.evaluate(() => { const p = document.querySelector('[data-testid=plans-page]'); return p != null && p.scrollWidth <= p.clientWidth + 1; }), await page.evaluate(() => { const p = document.querySelector('[data-testid=plans-page]'); return p ? `${p.scrollWidth} > ${p.clientWidth}` : 'none'; }));
    if (opts.w === 390) {
      check(`[${tag}] the table stacks into cards`, await page.evaluate(() => getComputedStyle(document.querySelector('.plans-table tr')).display === 'block'));
    }
    await shot(page, `12-${tag}-list`);
    await amber(page, `[${tag} list]`);
    // Print.
    await page.emulateMedia({ media: 'print' });
    await settle(page, 300);
    const printed = await page.evaluate(() => {
      const vis = (el) => el != null && el.getClientRects().length > 0;
      const page = document.querySelector('[data-testid=plans-page]');
      const cs = getComputedStyle(page);
      return {
        bar: vis(document.querySelector('.shell-bar')),
        band: vis(document.querySelector('[data-testid=plans-band]')),
        tools: vis(document.querySelector('.plans-page__tools')),
        canvas: vis(document.querySelector('.react-flow')),
        color: cs.color,
        bg: cs.backgroundColor,
        pageVisible: vis(page),
        h: page.getBoundingClientRect().height,
      };
    });
    check(`[${tag}] print shows the page alone, in ink on white`, printed.pageVisible && !printed.bar && !printed.band && !printed.tools && !printed.canvas && printed.color === 'rgb(0, 0, 0)' && printed.bg === 'rgb(255, 255, 255)', JSON.stringify(printed));
    await shot(page, `13-${tag}-print`);
    await page.emulateMedia({ media: 'screen' });
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
