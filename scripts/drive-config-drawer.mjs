// Proves CLAUDE.md rule 4 ("device credentials are protected by never
// arriving; the redaction gate runs before anything is stored") end to end
// in a driven Chromium, against the real config drawer (ADR-0052) mounted
// under a real placed device, and grounds ground rule 13 by screenshot.
//
// TWO PATHS, one script. The primary path this session's brief names —
// a real `fathom-server` on its own database, a real enrolment/sign-in, a
// real design opened over signed HTTP — needs two things that do not exist
// yet in this tree:
//
//   1. A scripted, driven-BROWSER enrolment. `crates/fathom-server/tests/*`
//      (`design_api.rs`'s own `bootstrap`/`enrol`, mirrored by every other
//      integration test in that crate) writes accounts, keys and grants
//      straight into the database and then hand-signs HTTP calls itself —
//      it never drives `Enrol.tsx`'s real token redemption, which is the
//      only enrolment path a browser actually has. There is nothing under
//      `scripts/` that redeems a token through a browser either.
//   2. An HTTP route that CREATES a design.
//      `crates/fathom-server/src/design_api.rs`'s router has list / open /
//      save-a-version / history / verify — never create. `designs::create_design`
//      is a plain repository call `crates/fathom-server/tests/design_api.rs`'s
//      own `a_scope_and_design` reaches directly; nothing exposes it over
//      HTTP. A driven browser cannot reach an open design from nothing.
//
// So: NO SCRIPTED BROWSER ENROLMENT EXISTS FOR THIS SLICE, and the fallback
// this session's brief names is what ran — recorded here, not assumed:
//
//   FALLBACK RAN. A throwaway `client/preview.html` + `client/src/preview.tsx`
//   (written by this script below, deleted at the end — nothing but this
//   file is committed) mounts the REAL `RacksPlace`, therefore the real
//   `ConfigDrawer`, `InsideStop`, `Mirror`, `Engine`, and the real compiled
//   `fathom-wasm` module `scripts/build-wasm.sh` produces — the redaction
//   gate itself never reimplemented in JavaScript, CLAUDE.md rule 4. Inside
//   that page, `window.fetch` is overridding for exactly the calls
//   `RacksPlace` itself makes (session nonce, catalogue, open, save) —
//   never a real server, never routed around any gate. No database is
//   touched by this script; none is created and none needs dropping.
//
// Usage:
//   bash scripts/build-wasm.sh              # once, if the artefact is stale
//   node scripts/drive-config-drawer.mjs
//
// Environment, all overridable: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT.
// Playwright is NOT a repo dependency (ADR-0032 gate zero) and is reached by
// absolute path from the machine, the same as every other `scripts/drive-*`.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = '/tmp/claude-0/';
mkdirSync(SHOTS, { recursive: true });

const PREVIEW_HTML = CLIENT + '/preview.html';
const PREVIEW_TSX = CLIENT + '/src/preview.tsx';

const fails = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) fails.push(name);
}

