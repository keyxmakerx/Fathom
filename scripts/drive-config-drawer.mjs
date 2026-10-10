// Proves CLAUDE.md rule 4 ("device credentials are protected by never
// arriving; the redaction gate runs before anything is stored") end to end
// in a driven Chromium, against the real config drawer (ADR-0052) mounted
// under a real placed device, and grounds ground rule 13 by screenshot.
//
// **The harness.** `App.tsx` no longer takes a design open for granted — a
// real sign-in is a password and, for an account with a confirmed
// authenticator, a verification code (ADR-0056), and there is still no HTTP
// route that creates a design from nothing (`scripts/drive-lib/harness.tsx`'s
// own header goes through why a scripted browser enrolment does not exist in
// this tree either). So this drive uses the shared throwaway harness
// (`scripts/drive-lib/harness.tsx` + `seed.ts` + `catalogue.json`,
// copied into `client/` at run time and removed below): it mounts the REAL
// `App`, with a session installed directly (`setSession`, the same shape the
// lead's own throwaway `client/src/preview-audit.tsx` uses) and
// `window.fetch` intercepted for exactly the calls a signed-in steward's
// browser makes. One organisation, one design — `Home`'s own "exactly one
// place to go" rule (ADR-0046 §3) lands the browser directly in Racks, so
// this drives the real `RacksPlace`, therefore the real `ConfigDrawer`,
// `InsideStop`, `Mirror`, `Engine`, and the real compiled `fathom-wasm`
// module `scripts/build-wasm.sh` produces — the redaction gate itself never
// reimplemented in JavaScript, CLAUDE.md rule 4. No server is contacted for
// any intercepted call; the wasm artefact and Vite's own dev assets pass
// straight through to the real `fetch`. No database is touched by this
// script; none is created and none needs dropping.
//
// Usage:
//   bash scripts/build-wasm.sh              # once, if the artefact is stale
//   node scripts/drive-config-drawer.mjs
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
// Playwright is NOT a repo dependency (ADR-0032 gate zero) and is reached by
// absolute path from the machine, the same as every other `scripts/drive-*`.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDriveCpuThrottle } from './drive-lib/cpuThrottle.mjs';

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

// ---------------------------------------------------------------------------
// The two canaried pastes. `PASTE_ONE` is `crates/fathom-wasm/tests/paste.rs`'s
// own `PASTE`, verbatim, carrying the `SuperSecret123` canary that test
// pins by name. `PASTE_TWO` is `scripts/drive-reconciled-paste.mjs`'s own
// `PASTE` in SHAPE only — sent as the second paste attempt ADR-0052 §5's
// amendment says the drawer must refuse ("the door refuses a second
// paste... and says so"), so this also proves a REFUSED paste leaks
// nothing either.
//
// s6g #3, CLAUDE.md rule 2 ("test a safety gate against what a real device
// accepts, not against what the detector needs"): it was verbatim once, and
// its six `FATHOMDRIVE*` canaries were all longer than Junos would accept —
// exactly the failure that rule names, caught once already against
// `base64ish` (`crates/fathom-ingest/src/redact.rs`'s own `SECRET_WORD_LIST`
// doc, "`base64ish` requires 24 characters. Juniper documents this key as 1
// to 8.") and re-proved directly (`crates/fathom-ingest/tests/
// redaction_canary.rs`'s `an_eight_character_ospf_password_is_destroyed_
// because_of_its_name`, `secret = "Fath0m8x"`, 8 characters). The two cited
// Junos bounds — OSPF `simple-password` 1 to 8 characters, `md5` 1 to 16 —
// size every canary below: the `ospf...` one at 8, the rest at or under 16.
// Each is still unique and greppable, just short: `FATHOMDRIVE` itself (11
// characters) does not fit an 8-character field, so the OSPF one drops to
// the shorter `FDR` marker the others keep as a suffix.
// ---------------------------------------------------------------------------
const CANARY_ONE = 'SuperSecret123';
const PASTE_ONE = `set system host-name srx-branch-01
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
set security ipsec proposal ipsec-prop protocol esp
set security ipsec policy ipsec-pol proposals ipsec-prop
set security ipsec vpn hq-vpn ike gateway gw-hq
set security ipsec vpn hq-vpn ike ipsec-policy ipsec-pol
set security ipsec vpn hq-vpn bind-interface st0.0
set security zones security-zone trust interfaces ge-0/0/0.0
set security zones security-zone vpn interfaces st0.0
set routing-options static route 10.10.0.0/16 next-hop st0.0
set security policies from-zone trust to-zone vpn policy allow match source-address any
set security policies from-zone trust to-zone vpn policy allow match application any
`;

