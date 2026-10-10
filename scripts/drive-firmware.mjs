// Drives the firmware screens (ADR-0064, mockups design/r14-firmware/r14-b1..b3) on the real App over the `firmware`
// scene: Inventory > Firmware (list, vendor tabs, an image, Upload image), Inventory > Models > a model (chosen
// version, Hold, Release), the device editor's firmware group, right-click > Plan a firmware upgrade and the plan
// panel (steps, Copy command, the one-time link), "Plan an upgrade for them", firmware off, a reader, dark mode and
// phone width, and the Checks panel's "behind" finding. The firmware server routes are stubbed in the page with
// Playwright route interception, with the `commands` shape of crates/fathom-server/src/firmware_commands.rs.
// Usage: bash scripts/build-wasm.sh (once), then node scripts/drive-firmware.mjs.
// Overrides: FATHOM_ROOT, PW_CHROMIUM, PW_PLAYWRIGHT, FATHOM_SHOTS.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------------------------------------------
// The stubbed server. Image ids and hashes match `seedFirmwareScene` in drive-lib/seed.ts.
const ORG = 'org-drive';
const SCOPE = 'scope-drive';
const fwId = (n) => `01K8FW${String(n).padStart(20, '0')}`;
const SHA = {
  1: '9f2c4b7d1e8a3055c6d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3a41e',
  2: '17be6a02c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c03d9',
  3: '44d1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3b2f0',
  4: 'e83a5f4e3d2c1b0a99887766554433221100ffeeddccbbaa99887766554f5c6b',
  5: '2b70c9d8e7f6a5b4c3d2e1f0091827364554637281900a1b2c3d4e5f6a7b91aa',
};
const FETCH_URL = 'https://fathom.example/fw/fetch/Zk3Jq9XvT2mP7sLw4NcR8tYb';

