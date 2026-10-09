// Proves the file importer (round 9) in a real browser: drop, detect, map, preview, import as one
// undo step; the real wasm gate strips secrets; a Differ row is picked; nmap XML goes through the
// browser's DOMParser; hostile files are refused; the page makes no request. The dialog is mounted
// alone (scripts/drive-lib/import-harness.tsx), since wiring into the app is separate.
// Usage: node scripts/drive-import.mjs  (FATHOM_SHOTS picks the screenshot dir)
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
// Not shared with any other `scripts/drive-*.mjs` — `grep -h "PORT = "
// scripts/drive-*.mjs` before picking a new one.
const PORT = 18341;
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

// Step 1: copy the shared throwaway harness into `client/`.
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
    <title>Fathom — importer proof preview (throwaway, not shipped)</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/drive.tsx"></script>
  </body>
</html>
`,
);
mkdirSync(CLIENT + '/public', { recursive: true });
copyFileSync(DRIVE_LIB + '/import-harness.tsx', PREVIEW_TSX);
copyFileSync(DRIVE_LIB + '/seed.ts', PREVIEW_SEED);
copyFileSync(DRIVE_LIB + '/catalogue.json', PREVIEW_CATALOGUE);
check('drive.html written', existsSync(PREVIEW_HTML));
check('drive.tsx copied from drive-lib/import-harness.tsx', existsSync(PREVIEW_TSX));
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

const SECRET_VALUE = 'S3cr3t-Pa55w0rd!2026xyz-Rk3vT9qLw2pX';
const CSV_A = `name,status,role,manufacturer,device_type,serial,rack,position,face,primary_ip4,comments,cf_owner,cf_warranty_end,cf_snmp_community
fw-01,active,Firewall,Juniper,SRX340,SRX-0001,A-04,3,front,10.0.0.1/24,,Security,2028-01-01,${SECRET_VALUE}
core-sw-01,active,Switch,Ubiquiti,USW-48-PoE,US-CORE-9,A-04,6,front,10.0.0.2,"set snmp community DRIVEcommunity7731abcdef authorization read-only",IT,2028-02-02,${SECRET_VALUE}
sw-03,active,Switch,Ubiquiti,USW-24-PoE,US-3,A-04,10,front,10.0.0.5,,Facilities,2028-03-03,${SECRET_VALUE}
lab-box,active,Server,Acme,Box 1,,,,,10.0.0.9,,Lab,=1+1,${SECRET_VALUE}
=cmd|' /C calc'!A0,active,Server,Acme,Box 2,,,,,10.0.0.10,,Lab,2028-04-04,${SECRET_VALUE}
`;
const CSV_B = 'name,serial\nfw-01,SRX-0002\n';
const NMAP = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nmaprun>
<nmaprun scanner="nmap" version="7.94"><host><status state="up"/><address addr="10.0.99.2" addrtype="ipv4"/>
<hostnames><hostname name="scan-sw.example" type="PTR"/></hostnames>
<ports><port protocol="tcp" portid="80"><state state="open"/><service name="http" product="nginx"/><script id="banner" output="set snmp community DRIVEbannerComm99887766 authorization read-only"/><script id="ftp-brute" output="root:DRIVEbrutePw-5521"/></port></ports></host>
<host><status state="up"/><address addr="10.0.99.50" addrtype="ipv4"/></host></nmaprun>`;
const XXE = '<?xml version="1.0"?><!DOCTYPE nmaprun [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><nmaprun><host><hostnames><hostname name="&xxe;"/></hostnames></host></nmaprun>';

const dialog = (page) => page.locator('.imp');
async function openAndDrop(page, name, text, mime = 'text/csv') {
  if ((await page.locator('.imp').count()) === 0) await page.getByRole('button', { name: 'Open importer' }).click();
  await page.waitForSelector('.imp__drop');
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: mime, buffer: Buffer.from(text) });
}
const state = (page) => page.evaluate(() => window.__importState__());
const dev = (s, name) => s.devices.find((d) => d.name === name);

