// Proves ADR-0053 (docs/decisions/adr-0053-undo-that-records-notes-and-the-private-layer.md)
// by driven renders through the real `App`, network intercepted —
// `scripts/drive-config-drawer.mjs`'s own shape, reused: the shared
// throwaway harness (`scripts/drive-lib/harness.tsx` + `seed.ts` +
// `catalogue.json`, copied into `client/` at run time and removed below)
// mounts the REAL `App` with a session installed directly and
// `window.fetch` intercepted for the calls a signed-in steward's browser
// makes — nothing routed around the redaction gate.
//
// Four scenes, one harness, `?scene=` picks the seeded document
// (`scripts/drive-lib/seed.ts`):
//   trail    — ADR-0053 §1/§4: undo as a new batch, "undo of <label>" above
//              the change it reverses, both standing, the cable gone.
//   conflict — ADR-0053 §3: a colleague's change to the cable itself refuses
//              the undo by name; nothing is undone.
//   beside   — ADR-0053 §3, narrowed 2026-11-27: a colleague's note on a port beside the cable does not block
//              taking the cable back; the note stays.
//   note     — ADR-0053 §5/§6: a pasted note's real-length Junos PSK is
//              destroyed at the gate; the intercepted save body is free of it.
//   typed    — ADR-0053 §6: a typed note is stored as typed, and says so.
//
// **Current UI facts this drive learns, that an older one would not**: the
// trail is folded to a strip on the right edge — `button[aria-label="Open
// the trail"]` before reading `.racks-trail__row`; a refused undo opens the
// trail on its own regardless.
//
// Usage:
//   bash scripts/build-wasm.sh              # once, if the artefact is stale
//   node scripts/drive-undo-notes.mjs
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
// Playwright is reached by absolute path, never installed here (ADR-0032
// gate zero) — the same convention every `scripts/drive-*` follows.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, fails, waitForServer } from './drive-lib/kit.mjs';
import { openTheTrail } from './drive-lib/trail.mjs';

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
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });

const PREVIEW_HTML = CLIENT + '/drive.html';
const PREVIEW_TSX = CLIENT + '/src/drive.tsx';
const PREVIEW_SEED = CLIENT + '/src/drive-seed.ts';
const PREVIEW_CATALOGUE = CLIENT + '/public/drive-catalogue.json';

// The same verbatim canary `scripts/drive-config-drawer.mjs`'s own
// `PASTE_ONE`/`CANARY_ONE` pin — a real Junos IKE pre-shared-key stanza,
// already proved against the real gate by that script.
const CANARY = 'SuperSecret123';
const PSK_PASTE = `set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security ike proposal ike-prop authentication-method pre-shared-keys
set security ike proposal ike-prop dh-group group14
set security ike proposal ike-prop encryption-algorithm aes-256-cbc
set security ike policy ike-pol proposals ike-prop
set security ike policy ike-pol pre-shared-key ascii-text "SuperSecret123"
set security ike gateway gw-hq ike-policy ike-pol
set security ike gateway gw-hq address 198.51.100.10
set security ike gateway gw-hq external-interface ge-0/0/0.0
`;