const INSTALL_NOTE = "ADR-0045 §4.4: Fathom stages and verifies and never installs. This line is here so you can copy it, not so that anything runs it.";
// The step lists, as firmware_commands.rs writes them (titles and commands verbatim; notes shortened).
function stepsFor(family, filename, src) {
  const mk = (list) => list.map(([step, command, note], i) => ({ order: i + 1, step, command, note, run_by: 'operator' }));
  if (family === 'junos') {
    const p = `/var/tmp/${filename}`;
    return mk([
      ['check space first', 'show system storage', '/var is the partition that fills.'],
      ['make room BEFORE the copy', 'request system storage cleanup', 'TRAP 1: cleanup can delete the image you just copied. Run it before the copy, never after.'],
      ['take the first snapshot', 'request system snapshot', 'Copies the running system to alternate media.'],
      ['have the device pull the image', `file copy ${src} /var/tmp/`, 'The device uses its own transfer stack, so the SCP-versus-SFTP question does not arise.'],
      ['prove the whole file arrived', `file checksum sha-256 ${p}`, 'TRAP 2, and the reason this feature exists. The answer must equal the expected_sha256 in this response.'],
      ['prove Juniper made it', `request system software validate ${p}`, 'Checks the vendor signature against a Juniper root certificate.'],
      ['install -- yours to run, not Fathom\'s', `request system software add ${p}`, INSTALL_NOTE],
      ['and the second snapshot, after it comes back', 'request system snapshot', 'TRAP 5: skip this and the alternate boot media stays out of step with the primary.'],
    ]);
  }
  if (family === 'ios-xe') {
    return mk([
      ['check space first', 'dir bootflash:', "Cisco's Catalyst 9300 guide asks for 1 GB to 1.5 GB free for the image to expand."],
      ['make room BEFORE the copy', 'install remove inactive', 'Install mode (IOS XE 16.6.2 and later).'],
      ['have the device pull the image', `copy ${src} bootflash:${filename}`, "Cisco's HTTPS client page documents copy https://<url> <destination>."],
      ['prove the whole file arrived', `verify /sha512 bootflash:${filename}`, 'IOS XE\'s verify takes /md5 or /sha512. This output is NOT comparable with expected_sha256: compare it with the SHA-512 Cisco shows for this file.'],
      ['check Cisco signed it', `show software authenticity file bootflash:${filename}`, 'Shows the signer and image type from the file\'s signature.'],
      ['install -- yours to run, not Fathom\'s', `install add file bootflash:${filename} activate commit`, INSTALL_NOTE],
      ['check after it comes back', 'show version', 'Confirm the version is the release you meant.'],
    ]);
  }
  if (family === 'nx-os') {
    return mk([
      ['check space first', 'dir bootflash:', 'Read 2026-10-10.'],
      ['have the device pull the image', `copy ${src} bootflash:${filename} vrf management`, ''],
      ['prove the whole file arrived', `show file bootflash:${filename} sha256sum`, ''],
      ['install -- yours to run, not Fathom\'s', `install all nxos bootflash:${filename}`, INSTALL_NOTE],
    ]);
  }
  return mk([
    ['check space first', 'dir flash:', ''],
    ['have the device pull the image', `copy ${src} flash:/${filename}`, ''],
    ['prove the whole file arrived', `bash sha256sum /mnt/flash/${filename}`, ''],
    ['point the switch at it -- yours to run, not Fathom\'s', `boot system flash:/${filename}`, INSTALL_NOTE],
    ['reload -- yours to run, not Fathom\'s', 'reload', INSTALL_NOTE],
  ]);
}
const NOT_ESTABLISHED = {
  junos: ['whether Junos verifies TLS certificates on an https:// source', 'whether Juniper publishes SHA-256 or a detached signature beside images today'],
  'ios-xe': ['an on-device SHA-256 command on IOS XE (verify offers /md5 and /sha512)', 'whether the HTTPS copy validates the server certificate chain', 'a rollback command, from the pages read'],
  'nx-os': ['that copy accepts an https:// source on every NX-OS release', 'a rollback command, from the pages read'],
  eos: ["that copy accepts an https:// source (Arista's page lists http, ftp, scp, usb)", 'a rollback command, from the pages read'],
};
function commandsFor(platform, filename, sha, url) {
  const family = platform === null || platform.startsWith('junos') ? 'junos' : platform;
  const ios = family === 'ios-xe';
  return {
    expected_sha256: sha,
    platform,
    family,
    device_path: family === 'junos' ? `/var/tmp/${filename}` : ios ? `bootflash:${filename}` : family === 'eos' ? `flash:/${filename}` : `bootflash:${filename}`,
    steps: stepsFor(family, filename, url ?? '<the fetch URL, from POST .../fetch-urls: Fathom keeps only its hash and cannot show you one it already issued>'),
    device_hash: ios ? { algorithm: 'sha512', compares_with: 'vendor_published_sha512' } : { algorithm: 'sha256', compares_with: 'expected_sha256' },
    sourced: family === 'junos' ? 'summary' : 'vendor_docs',
    sourced_note: family === 'junos'
      ? 'juniper.net was unreachable when these were researched (2026-09-14), so these are search summaries describing Juniper\'s documentation rather than verbatim reads of it.'
      : 'Read on 2026-10-10: the vendor\'s own upgrade guide for the platform.',
    could_not_establish: NOT_ESTABLISHED[family] ?? [],
    fathom_runs_none_of_these: true,
  };
}
const NOW = Math.floor(Date.now() / 1000);
function image(n, filename, bytes, platform, version, models) {
  return {
    image_id: fwId(n), filename, byte_length: bytes, state: 'staged', failed_reason: null,
    created_at_unix: NOW - 86400 * (7 - n), staged_at_unix: NOW - 86400 * (7 - n) + 600, sha256: SHA[n],
    platform, version, models, commands: commandsFor(platform, filename, SHA[n], null),
  };
}
const freshImages = () => [
  image(1, 'junos-arm-32-23.4R2.tgz', 418_000_000, 'junos-ex', '23.4R2', ['EX2300-24P', 'EX2300-48P']),
  image(2, 'junos-arm-32-21.4R3-S5.tgz', 392_000_000, 'junos-ex', '21.4R3-S5', ['EX2300-24P']),
  image(3, 'cat9k_iosxe.17.09.04.SPA.bin', 1_187_000_000, 'ios-xe', '17.9.4', ['C9300-48P']),
  image(4, 'nxos64-cs.10.4.3.F.bin', 1_920_000_000, 'nx-os', '10.4.3', ['N9K-C93180YC-FX']),
  image(5, 'EOS64-4.30.2F.swi', 905_000_000, 'eos', '4.30.2F', ['DCS-7050SX3-48YC8']),
];