const CANARIES_TWO = [
  'ospfFDR1', // 8 chars — the OSPF `simple-password` bound, exactly
  'bgpBareFDR01', // 12 chars
  'bgpGroupFDR01', // 13 chars
  'bgpNeighFDR01', // 13 chars
  'ikePskFDR012345', // 15 chars
  'snmpCommFDR012', // 14 chars
];
const PASTE_TWO = `set system host-name srx-reconciled-01
set system time-zone America/New_York
set system ntp server 192.0.2.30
set routing-options router-id 10.0.0.9
set protocols ospf reference-bandwidth 100000000000
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 metric 100
set protocols ospf area 0.0.0.0 interface ge-0/0/2.0 passive
set protocols ospf area 0.0.0.1 interface st0.0 interface-type p2p
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 authentication simple-password ospfFDR1
set protocols bgp local-as 65001
set protocols bgp authentication-key bgpBareFDR01
set protocols bgp group ISP-EDGE authentication-key bgpGroupFDR01
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 peer-as 64512
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 authentication-key bgpNeighFDR01
set protocols rip group RIP-GRP neighbor ge-0/0/9.0
set vlans guests vlan-id 20
set vlans guests l3-interface irb.20
set interfaces ge-0/0/4 disable
set interfaces ge-0/0/6 unit 0 vlan-id 100
set security flow tcp-mss ipsec-vpn mss 1350
set security zones security-zone trust host-inbound-traffic protocols all
set security zones security-zone untrust tcp-rst
set security ike policy ike-pol pre-shared-key ascii-text ikePskFDR012345
set snmp community snmpCommFDR012 authorization read-only
`;

const ALL_CANARIES = [CANARY_ONE, ...CANARIES_TWO];