// ---------------------------------------------------------------------------
const WASM_ARTIFACT = CLIENT + '/public/engine/fathom_wasm.wasm';
if (!existsSync(WASM_ARTIFACT)) {
  console.log('==> building the wasm artefact (missing): bash scripts/build-wasm.sh');
  execFileSync('bash', [ROOT + '/scripts/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
check('the wasm artefact exists', existsSync(WASM_ARTIFACT), WASM_ARTIFACT);

// Never overwrite a file someone already has there.
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
    <title>Fathom — ADR-0053 proof preview (throwaway, not shipped)</title>
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

/** How many cables the drawing shows once it has settled. As a design opens they are drawn, taken away for a few
 * milliseconds and drawn again, so one read straight after they first show can find none. */
async function cablesDrawn(page) {
  let last = -1;
  for (let i = 0; i < 20; i += 1) {
    const now = await page.locator('.react-flow__edge-cable').count();
    if (now > 0 && now === last) return now;
    last = now;
    await page.waitForTimeout(150);
  }
  return last;
}

let viteProc = null;
let browser = null;

try {
  console.log(`==> starting the client dev server on port ${PORT}`);
  viteProc = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: CLIENT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let viteLog = '';
  viteProc.stdout.on('data', (d) => { viteLog += d.toString(); });
  viteProc.stderr.on('data', (d) => { viteLog += d.toString(); });

  const up = await waitForServer(`${BASE}/drive.html`, 30_000);
  check('client dev server answers /drive.html', up, up ? '' : viteLog.slice(-2000));
  if (!up) throw new Error('dev server did not come up');

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // -------------------------------------------------------------------------
  // Scene 1 — trail: a cable connected, then Ctrl Z.
  // -------------------------------------------------------------------------
  {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=trail`);
    await page.waitForSelector('.react-flow__edge-cable', { timeout: 15_000 });
    check('trail: the cable is on the drawing before undo', (await cablesDrawn(page)) === 1);

    await openTheTrail(page);
    // A row says what changed in words and to what; the label as recorded is what the words show when pointed at.
    const recordedAs = (row) => page.locator('.racks-trail__row').nth(row).locator('.racks-trail__col--what [title]').getAttribute('title');
    const rowsBefore = await page.locator('.racks-trail__row').allTextContents();
    check('trail: the cable connected is the newest row before undo', (rowsBefore[0] ?? '').includes('Cable connected · core-01 and acc-01') && (await recordedAs(0)) === 'Recorded as: connect ports', `${rowsBefore[0]} [${await recordedAs(0)}]`);

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(1_800); // ADR-0053 §4: past SEAL_SETTLE_MS, so the new row reads sealed too

    const rowsAfter = await page.locator('.racks-trail__row').allTextContents();
    check('trail: the top row reads as that undone, recorded as "undo of connect ports"', (rowsAfter[0] ?? '').includes('Undone: cable connected · core-01 and acc-01') && (await recordedAs(0)) === 'Recorded as: undo of connect ports', `${rowsAfter[0]} [${await recordedAs(0)}]`);
    check('trail: the reversed row still stands beneath it', (rowsAfter[1] ?? '').includes('Cable connected · core-01 and acc-01') && (await recordedAs(1)) === 'Recorded as: connect ports', `${rowsAfter[1]} [${await recordedAs(1)}]`);
    check('trail: the cable is off the drawing after undo', (await page.locator('.react-flow__edge-cable').count()) === 0);
    check('trail: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

    await page.screenshot({ path: SHOTS + 's6i-trail.png' });
    console.log('    wrote ' + SHOTS + 's6i-trail.png');

    // A press on a row opens the record behind it: what a pointer reads by resting on the row, for a keyboard and
    // a touch screen too. Opening a record changes nothing in the design.
    const me = (await page.evaluate(() => window.__driveActors__)).me;
    const rowAt = (i) => page.locator('.racks-trail__row').nth(i);
    const recordNow = () => page.locator('.racks-trail__record-line').evaluateAll((lines) => Object.fromEntries(lines.map((l) => [l.querySelector('dt').textContent, l.querySelector('dd').textContent])));
    const focusedRow = () => page.evaluate(() => [...document.querySelectorAll('.racks-trail__row')].indexOf(document.activeElement));
    await rowAt(0).click();
    const pressed = await recordNow();
    check(
      'trail: a press on a row opens its record: the whole moment, the account id and the label as recorded',
      /^\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d \(UTC/.test(pressed.When ?? '') && pressed['Account id'] === me && pressed['Recorded as'] === 'undo of connect ports' && (await rowAt(0).getAttribute('aria-expanded')) === 'true',
      JSON.stringify(pressed),
    );
    await page.screenshot({ path: SHOTS + 's6i-trail-record.png' });
    console.log('    wrote ' + SHOTS + 's6i-trail-record.png');
    await rowAt(0).click();
    check('trail: a second press closes it', (await page.locator('.racks-trail__record').count()) === 0 && (await rowAt(0).getAttribute('aria-expanded')) === 'false');

    // The row's words can still be selected and copied: a drag over them is not a press.
    const words = await rowAt(0).locator('.racks-trail__col--what').boundingBox();
    await page.mouse.move(words.x + 1, words.y + words.height / 2);
    await page.mouse.down();
    await page.mouse.move(words.x + 90, words.y + words.height / 2, { steps: 6 });
    await page.mouse.up();
    const dragged = await page.evaluate(() => getSelection().toString());
    check('trail: a drag over a row selects its words and does not open the record', dragged.length > 3 && (await page.locator('.racks-trail__record').count()) === 0, JSON.stringify(dragged));
    await page.evaluate(() => getSelection().removeAllRanges());

    // By keyboard: Tab stops once in the rows, Down goes to the next row, Enter opens it, Tab leaves for the comment box.
    await page.locator('[data-testid=history-tab-trail]').focus();
    await page.keyboard.press('Tab');
    const firstStop = await focusedRow();
    await page.keyboard.press('ArrowDown');
    const afterDown = await focusedRow();
    await page.keyboard.press('Enter');
    const byKey = await recordNow();
    await page.keyboard.press('Tab');
    const leftFor = await page.evaluate(() => document.activeElement?.id ?? '');
    check(
      'trail: by keyboard, Tab stops on the newest row, Down goes to the next, Enter opens its record, and Tab leaves for the comment box',
      firstStop === 0 && afterDown === 1 && byKey['Recorded as'] === 'connect ports' && leftFor === 'racks-trail-comment',
      `Tab: row ${firstStop}; Down: row ${afterDown}; Enter: ${JSON.stringify(byKey)}; Tab: #${leftFor}`,
    );

    // With a device selected the drawing moves it a unit on Up and Down. Pressed in the rows, the keys are the trail's.
    const device = page.locator('.react-flow__node-chassis', { hasText: 'acc-01' }).first();
    await device.click();
    await openTheTrail(page);
    const rowsWere = await page.locator('.racks-trail__row').count();
    await rowAt(1).focus();
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) await page.keyboard.press(key);
    await page.waitForTimeout(400);
    const rowsAfterKeys = await page.locator('.racks-trail__row').count();
    const rowAfterKeys = await focusedRow();
    // The same key with the keyboard on the drawing does move it, so the device could have moved.
    await device.click();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(600);
    await openTheTrail(page);
    const rowsAfterDrawingKey = await page.locator('.racks-trail__row').count();
    check(
      'trail: with a device selected, the arrow keys pressed in the rows move between rows and leave the device where it is',
      rowsAfterKeys === rowsWere && rowAfterKeys === 2 && rowsAfterDrawingKey === rowsWere + 1,
      `rows ${rowsWere}; after three keys in the rows ${rowsAfterKeys}, on row ${rowAfterKeys}; after Down on the drawing ${rowsAfterDrawingKey}`,
    );

    // The keyboard goes to a button outside the drawing with Tab: the arrows, Delete and Backspace are that button's,
    // and the selected device stays as it is. A press with the pointer gives them back to the selection.
    const rowCount = () => page.locator('.racks-trail__row').count();
    const walkTo = async (selector) => {
      await page.locator(selector).focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      return page.evaluate(() => {
        const el = document.activeElement;
        return el instanceof HTMLButtonElement && el.closest('.drawing') == null ? (el.getAttribute('data-testid') ?? el.textContent) : null;
      });
    };
    await device.click();
    await openTheTrail(page);
    const rowsBeforeWalk = await rowCount();
    const walkedTo = await walkTo('[data-testid=history-tab-trail]');
    for (const key of ['ArrowUp', 'ArrowDown', 'Delete', 'Backspace']) await page.keyboard.press(key);
    await page.waitForTimeout(600);
    const rowsAfterWalk = await rowCount();
    const devicesAfterWalk = await device.count();
    // The pointer pressed on that same button, which keeps the focus: the next Up is the selection's.
    await page.locator('[data-testid=history-tab-trail]').click();
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(600);
    const rowsAfterPointer = await rowCount();
    check(
      'keys: on a button Tab went to, outside the drawing, the arrows, Delete and Backspace leave the selected device as it is; after a press with the pointer on that button, Up moves it',
      walkedTo != null && rowsAfterWalk === rowsBeforeWalk && devicesAfterWalk === 1 && rowsAfterPointer === rowsBeforeWalk + 1,
      `the keyboard on: ${walkedTo}; rows ${rowsBeforeWalk}, after the four keys ${rowsAfterWalk}, device there: ${devicesAfterWalk === 1}; after the pointer and Up ${rowsAfterPointer}`,
    );

    // A device picked in Search from the keyboard is the selection's to move, though the focus goes back to the button.
    await walkTo('[data-testid=history-tab-trail]');
    await page.keyboard.press('Control+k');
    await page.locator('.palette input').waitFor({ timeout: 5_000 });
    await page.keyboard.type('acc-01');
    await page.waitForTimeout(400);
    const firstFound = ((await page.locator('.palette [role=option][aria-selected=true]').first().textContent().catch(() => '')) ?? '').trim();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const backOn = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null);
    // No press with the pointer from here to the key: the trail is read as it stands.
    const rowsBeforeFound = await rowCount();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(600);
    const rowsAfterFound = await rowCount();
    check(
      'keys: a device picked in Search from the keyboard moves with Down, with the focus back on the button Tab had gone to',
      firstFound.includes('acc-01') && backOn === 'history-tab-trail' && rowsBeforeFound > 0 && rowsAfterFound === rowsBeforeFound + 1,
      `Search found: ${firstFound.slice(0, 40)}; the focus back on: ${backOn}; rows ${rowsBeforeFound} -> ${rowsAfterFound}`,
    );

    // A menu opened with the pointer has the keys while it is open, though the pointer was pressed last. Closed,
    // they are the selection's again.
    const rowsBeforeMenu = await rowCount();
    await page.locator('[data-testid=shell-show]').click();
    const menuOpen = (await page.locator('.shell-popover[role=menu]').count()) === 1;
    for (const key of ['ArrowUp', 'ArrowDown', 'Delete', 'Backspace']) await page.keyboard.press(key);
    await page.waitForTimeout(600);
    const rowsWithMenu = await rowCount();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(600);
    const rowsAfterMenu = await rowCount();
    check(
      'keys: with a menu opened with the pointer the arrows, Delete and Backspace leave the selected device as it is; the menu closed, Up moves it',
      menuOpen && rowsWithMenu === rowsBeforeMenu && rowsAfterMenu === rowsBeforeMenu + 1,
      `menu open: ${menuOpen}; rows ${rowsBeforeMenu}, with the menu open ${rowsWithMenu}, after it closed and Up ${rowsAfterMenu}`,
    );

    const selectedDevices = () => page.locator('.drawing-chassis--selected').count();
    // How far down its rack the device is drawn: the same whatever the camera does.
    const downItsRack = async () => {
      const d = await device.boundingBox();
      const r = await page.locator('.react-flow__node-rack').first().boundingBox();
      return d != null && r != null ? Math.round(d.y - r.y) : null;
    };

    // A pick in Search is answered once: it selects the device and opens it. Let go of with Escape, a level a press,
    // the device is the person's to leave: a later change to the design selects nothing and opens nothing.
    const held = async () => `${await selectedDevices()} selected, ${await page.locator('.drawing-config-drawer').count()} open`;
    let letGo = 0;
    for (; letGo < 5 && (await held()) !== '0 selected, 0 open'; letGo += 1) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
    const heldBeforeUndo = await held();
    const downBeforeUndo = await downItsRack();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(900);
    const downAfterUndo = await downItsRack();
    const heldAfterUndo = await held();
    check(
      'keys: a pick in Search is answered once: let go of with Escape, the device is not selected or opened again by a later Undo',
      heldBeforeUndo === '0 selected, 0 open' && downBeforeUndo != null && downAfterUndo != null && downAfterUndo !== downBeforeUndo && heldAfterUndo === '0 selected, 0 open',
      `after ${letGo} Escape: ${heldBeforeUndo}; Undo moved the device ${downBeforeUndo} -> ${downAfterUndo}; then: ${heldAfterUndo}`,
    );

    // Enter on the device the keyboard is on selects it, as a press on it does. The keyboard gets there with Tab, and
    // no pointer is pressed from here on. Space is left alone: on the drawing it is held to pan.
    const keyboardOnDevice = () =>
      page.evaluate(() => document.activeElement?.classList.contains('react-flow__node-chassis') === true && (document.activeElement.textContent ?? '').includes('acc-01'));
    const selectedBefore = await selectedDevices();
    await device.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const walkedToDevice = await keyboardOnDevice();
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    const selectedAfterSpace = await selectedDevices();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const selectedAfterEnter = await selectedDevices();
    const detailsSays = ((await page.locator('.drawing-editor__title').first().innerText().catch(() => '')) ?? '').trim();
    const wasDown = await downItsRack();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(700);
    const isDown = await downItsRack();
    check(
      'keys: Enter on the device the keyboard is on selects it and shows its Details, Space does not, and Down then moves it',
      walkedToDevice && selectedBefore === 0 && selectedAfterSpace === 0 && selectedAfterEnter === 1 && detailsSays.includes('acc-01') && wasDown != null && isDown != null && isDown > wasDown + 2,
      `the keyboard on the device: ${walkedToDevice}; selected ${selectedBefore}, after Space ${selectedAfterSpace}, after Enter ${selectedAfterEnter}; Details: ${detailsSays.slice(0, 30)}; down its rack ${wasDown} -> ${isDown}`,
    );
    // Escape steps out one level a press: the card that comes up beside the device the keyboard rests on goes
    // first, then the selection. The keyboard stays on the device, so Enter selects it again.
    const letGoOf = async () => {
      const peekUp = await page.locator('.port-peek').count();
      let escapes = 0;
      for (; escapes < 3 && (await selectedDevices()) > 0; escapes += 1) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      }
      return { selected: await selectedDevices(), oneEach: escapes <= 1 + peekUp, escapes, peekUp, onDevice: await keyboardOnDevice() };
    };
    const afterMove = await letGoOf();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const selectedAgain = await selectedDevices();
    // Straight after Enter, with no change between, React Flow has the device marked selected too, and on Escape
    // takes the keyboard off it a frame later. It is put back.
    const afterEnter = await letGoOf();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const selectedThird = await selectedDevices();
    check(
      'keys: Escape clears the selection and leaves the keyboard on the device, after a move and straight after Enter, so Enter selects it again',
      afterMove.selected === 0 && afterMove.oneEach && afterMove.onDevice && selectedAgain === 1 && afterEnter.selected === 0 && afterEnter.oneEach && afterEnter.onDevice && selectedThird === 1,
      `after a move: ${JSON.stringify(afterMove)}; Enter again: ${selectedAgain}; straight after Enter: ${JSON.stringify(afterEnter)}; Enter again: ${selectedThird}`,
    );
    await page.keyboard.press('Escape');
    check('trail: no uncaught page errors after the record', pageErrors.length === 0, pageErrors.join(' | '));
    await page.close();
  }

  // -------------------------------------------------------------------------
  // Scene 2 — conflict: my change, a colleague's batch on the same element,
  // then Ctrl Z. A refused undo opens the trail by itself.
  // -------------------------------------------------------------------------
  {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=conflict`);
    await page.waitForSelector('.react-flow__edge-cable', { timeout: 15_000 });
    check('conflict: the cable is on the drawing before undo', (await cablesDrawn(page)) === 1);

    const colleague = (await page.evaluate(() => window.__driveActors__)).colleague;

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(600);
    await openTheTrail(page); // belt and braces: a refused undo opens it on its own too

    const refusal = await page.locator('.racks-trail__refusal').allTextContents();
    // In words: what was changed, by whom as histories name people, and what that change was. No id is quoted.
    check(
      "conflict: the refusal says what was changed since, and what the colleague's change was",
      refusal.some((t) => /Nothing was undone: the cable from \S+ to \S+ was changed by a colleague since \(cable label changed\)\./.test(t) && !t.includes(colleague)),
      refusal.join(' | '),
    );
    check('conflict: the cable is still on the drawing (nothing undone)', (await page.locator('.react-flow__edge-cable').count()) === 1);
    const rows = await page.locator('.racks-trail__row').allTextContents();
    check('conflict: no undo row landed', !rows.some((r) => r.includes('Undone')), rows.join(' | '));
    check('conflict: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

    await page.screenshot({ path: SHOTS + 's6i-conflict.png' });
    console.log('    wrote ' + SHOTS + 's6i-conflict.png');
    await page.close();
  }

  // -------------------------------------------------------------------------
  // Scene 2b — beside: a colleague's note on a port of mine is not in the way of taking the cable back.
  // -------------------------------------------------------------------------
  {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=beside`);
    await page.waitForSelector('.react-flow__edge-cable', { timeout: 15_000 });
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(600);
    await openTheTrail(page);
    check('beside: the cable is gone, the undo went through', (await page.locator('.react-flow__edge-cable').count()) === 0);
    check('beside: no refusal is shown', (await page.locator('.racks-trail__refusal').count()) === 0);
    const rows = await page.locator('.racks-trail__row').allTextContents();
    check('beside: an undo row landed, and the colleague\'s note row stands', rows.some((r) => r.includes('Undone')) && rows.some((r) => r.includes('Note added')), rows.join(' | '));
    check('beside: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await page.close();
  }

  // -------------------------------------------------------------------------
  // Scene 2c — long: a trail longer than a page is drawn a page at a time.
  // -------------------------------------------------------------------------
  {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=long`);
    await page.waitForSelector('[data-testid=dock-history]', { timeout: 15_000 }).catch(async (e) => {
      await page.screenshot({ path: SHOTS + 'r161-long-debug.png' });
      console.log(pageErrors.join(' | '), (await page.locator('body').innerText()).slice(0, 300));
      throw e;
    });
    await openTheTrail(page);
    const more = page.locator('.racks-trail__more');
    check('long: the first page is 50 rows', (await page.locator('.racks-trail__row').count()) === 50, String(await page.locator('.racks-trail__row').count()));
    check('long: the button says how many are not shown', ((await more.textContent()) ?? '').includes('not shown'), await more.textContent());
    await page.screenshot({ path: SHOTS + 'r161-long-first.png' });
    await more.click();
    const after = await page.locator('.racks-trail__row').count();
    check('long: a press draws the rest, one page being enough for it', after >= 62 && after <= 100, String(after));
    check('long: the button goes when every change is drawn', (await page.locator('.racks-trail__more').count()) === 0);
    check('long: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await page.close();
  }

  // -------------------------------------------------------------------------
  // Scene 3 — note: a pasted, real-length Junos PSK, destroyed at the gate.
  // -------------------------------------------------------------------------
  {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=note`);
    await page.click('.react-flow__node-chassis >> nth=0');
    // A click selects the device and shows its card. Its Details are a tab of the right-hand dock.
    if (!(await page.locator('.drawing-editor__panel').isVisible())) await page.getByTestId('dock-details').click();
    await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
    await page.getByRole('tab', { name: 'Notes' }).click();

    const noteBox = page.locator('.drawing-editor__panel textarea[placeholder="add a note"]');
    await noteBox.fill(PSK_PASTE);
    await page.locator('.drawing-editor__panel button', { hasText: 'add pasted' }).click();
    await page.waitForSelector('.drawing-editor__panel .config-drawer__block', { timeout: 20_000 });

    const blockText = await page.locator('.drawing-editor__panel .config-drawer__block').first().innerText();
    // The label is whichever set-form pass destroys the value first. The EdgeOS pass runs
    // first and does not know this Junos statement, so it reads "unknown"; the check is
    // that the value was destroyed and never shown.
    check('note: the black block reads "destroyed at the gate"', blockText.includes('destroyed at the gate') && !blockText.includes(CANARY), blockText);

    await page.waitForTimeout(500); // the queued save, fired by applyDocChange
    const requests = await page.evaluate(() => window.__requests__);
    const saves = requests.filter((r) => r.method === 'POST' && r.url.includes('/versions'));
    check('note: a save request was made', saves.length > 0, `${requests.length} total requests`);
    check(
      'note: the intercepted save body is free of the pasted PSK',
      requests.every((r) => !r.bodyLatin1.includes(CANARY)),
      requests.filter((r) => r.bodyLatin1.includes(CANARY)).map((r) => r.method + ' ' + r.url).join(', '),
    );
    check('note: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

    await page.locator('.drawing-editor__panel .config-drawer__block').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: SHOTS + 's6i-note.png' });
    console.log('    wrote ' + SHOTS + 's6i-note.png');
    await page.close();
  }

  // -------------------------------------------------------------------------
  // Scene 4 — typed: stored as typed, and says so.
  // -------------------------------------------------------------------------
  {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/drive.html?scene=typed`);
    await page.click('.react-flow__node-chassis >> nth=0');
    // A click selects the device and shows its card. Its Details are a tab of the right-hand dock.
    if (!(await page.locator('.drawing-editor__panel').isVisible())) await page.getByTestId('dock-details').click();
    await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });
    await page.getByRole('tab', { name: 'Notes' }).click();

    const noteBox = page.locator('.drawing-editor__panel textarea[placeholder="add a note"]');
    await noteBox.fill('Uplink patched Tuesday, ports relabelled.');
    await page.locator('.drawing-editor__panel button', { hasText: 'add typed' }).click();
    await page.waitForTimeout(500);

    const panelText = await page.locator('.drawing-editor__panel').innerText();
    check(
      'typed: the "stored as typed" sentence is shown',
      panelText.includes('stored as typed') && panelText.includes('Fathom does not redact what you type, only what you paste'),
    );
    check('typed: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

    const typedNote = page.locator('.drawing-editor__panel', { hasText: 'stored as typed' });
    await typedNote.scrollIntoViewIfNeeded();
    await page.screenshot({ path: SHOTS + 's6i-typed.png' });
    console.log('    wrote ' + SHOTS + 's6i-typed.png');
    await page.close();
  }

  await browser.close();
  browser = null;
} finally {
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