/** Installs the stub on a page. `mode`: 'on' serves the list; 'off' answers the bare 404 a server without firmware gives. */
async function stub(page, { mode = 'on', steward = true } = {}) {
  const state = { images: freshImages(), declared: [], uploads: 0, links: 0, modelsPuts: [] };
  const reply = (route, status, obj) => route.fulfill({ status, contentType: 'application/json', body: obj === undefined ? '' : JSON.stringify(obj) });
  await page.route(/\/(organisations\/[^/]+\/scopes\/[^/]+\/firmware|organisations\/[^/]+\/firmware\/.*|firmware-upload\/.*)$/, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (mode === 'off') return reply(route, 404);
    if (path.endsWith(`/scopes/${SCOPE}/firmware`)) {
      if (method === 'GET') return reply(route, 200, state.images);
      if (method === 'POST') {
        if (!steward) return route.fulfill({ status: 403, body: 'only a steward can do this\n' });
        const id = fwId(40 + state.declared.length);
        state.declared.push({ id, body: req.postDataBuffer()?.toString('latin1') ?? '' });
        return reply(route, 200, { image_id: id, upload_path: `/firmware-upload/${id}`, upload_token: 'tok-single-use', upload_token_header: 'fathom-firmware-upload-token', upload_token_expires_at_unix: NOW + 900 });
      }
    }
    if (path.startsWith('/firmware-upload/') && method === 'POST') {
      const id = path.split('/').pop();
      state.uploads += 1;
      const n = 40 + state.uploads - 1;
      SHA[n] = SHA[n] ?? 'a'.repeat(63) + 'b';
      const img = image(1, 'uploaded.tgz', 4096, 'junos-ex', '23.4R2-S1', ['EX2300-24P']);
      img.image_id = id; img.sha256 = SHA[n]; img.commands = commandsFor('junos-ex', 'uploaded.tgz', SHA[n], null);
      state.images.push(img);
      return reply(route, 200, img);
    }
    const models = /\/firmware\/([^/]+)\/models$/.exec(path);
    if (models && method === 'PUT') {
      const sent = JSON.parse(req.postDataBuffer()?.toString('utf8') ?? '{}');
      state.modelsPuts.push(sent);
      const hit = state.images.find((i) => i.image_id === models[1]);
      if (hit) hit.models = sent.models;
      return reply(route, 200, { image_id: models[1], models: sent.models, changed: true, changed_seq: 9 });
    }
    const fetchUrl = /\/firmware\/([^/]+)\/fetch-urls$/.exec(path);
    if (fetchUrl && method === 'POST') {
      if (!steward) return route.fulfill({ status: 403, body: 'only a steward can do this\n' });
      const hit = state.images.find((i) => i.image_id === fetchUrl[1]);
      if (!hit) return route.fulfill({ status: 404, body: 'no such image\n' });
      state.links += 1;
      return reply(route, 200, {
        image_id: hit.image_id, filename: hit.filename, sha256: hit.sha256, fetch_url: FETCH_URL,
        fetch_url_expires_at_unix: NOW + 900, commands: commandsFor(hit.platform, hit.filename, hit.sha256, FETCH_URL),
      });
    }
    return route.fulfill({ status: 404, body: 'not stubbed\n' });
  });
  return state;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 0: the wasm artefact.