// ---------------------------------------------------------------------------
// The two canaried pastes. `PASTE_ONE` is `crates/fathom-wasm/tests/paste.rs`'s
// own `PASTE`, verbatim, carrying the `SuperSecret123` canary that test
// pins by name. `PASTE_TWO` is `scripts/drive-reconciled-paste.mjs`'s own
// `PASTE`, verbatim, carrying its six `FATHOMDRIVE*` canaries — sent as the
// second paste attempt ADR-0052 §5's amendment says the drawer must refuse
// ("the door refuses a second paste... and says so"), so this also proves a
// REFUSED paste leaks nothing either.
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
  'FATHOMDRIVEospfSimplePw0123456789',
  'FATHOMDRIVEbgpKeyBare',
  'FATHOMDRIVEbgpKeyGroup',
  'FATHOMDRIVEbgpKeyNeighbour',
  'FATHOMDRIVEikePreShared0123456789',
  'FATHOMDRIVEsnmpCommunity',
];
const PASTE_TWO = `set system host-name srx-reconciled-01
set system time-zone America/New_York
set system ntp server 192.0.2.30
set routing-options router-id 10.0.0.9
set protocols ospf reference-bandwidth 100000000000
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 metric 100
set protocols ospf area 0.0.0.0 interface ge-0/0/2.0 passive
set protocols ospf area 0.0.0.1 interface st0.0 interface-type p2p
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 authentication simple-password FATHOMDRIVEospfSimplePw0123456789
set protocols bgp local-as 65001
set protocols bgp authentication-key FATHOMDRIVEbgpKeyBare
set protocols bgp group ISP-EDGE authentication-key FATHOMDRIVEbgpKeyGroup
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 peer-as 64512
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 authentication-key FATHOMDRIVEbgpKeyNeighbour
set protocols rip group RIP-GRP neighbor ge-0/0/9.0
set vlans guests vlan-id 20
set vlans guests l3-interface irb.20
set interfaces ge-0/0/4 disable
set interfaces ge-0/0/6 unit 0 vlan-id 100
set security flow tcp-mss ipsec-vpn mss 1350
set security zones security-zone trust host-inbound-traffic protocols all
set security zones security-zone untrust tcp-rst
set security ike policy ike-pol pre-shared-key ascii-text FATHOMDRIVEikePreShared0123456789
set snmp community FATHOMDRIVEsnmpCommunity authorization read-only
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
// Step 1: write the throwaway preview harness. See this file's own header
// for why it exists; deleted in the `finally` below.
// ---------------------------------------------------------------------------
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
    <script type="module" src="/src/preview.tsx"></script>
  </body>
</html>
`,
);

