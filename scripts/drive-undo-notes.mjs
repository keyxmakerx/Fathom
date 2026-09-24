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
//   conflict — ADR-0053 §3: a colleague's batch on the same element refuses
//              the undo by name; nothing is undone.
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
import { dirname, resolve } from 'node:path';
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
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = '/tmp/claude-0/';
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

/** The trail is folded to a strip on the right edge — open it before
 * reading `.racks-trail__row`. A refused undo opens it on its own, but
 * every scene here opens it up front so a screenshot always shows it. */
async function openTheTrail(page) {
  const handle = page.locator('button[aria-label="Open the trail"]');
  if ((await handle.count()) > 0) {
    await handle.click();
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
    check('trail: the cable is on the drawing before undo', (await page.locator('.react-flow__edge-cable').count()) === 1);

    await openTheTrail(page);
    const rowsBefore = await page.locator('.racks-trail__row').allTextContents();
    check('trail: "connect ports" is the newest row before undo', (rowsBefore[0] ?? '').includes('connect ports'));

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(1_800); // ADR-0053 §4: past SEAL_SETTLE_MS, so the new row reads sealed too

    const rowsAfter = await page.locator('.racks-trail__row').allTextContents();
    check('trail: the top row reads "undo of connect ports"', (rowsAfter[0] ?? '').includes('undo of connect ports'), rowsAfter[0]);
    check('trail: the reversed row still stands beneath it', (rowsAfter[1] ?? '').includes('connect ports'), rowsAfter[1]);
    check('trail: the cable is off the drawing after undo', (await page.locator('.react-flow__edge-cable').count()) === 0);
    check('trail: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

    await page.screenshot({ path: SHOTS + 's6i-trail.png' });
    console.log('    wrote ' + SHOTS + 's6i-trail.png');
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
    check('conflict: the cable is on the drawing before undo', (await page.locator('.react-flow__edge-cable').count()) === 1);

    const colleague = (await page.evaluate(() => window.__driveActors__)).colleague;

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(600);
    await openTheTrail(page); // belt and braces: a refused undo opens it on its own too

    const refusal = await page.locator('.racks-trail__refusal').allTextContents();
    check(
      "conflict: the refusal names the colleague's change",
      refusal.some((t) => t.includes('add note') && t.includes(colleague)),
      refusal.join(' | '),
    );
    check('conflict: the cable is still on the drawing (nothing undone)', (await page.locator('.react-flow__edge-cable').count()) === 1);
    const rows = await page.locator('.racks-trail__row').allTextContents();
    check('conflict: no "undo of" row landed', !rows.some((r) => r.includes('undo of')), rows.join(' | '));
    check('conflict: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

    await page.screenshot({ path: SHOTS + 's6i-conflict.png' });
    console.log('    wrote ' + SHOTS + 's6i-conflict.png');
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
    await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });

    const noteBox = page.locator('.drawing-editor__panel textarea[placeholder="add a note"]');
    await noteBox.fill(PSK_PASTE);
    await page.locator('.drawing-editor__panel button', { hasText: 'add pasted' }).click();
    await page.waitForSelector('.drawing-editor__panel .config-drawer__block', { timeout: 20_000 });

    const blockText = await page.locator('.drawing-editor__panel .config-drawer__block').first().innerText();
    check('note: the black block reads "psk · destroyed at the gate"', blockText.includes('psk') && blockText.includes('destroyed at the gate'), blockText);

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
    await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });

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