try {
  console.log(`==> starting the client dev server on port ${PORT}`);
  viteProc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], { cwd: CLIENT, stdio: ['ignore', 'pipe', 'pipe'] });
  let viteLog = '';
  viteProc.stdout.on('data', (d) => { viteLog += d.toString(); });
  viteProc.stderr.on('data', (d) => { viteLog += d.toString(); });
  const up = await waitForServer(`${BASE}/drive.html`, 30_000);
  check('client dev server answers /drive.html', up, up ? '' : viteLog.slice(-2000));
  if (!up) throw new Error('dev server did not come up');

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const shot = async (name) => {
    await page.screenshot({ path: SHOTS + name });
    console.log('    wrote ' + SHOTS + name);
  };

  await page.goto(`${BASE}/drive.html`);
  await page.waitForSelector('.imp__drop', { timeout: 20_000 });
  const start = await state(page);
  check('the seeded design has 3 devices', start.devices.length === 3, start.devices.map((d) => d.name).join(','));
  const startSteps = start.undoSteps;

  // 1 — Drop: a real drop event with a File, then it says what it recognised.
  await page.evaluate((csv) => {
    const dt = new DataTransfer();
    dt.items.add(new File([csv], 'netbox-devices.csv', { type: 'text/csv' }));
    document.querySelector('.imp__drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, CSV_A);
  await page.waitForSelector('.imp__recognised', { timeout: 15_000 });
  const rec = await page.locator('.imp__recognised').innerText();
  check('step 1 names the file and the kind', /netbox-devices\.csv/.test(rec) && /NetBox device export, 5 rows/.test(rec), rec.replace(/\s+/g, ' '));
  const pageText1 = await dialog(page).innerText();
  check('step 1 says a value was kept as text because it began with =', /begin with = \+ - or @/.test(pageText1));
  await shot('import-1-drop.png');

  // 2 — Match.
  await page.getByRole('button', { name: 'Match columns' }).click();
  await page.waitForSelector('.imp__table');
  const sel = (h) => page.getByLabel(`Fathom field for ${h}`, { exact: true });
  check('device_type maps to Model', (await sel('device_type').inputValue()) === 'core:model');
  check('primary_ip4 maps to Management address', (await sel('primary_ip4').inputValue()) === 'core:mgmt');
  check('an unknown column starts as Ignore, never as a new shared field', (await sel('cf_owner').inputValue()) === 'ignore');
  check('a column that looks like a secret is refused, with the reason and no choice', (await page.getByText('Not imported: this column looks like it holds a secret').count()) === 1 && (await sel('cf_snmp_community').count()) === 0);
  await sel('cf_owner').selectOption('new');
  check('cf_owner chosen as a new shared field is named Owner', (await page.getByLabel('Name of the new field for cf_owner').inputValue()) === 'Owner');
  check('the page says Undo does not remove new shared fields', /Undo does NOT remove them/.test(await dialog(page).innerText()));
  await shot('import-2-match.png');

  // 3 — Check.
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await page.waitForSelector('[aria-label=Counts]');
  const counts = await page.locator('[aria-label=Counts] tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
  const countOf = (label) => Number(counts.find((r) => r[0] === label)?.[1]);
  check('counts: New 1, Match 2, Differ 0, No model 2', countOf('New') === 1 && countOf('Match') === 2 && countOf('Differ') === 0 && countOf('No model') === 2, JSON.stringify(counts));
  await shot('import-3-check.png');
  check('the Import button names the number', await page.getByRole('button', { name: 'Import 5' }).isVisible());
  await page.getByRole('button', { name: 'Import 5' }).click();
  await page.getByText(/Imported netbox-devices\.csv/).waitFor({ timeout: 15_000 });
  const s1 = await state(page);
  check('3 new devices joined the 3 that were there', s1.devices.length === 6, s1.devices.map((d) => d.name).join(','));
  check('the existing firewall was filled in, not replaced', dev(s1, 'fw-01')?.serial === 'SRX-0001' && dev(s1, 'fw-01')?.role === 'firewall' && dev(s1, 'fw-01')?.owner === 'Security');
  check('the new switch was placed with its catalogue model', dev(s1, 'sw-03')?.model === 'USW-24-PoE' && dev(s1, 'sw-03')?.mgmt === '10.0.0.5');
  check('the whole import is ONE undo step', s1.undoSteps === startSteps + 1, `${startSteps} -> ${s1.undoSteps}`);
  check('the community string never reached the design', !s1.docText.includes('DRIVEcommunity7731abcdef'));
  check('the secret in its own column never reached the design', !s1.docText.includes(SECRET_VALUE));
  check('the history label has no file name', !s1.docText.includes('import netbox-devices') && s1.docText.includes('import (5 rows)'));
  check('a cell starting with = is stored as text', !s1.docText.includes('"=cmd') && s1.docText.includes("'=cmd"));
  check('the importer made no network request', (await page.evaluate(() => window.__requests__)).length === 0, JSON.stringify(await page.evaluate(() => window.__requests__)));
  check('the new shared fields were made once each', s1.defs.filter((d) => d.startsWith('Owner:')).length === 1, s1.defs.join(','));
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForTimeout(200);
  const s2 = await state(page);
  check('ONE Undo removes the lot', s2.devices.length === 3 && ['fw-01', 'core-sw-01'].every((n) => dev(s2, n)?.serial === '' && dev(s2, n)?.role === '' && dev(s2, n)?.mgmt === '' && dev(s2, n)?.owner === ''), `${s2.devices.length} devices`);

  // Differ: import again, then a file with another serial; keep mine, then the file's.
  await openAndDrop(page, 'netbox-devices.csv', CSV_A);
  await page.getByRole('button', { name: 'Match columns' }).click();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await page.getByRole('button', { name: /^Import \d/ }).click();
  await page.getByText(/Imported netbox-devices\.csv/).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Close' }).click();
  for (const pick of ['mine', 'theirs']) {
    await openAndDrop(page, 'serials.csv', CSV_B);
    await page.getByRole('button', { name: 'Match columns' }).click();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await page.waitForSelector('.imp__diff');
    const diffText = await page.locator('.imp__diff').innerText();
    check(`Differ shows yours and the file side by side (${pick})`, /SRX-0001/.test(diffText) && /SRX-0002/.test(diffText) && (await page.getByLabel('Keep mine (blanks still filled)').isChecked()));
    if (pick === 'mine') await shot('import-4-differ.png');
    if (pick === 'theirs') await page.getByLabel("Use the file's").check();
    await page.getByRole('button', { name: /^Import \d/ }).click();
    await page.getByText(/Imported serials\.csv/).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Close' }).click();
    const s = await state(page);
    check(`Differ ${pick}: the serial is ${pick === 'mine' ? 'still SRX-0001' : "the file's SRX-0002"}`, dev(s, 'fw-01')?.serial === (pick === 'mine' ? 'SRX-0001' : 'SRX-0002'));
    if (pick === 'theirs') {
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.waitForTimeout(150);
      check('Undo brings the old serial back', dev(await state(page), 'fw-01')?.serial === 'SRX-0001');
    }
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForTimeout(150);

  // Another person edits fw-01 while the Check step is open: that row is left alone and reported.
  await openAndDrop(page, 'late.csv', 'name,serial\nfw-01,LATE-FILE\n');
  await page.getByRole('button', { name: 'Match columns' }).click();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await page.waitForSelector('.imp__diff');
  await page.getByLabel("Use the file's").check();
  await page.evaluate(() => window.__editSerial__('fw-01', 'COLLEAGUE-1'));
  await page.getByRole('button', { name: /^Import \d/ }).click();
  await page.getByText(/Imported late\.csv/).waitFor({ timeout: 15_000 });
  check('a Differ row that changed under the person is refused and reported', dev(await state(page), 'fw-01')?.serial === 'COLLEAGUE-1' && /1 things were refused/.test(await dialog(page).innerText()));
  await page.getByRole('button', { name: 'Close' }).click();

  // nmap XML through the browser's own DOMParser.
  await openAndDrop(page, 'scan.xml', NMAP, 'text/xml');
  await page.waitForSelector('.imp__recognised', { timeout: 15_000 });
  check('nmap XML is recognised', /nmap scan, 2 hosts/.test(await page.locator('.imp__recognised').innerText()));
  await page.getByRole('button', { name: 'Match columns' }).click();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await page.getByRole('button', { name: /^Import \d/ }).click();
  await page.getByText(/Imported scan\.xml/).waitFor({ timeout: 15_000 });
  const sn = await state(page);
  check('the nmap hosts arrived as free boxes with management addresses', dev(sn, 'scan-sw.example')?.mgmt === '10.0.99.2' && dev(sn, '10.0.99.50')?.mgmt === '10.0.99.50');
  check('the banner secret from the nmap script output never reached the design', !sn.docText.includes('DRIVEbannerComm99887766'));
  check('script output and brute-force results are not imported as notes by default', !sn.docText.includes('DRIVEbrutePw-5521') && !sn.docText.includes('ftp-brute'));
  await shot('import-5-done.png');
  await page.getByRole('button', { name: 'Close' }).click();

  // Hostile files are refused with a reason.
  const refuse = async (name, body, mime, re, what) => {
    await openAndDrop(page, name, body, mime);
    await page.waitForSelector('[role=alert]', { timeout: 15_000 });
    const msg = await page.locator('[role=alert]').first().innerText();
    check(what, re.test(msg) && (await page.getByRole('button', { name: 'Match columns' }).isDisabled()), msg);
    await page.getByRole('button', { name: 'Cancel' }).click();
  };
  await refuse('xxe.xml', XXE, 'text/xml', /declares a document type or entities/, 'an external-entity XML file is refused');
  await refuse('big.csv', 'a'.repeat(5 * 1024 * 1024 + 1), 'text/csv', /limit is 5\.0 MB/, 'a file over 5 MB is refused');
  await refuse('deep.json', '['.repeat(200_000), 'application/json', /nested more than 64/, 'deeply nested JSON is refused without freezing');

  check('every document the dialog produced loads through the Rust reader', (await page.evaluate(() => window.__loadFailures__)).length === 0, (await page.evaluate(() => window.__loadFailures__)).join(' | '));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
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