writeFileSync(
  PREVIEW_TSX,
  `// THROWAWAY. Written and deleted by `
    + `\`scripts/drive-config-drawer.mjs\` — never committed, never shipped.
// See that script's own header for why it exists: no HTTP route creates a
// design yet, and no scripted browser-token enrolment exists in this tree,
// so a driven run against a real server cannot reach an open design at all.
// This mounts the REAL \`RacksPlace\` (therefore the real \`ConfigDrawer\`,
// \`InsideStop\`, \`Mirror\`, \`Engine\`, and the real compiled \`fathom-wasm\`
// module — CLAUDE.md rule 4 never reimplemented here) with \`window.fetch\`
// overridden inside the page for the four calls \`RacksPlace\` itself makes.
// No server is contacted for any of them; the wasm artefact and Vite's own
// dev assets pass straight through to the real \`fetch\`.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import { lp } from './crypto/bytes';
import { generateKeyPair } from './crypto/keys';
import { emptyDocument } from './document/model';
import { SCHEMA_VERSION, writePlain } from './document/plain';
import { RacksPlace } from './components/racks/RacksPlace';
import { setSession } from './state/sessionState';

const ORG_ID = 'org-preview';
const DESIGN_ID = 'design-preview';

function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

async function bodyToBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  const buf = await new Response(body as BodyInit).arrayBuffer();
  return new Uint8Array(buf);
}

function schemaMinor(): number {
  const m = /^0\\.(\\d+)$/.exec(SCHEMA_VERSION);
  if (!m) throw new Error(\`SCHEMA_VERSION "\${SCHEMA_VERSION}" is not "0.<minor>"\`);
  return Number.parseInt(m[1], 10);
}

interface RecordedRequest {
  method: string;
  url: string;
  bodyLatin1: string;
}

declare global {
  interface Window {
    __requests__: RecordedRequest[];
    __setPreviewZoom__?: (zoom: number) => void;
  }
}

async function main() {
  window.__requests__ = [];
  const realFetch = window.fetch.bind(window);
  let saveVersion = 0;
  const emptyBytes = writePlain(emptyDocument());
  const minor = schemaMinor();

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const bodyBytes = await bodyToBytes(init?.body ?? null);
    window.__requests__.push({ method, url, bodyLatin1: bytesToLatin1(bodyBytes) });

    const path = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0]!;

    if (method === 'POST' && path === '/session/nonce') {
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      return new Response(lp(nonce) as BodyInit, { status: 200 });
    }

    if (method === 'GET' && path === '/catalogue/models') {
      return new Response(new TextEncoder().encode('[]'), { status: 200 });
    }

    if (method === 'GET' && path === \`/organisations/\${ORG_ID}/designs/\${DESIGN_ID}\`) {
      return new Response(emptyBytes as BodyInit, {
        status: 200,
        headers: {
          'fathom-design-version': String(saveVersion),
          'fathom-payload-schema-version': String(minor),
        },
      });
    }

    if (method === 'POST' && path === \`/organisations/\${ORG_ID}/designs/\${DESIGN_ID}/versions\`) {
      saveVersion += 1;
      return new Response(new TextEncoder().encode(\`\${saveVersion}\\n\`), { status: 200 });
    }

    return realFetch(input as RequestInfo, init);
  };

  const sessionKeyPair = await generateKeyPair();
  setSession({
    sessionId: 'preview-session',
    token: new Uint8Array(32),
    sessionKeyPair,
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
    address: 'proof-builder@fathom.test',
  });

  const params = new URLSearchParams(window.location.search);
  const readonly = params.get('readonly') === '1';

  function Harness() {
    const [zoom, setZoom] = useState(100);
    useEffect(() => {
      window.__setPreviewZoom__ = setZoom;
      return () => {
        delete window.__setPreviewZoom__;
      };
    }, []);
    return (
      <RacksPlace
        organisationId={ORG_ID}
        designId={DESIGN_ID}
        capability={readonly ? 'read' : 'write'}
        zoom={zoom}
        onZoomChange={setZoom}
        onZoomIn={() => setZoom((z) => Math.min(400, z + 10))}
        onZoomOut={() => setZoom((z) => Math.max(10, z - 10))}
        place="racks"
        onPlaceChange={() => {}}
        path={[]}
        tree={null}
        lens="cables"
        onLensChange={() => {}}
        presence={[]}
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        account={{ initials: 'PB', address: 'proof-builder@fathom.test' }}
      />
    );
  }

  createRoot(document.getElementById('root')!).render(<Harness />);
}

void main();
`,
);
check('preview.html written', existsSync(PREVIEW_HTML));
check('preview.tsx written', existsSync(PREVIEW_TSX));

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

  const up = await waitForServer(`${BASE}/preview.html`, 30_000);
  check('client dev server answers /preview.html', up, up ? '' : viteLog.slice(-2000));
  if (!up) throw new Error('dev server did not come up');

  // -------------------------------------------------------------------------
  // Step 3: drive it.
  // -------------------------------------------------------------------------
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/preview.html`);
  await page.waitForSelector('.shell-strip__handle', { timeout: 15_000 });
  await page.click('.shell-strip__handle'); // BRIEF.md "Under the bar": the rail opens on click
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
    const src = items.find((el) => el.textContent?.includes('sketch-device'));
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

  // Select it at the faceplate stop.
  await page.click('.react-flow__node-chassis');
  await page.waitForSelector('.drawing-editor__panel', { timeout: 10_000 });

  // A sketch device has no faceplate ports until typed by hand (UI-SPEC
  // "Inside a box": "guess neither"). Type the one the paste below will
  // name, so the drawer's own "click a line and the port it built lights"
  // (UI-SPEC "Config") has a real port to try to light.
  await page.locator('.drawing-editor__panel button', { hasText: '+ add a port' }).click();
  await page.locator('.drawing-editor__panel').getByPlaceholder('label').fill('ge-0/0/0');
  await page.locator('.drawing-editor__panel button', { hasText: 'add' }).last().click();
  await page.waitForTimeout(300);
  check('the ge-0/0/0 port typed onto the faceplate', (await page.locator('.drawing-editor__panel').innerText()).includes('ge-0/0/0'));

  // Zoom to the faceplate stop (`geometry.ts`'s `CAMERA_STOPS.faceplate === 200`)
  // — this harness's own zoom control, exposed because the shipped bar
  // steps by 10 and this is a proof script, not a person's scroll wheel.
  await page.evaluate(() => window.__setPreviewZoom__?.(200));
  await page.waitForSelector('.config-drawer', { timeout: 10_000 });
  check('the config drawer opened at the faceplate stop', (await page.locator('.config-drawer').count()) === 1);

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
  // `document/capture.ts`'s `builtSpans` now compares `Origin::Parsed.capture`
  // (the wire's bare ULID) against the capture node's own bare ULID
  // (`parseNodeId(node.id).ulid`), not its formatted `capture:<ulid>` node
  // id — fixed; asserted here against the real engine and the real
  // component, not only in `capture.test.ts`'s own hand-built fixtures.
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

  await page.screenshot({ path: SHOTS + 's6f-drawer.png' });
  console.log('    wrote ' + SHOTS + 's6f-drawer.png');

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
  await page.screenshot({ path: SHOTS + 's6f-lit.png' });
  console.log('    wrote ' + SHOTS + 's6f-lit.png');

  // -------------------------------------------------------------------------
  // The inside stop, same device, same camera (Motion #10).
  // -------------------------------------------------------------------------
  await page.evaluate(() => window.__setPreviewZoom__?.(300));
  await page.waitForSelector('.drawing-inside-stop', { timeout: 10_000 });
  check('the inside stop opened for the same device', (await page.locator('.drawing-inside-stop').count()) === 1);
  const insideText = await page.locator('.drawing-inside-stop').innerText();
  check('the inside stop names the pasted hostname', insideText.includes('srx-branch-01'));
  check('the inside stop shows the built interface', insideText.includes('ge-0/0/0'));
  await page.screenshot({ path: SHOTS + 's6f-inside.png' });
  console.log('    wrote ' + SHOTS + 's6f-inside.png');

  // Back to the faceplate stop for the second paste attempt.
  await page.evaluate(() => window.__setPreviewZoom__?.(200));
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

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // -------------------------------------------------------------------------
  // The read-only view. No real server means no real second account to sign
  // in as — this harness's own `?readonly=1` sets `capability: 'read'`
  // directly, the one input `RacksPlace`'s own `canDrawFor` (ADR-0052 §5)
  // reads. A fresh page load (a fresh design, no device placed in it) —
  // the point is "no write capability was ever exercised", which an empty
  // read-only design shows exactly as well as a populated one would.
  // -------------------------------------------------------------------------
  const roPage = await context.newPage();
  const roRequests = [];
  await roPage.goto(`${BASE}/preview.html?readonly=1`);
  await roPage.waitForTimeout(1500);
  const roReqs = await roPage.evaluate(() => window.__requests__);
  const roSaves = roReqs.filter((r) => r.method === 'POST' && r.url.includes('/versions'));
  const roInputs = await roPage.locator('input, textarea').count();
  check('read-only: "View only" is shown', (await roPage.locator('body').innerText()).includes('View only'));
  check('read-only: zero save (version) POSTs', roSaves.length === 0, `${roReqs.length} total requests`);
  check('read-only: zero inputs or textareas in the DOM', roInputs === 0, `${roInputs} found`);
  await roPage.screenshot({ path: SHOTS + 's6f-readonly.png' });
  console.log('    wrote ' + SHOTS + 's6f-readonly.png');
  await roPage.close();

  await browser.close();
  browser = null;
} finally {
  // -------------------------------------------------------------------------
  // Cleanup — every step, even on failure.
  // -------------------------------------------------------------------------
  if (browser) await browser.close().catch(() => {});
  if (viteProc) {
    viteProc.kill();
    try { execFileSync('fuser', ['-k', `${PORT}/tcp`]); } catch { /* nothing was listening */ }
  }
  for (const f of [PREVIEW_HTML, PREVIEW_TSX]) {
    if (existsSync(f)) rmSync(f);
  }
  check('preview.html removed', !existsSync(PREVIEW_HTML));
  check('preview.tsx removed', !existsSync(PREVIEW_TSX));
}

console.log(fails.length ? '\nFAILURES:\n  ' + fails.join('\n  ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