const WASM_ARTIFACT = CLIENT + '/public/engine/fathom_wasm.wasm';
if (!existsSync(WASM_ARTIFACT)) {
  console.log('==> building the wasm artefact (missing): bash scripts/build-wasm.sh');
  execFileSync('bash', [ROOT + '/scripts/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
check('the wasm artefact exists', existsSync(WASM_ARTIFACT), WASM_ARTIFACT);

// Step 1: copy the shared throwaway harness into `client/`. The catalogue gains the models this scene names that the
// shared fixture lacks (EX2300-24P as the 48P's front ports cut to 24, a Cisco C9300-48P shaped like a 48-port switch).
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
{
  const cat = JSON.parse(readFileSync(DRIVE_LIB + '/catalogue.json', 'utf8'));
  const clone = (from, vendor, model) => {
    const m = JSON.parse(JSON.stringify(cat.models[from]));
    m.model = model;
    m.vendor = vendor;
    cat.models[`${vendor}/${model}`] = m;
    cat.list.push({ model, rack_units: m.rack_units, vendor });
    return m;
  };
  const ex24 = clone('juniper/EX2300-48P', 'juniper', 'EX2300-24P');
  for (const f of ex24.faceplates) {
    f.ports = f.ports.filter((p) => !(String(p.kind).toUpperCase() === 'RJ45' && p.number >= 24 && p.role === 'access'));
    f.port_count = f.ports.length;
  }
  clone('ubiquiti/USW-48-PoE', 'cisco', 'C9300-48P');
  writeFileSync(PREVIEW_CATALOGUE, JSON.stringify(cat));
}
check('drive harness files written', [PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE].every(existsSync));

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

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const shot = async (page, name, opts = {}) => {
    await page.screenshot({ path: SHOTS + 'fw-' + name + '.png', ...opts });
    console.log('    wrote ' + SHOTS + 'fw-' + name + '.png');
  };
  async function open({ w = 1400, h = 900, dark = false, read = false, mode = 'on', steward = true, scene = 'firmware' } = {}) {
    const context = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const server = await stub(page, { mode, steward: steward && !read });
    await page.goto(`${BASE}/drive.html?scene=${scene}${read ? '&capability=read' : ''}`);
    await page.waitForSelector('.react-flow__pane', { timeout: 15_000 });
    await page.waitForTimeout(1500);
    return { context, page, pageErrors, server };
  }
  const T = (page, id) => page.locator(`[data-testid=${id}]`);
  const settle = (page, ms = 600) => page.waitForTimeout(ms);
  const goKind = async (page, kind) => {
    if (!(await page.locator('.inventory-place').count())) await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await settle(page, 500);
    const btn = page.getByRole('button', { name: new RegExp(`^${kind}\\b`) }).first();
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else {
      // A phone has no kinds sidebar on screen: go by the address, as a link would.
      console.log(`    (no ${kind} button on screen at this width; going by the address)`);
      await page.evaluate((k) => { location.hash = `inventory?k=${k}`; }, kind.toLowerCase());
    }
    await settle(page, 700);
  };
  const openModelRow = (page, model) => page.locator('.inv-table__row', { hasText: model }).getByText(model, { exact: true }).first().click();
  const noOverflow = (page, sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    return e && e.scrollWidth > e.clientWidth + 1 ? `${e.scrollWidth}>${e.clientWidth}` : '';
  }, sel);
  const rowTexts = (page) => T(page, 'firmware-row').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  const openChecks = async (page) => {
    if ((await T(page, 'checks-panel').count()) === 0) await T(page, 'checks-chip').click();
    await page.waitForSelector('[data-testid=checks-panel]', { timeout: 8_000 });
    await settle(page, 800);
    return (await T(page, 'checks-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
  };

  // ---------------------------------------------------------------- 1. the list, tabs, an image, upload (light, desktop)
  {
    const { context, page, pageErrors, server } = await open();
    await goKind(page, 'Firmware');
    await T(page, 'firmware-list').waitFor({ timeout: 8_000 });
    await settle(page, 600);
    const rows = await rowTexts(page);
    check('[list] one row per staged image', rows.length === 5, String(rows.length));
    check('[list] 23.4R2 row names both models, is Chosen', /23\.4R2.*EX2300-24P, EX2300-48P.*Chosen/i.test(rows.find((r) => r.startsWith('23.4R2')) ?? ''), rows[0]);
    check('[list] 21.4R3-S5 is Older, 10.4.3 is Staged', /Older/i.test(rows.find((r) => r.startsWith('21.4R3-S5')) ?? '') && /Staged/i.test(rows.find((r) => r.startsWith('10.4.3')) ?? ''), rows.join(' | '));
    const foot = (await page.locator('.fw-foot').innerText()).replace(/\s+/g, ' ');
    check('[list] the footer counts the devices behind', /\d+ devices are behind their model.s chosen version/.test(foot), foot);
    check('[list] the list does not overflow sideways', (await noOverflow(page, '[data-testid=firmware-list]')) === '', await noOverflow(page, '[data-testid=firmware-list]'));
    await shot(page, '1-list');

    // Vendor tabs.
    await page.getByRole('button', { name: 'Cisco', exact: true }).click();
    await settle(page, 300);
    const cisco = await rowTexts(page);
    check('[tabs] Cisco shows the IOS XE and NX-OS images only', cisco.length === 2 && cisco.every((r) => /17\.9\.4|10\.4\.3/.test(r)), cisco.join(' | '));
    await shot(page, '2-vendor-cisco');
    await page.getByRole('button', { name: 'Arista', exact: true }).click();
    check('[tabs] Arista shows one image', (await rowTexts(page)).length === 1);
    await page.getByRole('button', { name: 'Juniper', exact: true }).click();
    check('[tabs] Juniper shows two images', (await rowTexts(page)).length === 2);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByLabel('Filter images').fill('nx');
    await settle(page, 300);
    check('[tabs] the filter box narrows by text', (await rowTexts(page)).length === 1);
    await page.getByLabel('Filter images').fill('');

    // Behind number opens the Devices list filtered.
    const behindBtn = page.getByRole('button', { name: /devices behind/ }).first();
    check('[list] the Behind number is a button', (await behindBtn.count()) === 1);

    // Open an image.
    await page.getByRole('button', { name: '23.4R2', exact: true }).click();
    await T(page, 'firmware-image').waitFor({ timeout: 5_000 });
    await settle(page, 500);
    const img = (await T(page, 'firmware-image').innerText()).replace(/\s+/g, ' ');
    check('[image] the page shows file, SHA-256, models, running, behind', /junos-arm-32-23\.4R2\.tgz/.test(img) && new RegExp(SHA[1]).test(img) && /EX2300-24P/.test(img) && /Running/.test(img) && /Behind/.test(img), img.slice(0, 260));
    await shot(page, '3-image');
    await T(page, 'firmware-image').getByRole('button', { name: 'Get a one-time link' }).click();
    await T(page, 'fw-link').waitFor({ timeout: 5_000 });
    await settle(page, 300);
    const linkText = (await T(page, 'fw-link').innerText()).replace(/\s+/g, ' ');
    check('[image] a link is shown masked, with its expiry and SHA-256', /fathom\.example\/fw\/fetch\//.test(linkText) && !linkText.includes('Zk3Jq9XvT2mP7sLw4NcR8tYb') && /file copy https:\/\/fathom\.example\/fw\/fetch\/•+ \/var\/tmp\//.test(linkText) && /Works once/.test(linkText) && linkText.includes(SHA[1]), linkText);
    await shot(page, '3b-image-link');
    await page.getByRole('button', { name: 'Back', exact: false }).first().click().catch(() => {});

    // Upload image.
    await goKind(page, 'Firmware');
    await page.getByRole('button', { name: /Upload image/ }).click();
    await T(page, 'firmware-upload').waitFor({ timeout: 5_000 });
    await settle(page, 400);
    await shot(page, '4-upload-empty');
    await page.setInputFiles('#fw-file', { name: 'junos-arm-32-23.4R2-S1.tgz', mimeType: 'application/gzip', buffer: Buffer.alloc(4096, 7) });
    await page.selectOption('#fw-platform', 'junos-ex');
    await page.fill('#fw-version', '23.4R2-S1');
    await page.fill('#fw-sha', 'SHA256: ' + SHA[1].toUpperCase());
    await page.getByLabel('EX2300-24P', { exact: true }).check();
    await settle(page, 300);
    check('[upload] Upload is off before a file, on after', !(await page.getByRole('button', { name: 'Upload', exact: true }).isDisabled()));
    await shot(page, '4-upload-filled');
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await T(page, 'firmware-list').waitFor({ timeout: 8_000 });
    await settle(page, 800);
    check('[upload] the declaration was sent and the bytes after it', server.declared.length === 1 && server.uploads === 1, `${server.declared.length} declared, ${server.uploads} uploads`);
    check('[upload] the declaration names the models and version', /23\.4R2-S1/.test(server.declared[0]?.body ?? '') && /EX2300-24P/.test(server.declared[0]?.body ?? ''));
    const listed = await rowTexts(page);
    check('[upload] it goes back to the list with the new image as a Staged row', listed.length === 6 && /23\.4R2-S1.*STAGED/.test(listed.join('|')), listed.join(' | '));
    await shot(page, '4b-upload-done');
    check('[upload] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 2. a model page: chosen version, Hold, Release
  {
    const { context, page, pageErrors } = await open();
    await goKind(page, 'Models');
    await settle(page, 600);
    await shot(page, '5a-models-table');
    await openModelRow(page, 'EX2300-24P');
    await T(page, 'firmware-model').waitFor({ timeout: 8_000 });
    await settle(page, 500);
    const head = (await T(page, 'firmware-model').locator('h2').innerText()).replace(/\s+/g, ' ');
    check('[model] the heading names the model, vendor, platform and device count', /EX2300-24P\s+Juniper . Junos . 6 devices/.test(head), head);
    const devs = await T(page, 'firmware-device').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    check('[model] a row per device with its state', devs.length === 6 && /switch-2.*23\.4R2.*On chosen/.test(devs.join('|')) && /switch-1.*21\.4R3-S5.*Behind/.test(devs.join('|')) && /switch-5.*Held.*Lab rig/.test(devs.join('|')) && /switch-6.*unknown.*No version yet/.test(devs.join('|')), devs.join(' | '));
    check('[model] the model page does not overflow sideways', (await noOverflow(page, '[data-testid=firmware-model]')) === '');
    await shot(page, '5-model');

    // Change the chosen version, then back.
    const sel = page.locator('#fw-chosen');
    const opts = await sel.locator('option').allInnerTexts();
    check('[model] the select offers the staged versions for this model', opts.includes('23.4R2') && opts.includes('21.4R3-S5') && opts.some((o) => /Type a version/.test(o)), opts.join(' | '));
    await sel.selectOption({ label: '21.4R3-S5' });
    await settle(page, 600);
    const after = await T(page, 'firmware-device').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    check('[model] choosing 21.4R3-S5 moves switch-2 behind-less: it is now ahead (on chosen or newer), the others on chosen', /switch-1.*On chosen/.test(after.join('|')), after.join(' | '));
    await shot(page, '5b-model-changed');
    await sel.selectOption({ label: '23.4R2' });
    await settle(page, 600);
    check('[model] choosing 23.4R2 again brings the three behind back', (await T(page, 'firmware-device').evaluateAll((els) => els.filter((e) => /Behind/.test(e.innerText)).length)) === 3);

    // Type a version.
    await sel.selectOption({ label: 'Type a version…' });
    await page.getByLabel('Version', { exact: true }).fill('23.4R3');
    await shot(page, '5c-model-type-version');
    await page.getByLabel('Version', { exact: true }).fill('');
    await sel.selectOption({ label: '23.4R2' });
    await settle(page, 400);

    // Hold with a reason, Release.
    const row1 = T(page, 'firmware-device').filter({ hasText: 'switch-1' });
    await row1.getByRole('button', { name: 'Hold' }).click();
    await settle(page, 300);
    await shot(page, '6-hold-form');
    await row1.getByRole('button', { name: 'Hold', exact: true }).click();
    await settle(page, 300);
    check('[hold] a hold with no reason is refused in words', /Say why it is held/.test(await T(page, 'firmware-model').innerText()));
    await row1.getByLabel('Why it is held').fill('Waiting on the vendor for a fix');
    await row1.getByRole('button', { name: 'Hold', exact: true }).click();
    await settle(page, 600);
    const held1 = (await row1.innerText()).replace(/\s+/g, ' ');
    check('[hold] switch-1 shows Held with the reason and a Release', /Held.*Waiting on the vendor/.test(held1) && /Release/i.test(held1), held1);
    await shot(page, '7-held');
    await row1.getByRole('button', { name: 'Release' }).click();
    await settle(page, 600);
    check('[hold] Release puts it back to Behind', /Behind/.test(await row1.innerText()));
    check('[model] foot says three devices are behind and offers the plan', /3 devices are behind the chosen version/.test(await page.locator('.fw-foot').innerText()));
    check('[model] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 3. the canvas: editor group, right-click, plan panel, Checks
  {
    const { context, page, pageErrors, server } = await open();
    const node = (host) => page.locator('.react-flow__node-chassis', { hasText: host });
    // The Checks panel: behind for switch-1/3/4, none for the held switch-5.
    const rows = await openChecks(page);
    const behindRows = rows.filter((r) => /firmware|behind/i.test(r));
    console.log('    checks rows: ' + JSON.stringify(rows));
    check('[checks] there is a finding about firmware being behind', behindRows.length >= 1, rows.join(' | '));
    const text = behindRows.join(' | ');
    check('[checks] it names switch-1, switch-3 and switch-4', /switch-1/.test(text) && /switch-3/.test(text) && /switch-4/.test(text), text);
    check('[checks] it does not name the held switch-5', !/switch-5/.test(text), text);
    check('[checks] nor the up-to-date switch-2 or switch-7', !/switch-2/.test(text) && !/switch-7/.test(text), text);
    await shot(page, '8-checks');
    await page.getByRole('button', { name: 'Fold' }).first().click();
    await settle(page, 300);

    // The device editor's firmware group.
    await node('switch-1').click();
    await T(page, 'firmware-section').waitFor({ timeout: 8_000 });
    await settle(page, 600);
    const fs = (await T(page, 'firmware-section').innerText()).replace(/\s+/g, ' ');
    check('[editor] the group shows Running, Chosen, State and Hold', /Running 21\.4R3-S5/i.test(fs) && /Chosen for EX2300-24P 23\.4R2/i.test(fs) && /State Behind/i.test(fs) && /Hold/i.test(fs), fs);
    await T(page, 'firmware-section').scrollIntoViewIfNeeded();
    await shot(page, '9-editor-firmware');
    await T(page, 'firmware-section').getByRole('button', { name: 'Hold', exact: true }).click();
    await page.getByLabel('Why it is held').fill('Change freeze until Friday');
    await shot(page, '9b-editor-hold-form');
    await T(page, 'firmware-section').getByRole('button', { name: 'Hold', exact: true }).last().click();
    await settle(page, 600);
    check('[editor] a hold in the editor shows the reason and Release', /Change freeze until Friday/.test(await T(page, 'firmware-section').innerText()));
    await T(page, 'firmware-section').getByRole('button', { name: 'Release' }).click();
    await settle(page, 500);
    check('[editor] Release lifts it', /not held|Hold/i.test(await T(page, 'firmware-section').innerText()) && !/Change freeze/.test(await T(page, 'firmware-section').innerText()));
    await page.keyboard.press('Escape');
    await page.locator('.react-flow__pane').click({ position: { x: 30, y: 600 } }).catch(() => {});
    await settle(page, 400);

    // Right-click > Plan a firmware upgrade.
    await node('switch-1').click({ button: 'right' });
    await settle(page, 400);
    const items = await page.locator('.drawing-context-menu__item').allInnerTexts();
    check('[menu] the right-click menu offers Plan a firmware upgrade', items.some((t) => /Plan a firmware upgrade/.test(t)), items.join(' | '));
    await shot(page, '10-context-menu');
    await page.locator('.drawing-context-menu__item', { hasText: 'Plan a firmware upgrade' }).click();
    await page.waitForSelector('[data-testid=plans-panel]', { timeout: 10_000 });
    await settle(page, 1200);
    const band = (await T(page, 'plans-band').innerText()).replace(/\s+/g, ' ');
    check('[plan] the plan is titled "Upgrade EX2300-24P to 23.4R2"', /Upgrade EX2300-24P to 23\.4R2/.test(band), band.slice(0, 200));
    const stepCount = await T(page, 'plans-step').count();
    check('[plan] one step per documented step (8 for Junos)', stepCount >= 6, String(stepCount));
    const devText = (await T(page, 'plans-firmware').innerText()).replace(/\s+/g, ' ');
    check('[plan] right-click plans for the one device: running -> target', /Devices . 1/i.test(devText) && /switch-1.*21\.4R3-S5 . 23\.4R2/.test(devText), devText.slice(0, 220));
    await shot(page, '11-plan');

    await page.getByRole('button', { name: 'Start work' }).click();
    await settle(page, 700);
    await shot(page, '12-plan-doing');
    // Walk to the fetch step: mark done until the current step says "pull the image".
    for (let i = 0; i < 8; i += 1) {
      const curEl = page.locator('[data-testid=plans-step][data-state=current]');
      if ((await curEl.count()) === 0) { console.log('    no current step; panel: ' + (await T(page, 'plans-panel').innerText()).replace(/\s+/g, ' ').slice(0, 500)); break; }
      const cur = (await curEl.innerText()).replace(/\s+/g, ' ');
      if (/Fetch the image/i.test(cur)) break;
      await page.getByRole('button', { name: 'Mark done' }).click();
      await settle(page, 500);
    }
    const current = page.locator('[data-testid=plans-step][data-state=current]');
    check('[plan] the open step is the fetch step', /Fetch the image/i.test(await current.innerText()), await current.innerText());
    await current.scrollIntoViewIfNeeded();
    await shot(page, '13-plan-fetch-step');
    await current.getByRole('button', { name: 'Copy command' }).click();
    await settle(page, 600);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('[plan] Copy command puts the command with the one-time link on the clipboard', /file copy https:\/\/fathom\.example\/fw\/fetch\/Zk3Jq9XvT2mP7sLw4NcR8tYb \/var\/tmp\//.test(clip), clip);
    check('[plan] that asked the server for one link', server.links === 1, String(server.links));
    check('[plan] the one-time link box now shows, masked', /fathom\.example\/fw\/fetch\//.test(await T(page, 'plans-firmware').innerText()) && !(await T(page, 'plans-firmware').innerText()).includes('Zk3Jq9XvT2mP7sLw4NcR8tYb'));
    await T(page, 'plans-firmware').scrollIntoViewIfNeeded();
    await shot(page, '14-plan-link');
    await T(page, 'plans-firmware').getByRole('button', { name: 'Copy link' }).click();
    await settle(page, 400);
    check('[plan] Copy link copies the whole url', (await page.evaluate(() => navigator.clipboard.readText())) === FETCH_URL);
    const planBody = (await T(page, 'plans-panel').innerText()).replace(/\s+/g, ' ');
    check('[plan] "Not established" lines from the server are shown', /Not established: whether Junos verifies TLS/.test(planBody), planBody.slice(-300));
    const saved = await page.evaluate(() => window.__requests__.filter((r) => r.method === 'POST' && /versions/.test(r.url)).map((r) => r.bodyLatin1));
    check('[gate] the one-time link is never written to the design', saved.length > 0 && saved.every((b) => !b.includes('Zk3Jq9XvT2mP7sLw4NcR8tYb')), `${saved.length} saves`);
    check('[plan] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 4. "Plan an upgrade for them", the pick when two models are behind
  {
    const { context, page, pageErrors } = await open();
    await goKind(page, 'Firmware');
    await page.getByRole('button', { name: 'Plan an upgrade for them' }).click();
    await settle(page, 300);
    const pick = await page.locator('.fw-pop [role=menuitem]').allInnerTexts();
    check('[them] two models are behind, so it asks which', pick.length === 2 && pick.some((t) => /EX2300-24P . 3/.test(t)) && pick.some((t) => /C9300-48P . 1/.test(t)), pick.join(' | '));
    await shot(page, '15a-plan-for-them-pick');
    await page.locator('.fw-pop').getByRole('menuitem', { name: /EX2300-24P/ }).click();
    await page.waitForSelector('[data-testid=plans-panel]', { timeout: 10_000 });
    await settle(page, 1200);
    const band = ((await T(page, 'plans-band').innerText()) + ' ' + (await T(page, 'plans-panel').innerText())).replace(/\s+/g, ' ');
    check('[them] choosing the model makes the plan for its three devices', /Upgrade EX2300-24P to 23\.4R2/.test(band) && /Devices . 3/i.test(band), band.slice(0, 160));
    await shot(page, '15-plan-for-them');
    check('[them] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 5. firmware off
  {
    const { context, page, pageErrors } = await open({ mode: 'off' });
    await goKind(page, 'Firmware');
    await settle(page, 700);
    const note = (await T(page, 'firmware-list').innerText()).replace(/\s+/g, ' ');
    check('[off] the list says firmware is off and how to turn it on', /Firmware is off on this server\. Set FATHOM_FIRMWARE_FETCH_BASE_URL/.test(note), note.slice(0, 200));
    check('[off] versions typed on a model page still show as rows', (await rowTexts(page)).length >= 1, (await rowTexts(page)).join(' | '));
    check('[off] there is no Upload image button', (await page.getByRole('button', { name: /Upload image/ }).count()) === 0);
    await shot(page, '16-off');
    check('[off] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 6. a reader: sees all, changes nothing
  {
    const { context, page, pageErrors } = await open({ read: true });
    await goKind(page, 'Firmware');
    await settle(page, 600);
    check('[read] the list shows its rows', (await rowTexts(page)).length === 5);
    check('[read] no Upload image, no Plan an upgrade', (await page.getByRole('button', { name: /Upload image/ }).count()) === 0 && (await page.getByRole('button', { name: 'Plan an upgrade for them' }).count()) === 0);
    await shot(page, '17-reader-list');
    await goKind(page, 'Models');
    await openModelRow(page, 'EX2300-24P');
    await T(page, 'firmware-model').waitFor({ timeout: 8_000 });
    await settle(page, 400);
    check('[read] the model page has no select, no Hold, no Release, no Plan', (await page.locator('#fw-chosen').count()) === 0 && (await T(page, 'firmware-model').getByRole('button', { name: /^(Hold|Release|Plan)/ }).count()) === 0);
    check('[read] it still shows the chosen version as text', /23\.4R2/.test(await T(page, 'firmware-model').innerText()));
    await shot(page, '18-reader-model');
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await settle(page, 800);
    const node = page.locator('.react-flow__node-chassis', { hasText: 'switch-1' });
    if (await node.count()) {
      await node.click({ button: 'right' });
      await settle(page, 300);
      const items = await page.locator('.drawing-context-menu__item').allInnerTexts();
      check('[read] the right-click menu does not offer a firmware plan', !items.some((t) => /firmware/i.test(t)), items.join(' | '));
      await page.keyboard.press('Escape');
      await node.click();
      await settle(page, 600);
      const section = await T(page, 'firmware-section').innerText().catch(() => '');
      check('[read] the editor group shows no Hold or Plan buttons', (await T(page, 'firmware-section').getByRole('button', { name: /^(Hold|Release|Plan|Choose)/ }).count()) === 0, section);
      await shot(page, '19-reader-editor');
    } else {
      check('[read] the canvas is reachable from the Inventory', false);
    }
    check('[read] no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ---------------------------------------------------------------- 7. dark mode and phone width
  for (const opts of [
    { tag: 'dark', w: 1400, h: 900, dark: true },
    { tag: 'phone', w: 390, h: 800, dark: false },
    { tag: 'phone-dark', w: 390, h: 800, dark: true },
  ]) {
    const { tag } = opts;
    const { context, page, pageErrors } = await open(opts);
    await goKind(page, 'Firmware');
    await settle(page, 600);
    check(`[${tag}] the list does not overflow its own area sideways (the shell's top bar is the shell's business)`, (await noOverflow(page, '[data-testid=firmware-list]')) === '', await noOverflow(page, '[data-testid=firmware-list]'));
    await shot(page, `20-${tag}-list`);
    await page.getByRole('button', { name: '23.4R2', exact: true }).click();
    await settle(page, 500);
    await shot(page, `21-${tag}-image`);
    await goKind(page, 'Models');
    await openModelRow(page, 'EX2300-24P');
    await T(page, 'firmware-model').waitFor({ timeout: 8_000 });
    await settle(page, 500);
    check(`[${tag}] the model page does not overflow its own area sideways`, (await noOverflow(page, '[data-testid=firmware-model]')) === '', await noOverflow(page, '[data-testid=firmware-model]'));
    await shot(page, `22-${tag}-model`);
    await goKind(page, 'Firmware');
    await page.getByRole('button', { name: /Upload image/ }).click();
    await T(page, 'firmware-upload').waitFor({ timeout: 5_000 });
    await shot(page, `23-${tag}-upload`);
    check(`[${tag}] no uncaught page errors`, pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }
  // The plan panel and the editor, dark and phone.
  for (const opts of [
    { tag: 'dark', w: 1400, h: 900, dark: true },
    { tag: 'phone', w: 390, h: 800, dark: false },
  ]) {
    const { tag } = opts;
    const { context, page, pageErrors } = await open(opts);
    const node = page.locator('.react-flow__node-chassis', { hasText: 'switch-1' });
    await node.click({ button: 'right', force: true });
    await page.locator('.drawing-context-menu__item', { hasText: 'Plan a firmware upgrade' }).click();
    await page.waitForSelector('[data-testid=plans-panel]', { timeout: 10_000 });
    await settle(page, 1000);
    check(`[${tag}] the plan panel does not overflow sideways`, (await noOverflow(page, '[data-testid=plans-panel]')) === '', await noOverflow(page, '[data-testid=plans-panel]'));
    await T(page, 'plans-firmware').scrollIntoViewIfNeeded();
    await shot(page, `24-${tag}-plan`);
    check(`[${tag}] no uncaught page errors`, pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
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
  check('harness files removed', ![PREVIEW_HTML, PREVIEW_TSX, PREVIEW_SEED, PREVIEW_CATALOGUE].some(existsSync));
}

console.log(fails.length ? '\nFAILURES:\n  ' + fails.join('\n  ') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