// ---------------------------------------------------------------------------
// Step 0: the wasm artefact. Never built here silently — if it is missing,
// build it the same way a developer would (`scripts/build-wasm.sh`), so a
// failure in that build is this script's own failure, not a confusing
// downstream one.
// ---------------------------------------------------------------------------
const WASM_ARTIFACT = CLIENT + '/public/engine/fathom_wasm.wasm';
if (!existsSync(WASM_ARTIFACT)) {
  console.log('==> building the wasm artefact (missing): bash scripts/build-wasm.sh');
  execFileSync('bash', [ROOT + '/scripts/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
check('the wasm artefact exists', existsSync(WASM_ARTIFACT), WASM_ARTIFACT);

// ---------------------------------------------------------------------------
// Step 1: copy the shared throwaway harness into `client/`. See
// `scripts/drive-lib/harness.tsx`'s own header for why it exists; every file
// it writes is removed in the `finally` below.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Step 2: the client dev server, port 5199, this run's own — never the
// shared 5173 default, so it never collides with anyone else's `npm run dev`.
// ---------------------------------------------------------------------------
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
  // Step 3: drive it. `?scene=` unset — the harness's own default, an empty
  // design (`seedEmptyDesign`) — so a sketch device is dropped onto the
  // pending rack by this script itself, exactly as ADR-0051's "a box with no
  // catalogue entry" scene asks for.
  // -------------------------------------------------------------------------
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await applyDriveCpuThrottle(page);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/drive.html`);
  // "Exactly one place to go" (ADR-0046 §3) lands the browser directly on
  // Racks — no Home click, no sign-in door, since the harness installs the
  // session and the one organisation/design pair directly.
  await page.click('button[aria-label="Open the equipment list"]');
  await page.waitForSelector('.drawing-palette__item', { timeout: 15_000 });
  await page.waitForSelector('[data-id="rack:pending-rack"]', { timeout: 15_000 });

  // Place a device from the palette — there is no catalogued Juniper SRX
  // yet (`corpus/catalogue/juniper/` holds only `ex4300-48p.yaml`), so this
  // is `document/commands.ts`'s `createSketchDevice`, the same "a box with
  // no catalogue entry" row ADR-0052 §5's own inside-stop test fixtures use
  // for a Juniper SRX340 (`InsideStop.render.test.ts`, `ConfigDrawer.render.test.ts`).
  // Native HTML5 drag-and-drop, simulated with a real `DataTransfer` —
  // `Palette.tsx`'s `onDragStart` and `Drawing.tsx`'s `onDrop` are both
  // ordinary DOM listeners and this is the standard way to drive them from
  // outside a real pointer.
  const dropped = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.drawing-palette__item'));
    const src = items.find((el) => el.textContent?.includes('Any device'));
    const tgt = document.querySelector('[data-id="rack:pending-rack"]');
    if (!src || !tgt) return false;
    const rect = tgt.getBoundingClientRect();
    const dt = new DataTransfer();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + rect.width / 2, clientY: rect.top + 100 };
    src.dispatchEvent(new DragEvent('dragstart', opts));
    tgt.dispatchEvent(new DragEvent('dragenter', opts));
    tgt.dispatchEvent(new DragEvent('dragover', opts));
    tgt.dispatchEvent(new DragEvent('drop', opts));
    src.dispatchEvent(new DragEvent('dragend', opts));
    return true;
  });
  check('sketch device dragged onto the rack', dropped);
  await page.waitForTimeout(300);
  check('one chassis placed', (await page.locator('.react-flow__node-chassis').count()) === 1);

  // Select it.
  await page.click('.react-flow__node-chassis', { position: { x: 2, y: 2 } });
  // Equipment and Details share the right-hand dock, and a device placed from an open Equipment
  // list keeps the list showing; its Details are one tab away.
  if (!(await page.locator('.drawing-editor__panel').isVisible())) await page.getByTestId('dock-details').click();
  await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });

  // A sketch device has no faceplate ports until typed by hand (UI-SPEC
  // "Inside a box": "guess neither"). Type the one the paste below will
  // name, so the drawer's own "click a line and the port it built lights"
  // (UI-SPEC "Config") has a real port to try to light.
  await page.locator('.drawing-editor__panel button', { hasText: '+ Add a port' }).click();
  await page.locator('.drawing-editor__panel').getByLabel('Label', { exact: true }).fill('ge-0/0/0');
  await page.locator('.drawing-editor__panel').getByRole('button', { name: 'Add port', exact: true }).click();
  await page.waitForTimeout(300);
  check('the ge-0/0/0 port typed onto the faceplate', (await page.locator('.drawing-editor__panel').innerText()).includes('ge-0/0/0'));

  // Zoom never opens the drawer (ADR-0061); a double-click on the device does.
  await page.locator('.react-flow__node-chassis').first().dblclick({ position: { x: 6, y: 8 } });
  await page.waitForSelector('.config-drawer', { timeout: 10_000 });
  check('the config drawer opened on a double-click', (await page.locator('.config-drawer').count()) === 1);

  // -------------------------------------------------------------------------
  // The first paste — the redaction gate, live.
  // -------------------------------------------------------------------------
  await page.locator('.config-drawer__paste-input').fill(PASTE_ONE);
  await page.locator('.config-drawer__paste-button').click();
  await page.waitForSelector('.config-drawer__lines', { timeout: 20_000 });
  await page.waitForTimeout(300);

  const blockTexts = await page.locator('.config-drawer__block').allTextContents();
  check(
    'a black block reading "destroyed at the gate" is present',
    blockTexts.some((t) => t.includes('destroyed at the gate')),
    blockTexts.join(' | '),
  );

  const lineMarks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.config-drawer__line')).map((el) => el.className),
  );
  const kept = lineMarks.filter((c) => c.includes('--kept')).length;
  const destroyed = lineMarks.filter((c) => c.includes('--destroyed')).length;
  const built = lineMarks.filter((c) => c.includes('--built')).length;
  check('every pasted line got one gutter mark', lineMarks.length === 21, `${lineMarks.length} lines`);
  console.log(`    gutter marks: ${built} built, ${kept} kept, ${destroyed} destroyed`);
  // `document/capture.ts`'s `builtSpans` compares `Origin::Parsed.capture`
  // (the wire's bare ULID) against the capture node's own bare ULID
  // (`parseNodeId(node.id).ulid`), not its formatted `capture:<ulid>` node
  // id — asserted here against the real engine and the real component, not
  // only in `capture.test.ts`'s own hand-built fixtures.
  check('at least one line is marked built', built > 0, `${built} built`);

  // The psk line names `pre-shared-key` and also binds the ike policy's own
  // fields (`ike-pol`'s `proposals`/gateway lines are the same statement
  // shape) — ADR-0052 §2's own rule for this exact case: "built AND
  // destroyed on one line is `built`, with the drop carried alongside it",
  // never a fourth mark. Its own black block ("a black block reading
  // 'destroyed at the gate' is present", above) is what still says the
  // value is gone; the gutter mark is `built`, not `destroyed`.
  const pskLineClass = await page
    .locator('.config-drawer__line', { hasText: 'pre-shared-key' })
    .first()
    .getAttribute('class');
  check(
    'the psk line is marked built (it also binds), carrying its own destroyed block',
    (pskLineClass ?? '').includes('--built'),
    pskLineClass ?? 'line not found',
  );

  // s6g #2: scroll the destroyed-value block itself into view before the
  // screenshot — the proof above already found it by locator regardless of
  // scroll position, but the point of THIS shot is to show a human "a
  // visible black block," which a block sitting below the fold would not.
  await page.locator('.config-drawer__block').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS + 's6g-drawer.png' });
  console.log('    wrote ' + SHOTS + 's6g-drawer.png');

  // -------------------------------------------------------------------------
  // Hover the line that DID build (`Interface.name = "ge-0/0/0"`, confirmed
  // by direct inspection of the round-tripped `Document` while writing this
  // script) and screenshot whatever the faceplate does in response — lit,
  // per UI-SPEC "Config", if the finding above does not block it.
  // -------------------------------------------------------------------------
  const ifaceLine = page.locator('.config-drawer__line', { hasText: 'set interfaces ge-0/0/0 unit 0' });
  await ifaceLine.hover();
  await page.waitForTimeout(300);
  const litCount = await page.locator('.drawing-port--lit').count();
  check(
    'hovering the ge-0/0/0 line lights its port',
    litCount > 0,
    `${litCount} lit port elements`,
  );
  await page.screenshot({ path: SHOTS + 's6g-lit.png' });
  console.log('    wrote ' + SHOTS + 's6g-lit.png');

  // The inside view opens from the device's right-click menu, not from zoom.
  await page.locator('.react-flow__node-chassis').first().click({ button: 'right', position: { x: 6, y: 8 } });
  await page.getByRole('menuitem', { name: 'Inside' }).click();
  await page.waitForSelector('.drawing-inside-stop', { timeout: 10_000 });
  check('the inside stop opened for the same device', (await page.locator('.drawing-inside-stop').count()) === 1);
  const insideText = await page.locator('.drawing-inside-stop').innerText();
  check('the inside stop names the pasted hostname', insideText.includes('srx-branch-01'));
  check('the inside stop shows the built interface', insideText.includes('ge-0/0/0'));
  await page.screenshot({ path: SHOTS + 's6g-inside.png' });
  console.log('    wrote ' + SHOTS + 's6g-inside.png');

  // Back to the config drawer for the second paste attempt.
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawing-inside-stop', { state: 'detached', timeout: 10_000 });
  await page.locator('.react-flow__node-chassis').first().dblclick({ position: { x: 6, y: 8 } });
  await page.waitForSelector('.config-drawer', { timeout: 10_000 });

  // -------------------------------------------------------------------------
  // The second paste attempt — six more canaries, a config the drawer must
  // REFUSE (ADR-0052 §5's amendment: a live capture already exists on this
  // device). The refusal itself is asserted; the canaries must be absent
  // regardless of whether the paste was accepted or refused.
  // -------------------------------------------------------------------------
  await page.locator('.config-drawer__paste-input').fill(PASTE_TWO);
  await page.locator('.config-drawer__paste-button').click();
  await page.waitForTimeout(800);
  const refusalText = await page.locator('.config-drawer__refusal').allTextContents();
  check(
    'the second paste is refused, and says so',
    refusalText.some((t) => t.includes('already carries a live capture')),
    refusalText.join(' | '),
  );

  // -------------------------------------------------------------------------
  // THE SECURITY PROOF. Every canary from both pastes, absent from every
  // recorded `window.fetch` request body (the save path — decoded as latin1
  // and searched, per this task's own instruction) and from the whole
  // rendered page, not only the capture pane.
  // -------------------------------------------------------------------------
  const requests = await page.evaluate(() => window.__requests__);
  const saveRequests = requests.filter((r) => r.method === 'POST' && r.url.includes('/versions'));
  check('at least one save request was made', saveRequests.length > 0, `${requests.length} total requests`);

  for (const canary of ALL_CANARIES) {
    const leaks = requests.filter((r) => r.bodyLatin1.includes(canary));
    check(`absent from every request body: ${canary}`, leaks.length === 0, leaks.map((r) => r.method + ' ' + r.url).join(', '));
  }

  const html = await page.content();
  for (const canary of ALL_CANARIES) {
    check(`absent from page.content(): ${canary}`, !html.includes(canary));
  }

  // Where the drawer leaves the camera: sixteen devices in one rack, the
  // drawer opened on one and then switched to another.
  const camPage = await context.newPage();
  await applyDriveCpuThrottle(camPage);
  camPage.on('pageerror', (e) => pageErrors.push(e.message));
  await camPage.goto(`${BASE}/drive.html?scene=node-identity`);
  await camPage.waitForFunction(() => document.querySelectorAll('.react-flow__node-chassis').length === 16, null, { timeout: 15_000 });
  await camPage.waitForTimeout(800);
  // The plate's centre as a fraction of the pane's height, the drawer's top the same way, and the camera's zoom.
  const plateAboveDrawer = (host) => camPage.evaluate((host) => {
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    const drawer = document.querySelector('.drawing-config-drawer')?.getBoundingClientRect();
    const plate = [...document.querySelectorAll('.react-flow__node-chassis')].find((e) => e.textContent.includes(host)).getBoundingClientRect();
    const scale = /scale\(([^)]+)\)/.exec(document.querySelector('.react-flow__viewport').style.transform)?.[1];
    return {
      plate: +((plate.y + plate.height / 2 - pane.y) / pane.height).toFixed(3),
      drawerTop: drawer ? +((drawer.y - pane.y) / pane.height).toFixed(3) : null,
      zoom: Number(scale),
    };
  }, host);
  const inStrip = (at) => at.drawerTop != null && at.plate > 0 && at.plate < at.drawerTop && at.zoom === 2;
  await camPage.locator('.react-flow__node-chassis', { hasText: 'dev-05' }).dblclick({ position: { x: 6, y: 6 } });
  await camPage.waitForSelector('.config-drawer', { timeout: 10_000 });
  await camPage.waitForTimeout(1000);
  const opened = await plateAboveDrawer('dev-05');
  check('on opening, the plate sits above the drawer at exactly the faceplate stop', inStrip(opened), JSON.stringify(opened));
  // dev-12 may be under the drawer, so the click goes to the node itself rather than to a point on screen.
  await camPage.locator('.react-flow__node-chassis', { hasText: 'dev-12' }).dispatchEvent('dblclick');
  await camPage.waitForTimeout(1000);
  const switched = await plateAboveDrawer('dev-12');
  check('after switching devices, the new plate sits above the drawer at exactly the faceplate stop', inStrip(switched), JSON.stringify(switched));
  await camPage.screenshot({ path: SHOTS + 's6g-drawer-switch.png' });
  console.log('    wrote ' + SHOTS + 's6g-drawer-switch.png');
  await camPage.close();

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // -------------------------------------------------------------------------
  // The read-only view. `?capability=read` is the one input `App`/
  // `DesignPlace` reads for this (the design summary's own `capability`
  // field, `document/design/useDesignSession.ts`'s `canDrawFor`) — a fresh
  // page load, a fresh (empty) design, so the point is "no write capability
  // was ever exercised", which an empty read-only design shows exactly as
  // well as a populated one would.
  // -------------------------------------------------------------------------
  const roPage = await context.newPage();
  await roPage.goto(`${BASE}/drive.html?capability=read`);
  await roPage.waitForTimeout(1500);
  const roReqs = await roPage.evaluate(() => window.__requests__);
  const roSaves = roReqs.filter((r) => r.method === 'POST' && r.url.includes('/versions'));
  const roInputs = await roPage.locator('input, textarea').count();
  check('read-only: "View only" is shown', (await roPage.locator('body').innerText()).includes('View only'));
  check('read-only: zero save (version) POSTs', roSaves.length === 0, `${roReqs.length} total requests`);
  check('read-only: zero inputs or textareas in the DOM', roInputs === 0, `${roInputs} found`);
  await roPage.screenshot({ path: SHOTS + 's6g-readonly.png' });
  console.log('    wrote ' + SHOTS + 's6g-readonly.png');
  await roPage.close();

  await browser.close();
  browser = null;
} finally {
  // -------------------------------------------------------------------------
  // Cleanup — every step, even on failure. Nothing the harness needs may
  // stay in `client/` after this run.
  // -------------------------------------------------------------------------
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
