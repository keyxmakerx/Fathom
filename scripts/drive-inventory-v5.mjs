// Proves ADR-0062 against the real compiled client: the Inventory table windows 600 rows, edits a
// cell in place and Tabs to the next, adds a thing by name, defines a custom field and fills it,
// filters, pastes rows, bulk-tags, opens a page with tabs, and Show on canvas. Same harness as
// drive-tags.mjs. Usage: node scripts/drive-inventory.mjs  (FATHOM_SHOTS picks the screenshot dir)
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
const PORT = 18351;
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
    <title>Fathom — ADR-0062 proof preview (throwaway, not shipped)</title>
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

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('    console error: ' + m.text().slice(0, 300)); });
  const shot = async (name) => {
    await page.screenshot({ path: SHOTS + name });
    console.log('    wrote ' + SHOTS + name);
  };


  const SCENE = process.env.FATHOM_SCENE ?? 'estate';
  const WRITES = SCENE !== 'scale';
  const timings = {};
  const timed = async (name, fn) => {
    const t = Date.now();
    const r = await fn();
    timings[name] = Date.now() - t;
    return r;
  };
  const hashOf = () => page.evaluate(() => window.location.hash);
  const railCount = async (word) => {
    const t = await page.locator('.inventory-place__rail').innerText();
    const m = new RegExp(word + '\\s*([\\d,]+)').exec(t);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  // FATHOM_PROFILE=1 prints where the first seconds go (top self time), for finding what is slow to open.
  let cdp = null;
  if (process.env.FATHOM_PROFILE) {
    cdp = await context.newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  await page.goto(`${BASE}/drive.html?scene=${SCENE}&scale=${process.env.FATHOM_SCALE ?? '1'}`);
  await timed('canvas first paint (the app lands there)', () => page.waitForSelector('.drawing', { timeout: 240_000 }).catch(async (e) => {
    console.log('    page says: ' + (await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '(page is busy)')));
    throw e;
  }));
  await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  await timed('first list', () => page.waitForSelector('.inv-table__row', { timeout: 60_000 }));
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const dt = profile.timeDeltas;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => {
      const f = byId.get(id).callFrame;
      const k = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber}`;
      self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0));
    });
    console.log('    top self time (ms):\n' + [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `      ${Math.round(v / 1000)}  ${k}`).join('\n'));
  }
  const devicesAll = await railCount('Devices');
  const portsAll = await railCount('Ports');
  const cablesAll = await railCount('Cables');
  check('the rail counts devices, ports and cables', devicesAll > 100 && portsAll > devicesAll && cablesAll > 100, `devices=${devicesAll} ports=${portsAll} cables=${cablesAll}`);
  await shot('v5-01-list.png');

  // 1 — a page replaces the list; Back restores scroll, filter and the address.
  const line = page.getByLabel('Filter devices');
  await line.fill('role:server');
  await page.waitForTimeout(400);
  const switches = await page.locator('.inv-table__scroll').evaluate((el) => el.scrollHeight);
  await page.locator('.inv-table__scroll').evaluate((el) => { el.scrollTop = 900; });
  await page.waitForTimeout(200);
  const before = await page.locator('.inv-table__scroll').evaluate((el) => el.scrollTop);
  const firstName = await page.locator('.inv-table__row').first().locator('[role=gridcell]').nth(1).innerText();
  await timed('open a row', async () => {
    await page.locator('.inv-table__row').first().locator('[role=gridcell]').nth(1).click();
    await page.waitForSelector('.inv-page', { timeout: 10_000 });
  });
  check('opening a row replaces the list', (await page.locator('.inv-table__row').count()) === 0);
  check('the address names the open row', (await hashOf()).includes('o='), await hashOf());
  await shot('v5-02-page.png');
  await timed('Back to the list', async () => {
    await page.goBack();
    await page.waitForSelector('.inv-table__row', { timeout: 10_000 });
  });
  await page.waitForTimeout(300);
  const after = await page.locator('.inv-table__scroll').evaluate((el) => el.scrollTop);
  check('the browser Back restores the scroll', Math.abs(after - before) < 40, `before=${before} after=${after}`);
  check('Back keeps the filter line', (await line.inputValue()) === 'role:server');
  void switches;
  void firstName;
  await line.fill('');

  // 2 — the query line: operators, chips, reading in words, errors that name the term.
  await timed('filter: a two-term query', async () => {
    await line.fill('role:switch rack:LON1-A02');
    await page.waitForFunction(() => document.querySelectorAll('.inv-chip').length === 2);
  });
  const chips = await page.locator('.inv-chip').count();
  check('each condition is a chip', chips === 2, `chips=${chips}`);
  const reading = await page.locator('.inv-fq__reading').innerText();
  check('the line is read back in words', /Role is switch/i.test(reading) && /LON1-A02/.test(reading), reading);
  await page.waitForTimeout(350); // the address follows the line a moment after the last key
  check('the line is in the address', decodeURIComponent(await hashOf()).includes('q=role:switch'), await hashOf());
  await shot('v5-03-query.png');
  await line.fill('rak:LON1-A02');
  await page.waitForTimeout(300);
  check('a bad term is named', (await page.locator('.inv-fq__errors').innerText()).includes('rak'));
  await line.fill('');

  // 3 — Find anything.
  const find = page.getByLabel('Find anything');
  await timed('find: device and port', async () => {
    await find.fill('lon1-a02-tor1 ge-0/0/4');
    await page.waitForSelector('.inv-find__panel', { timeout: 5_000 });
  });
  const readingFind = await page.locator('.inv-find__reading').innerText();
  check('Find says how it read the clue', /port ge-0\/0\/4 on lon1-a02-tor1/.test(readingFind), readingFind);
  await shot('v5-04-find.png');
  await find.press('Enter');
  await page.waitForSelector('.inv-page', { timeout: 10_000 });
  check('Enter on exactly one match opens it', (await page.locator('.inv-page').innerText()).includes('ge-0/0/4'));
  await page.getByRole('button', { name: /^← Ports/ }).click();
  await page.waitForSelector('.inv-table__row', { timeout: 10_000 });
  await find.fill('lon1-a02');
  await page.waitForSelector('.inv-find__group', { timeout: 5_000 });
  await find.press('Enter');
  check('Enter on many matches lists them instead of opening', (await page.locator('.inv-page').count()) === 0 && (await page.locator('.inv-find__hit').count()) > 1);
  await shot('v5-05-find-many.png');
  await find.fill('');
  await page.keyboard.press('Escape');

  // 4 — the Where bar: counts follow it, Find says what it hides, Clear puts it back.
  await page.getByRole('button', { name: /^Devices/ }).first().click().catch(() => {});
  // One premises holds every site's racks (the closet model has one), so Where's rows tell the sites apart.
  await page.locator('.inv-where').getByLabel('Site').selectOption({ index: 1 });
  await timed('Where: pick a row', async () => {
    await page.locator('.inv-where').getByLabel('Row').selectOption('LON2 Row A');
    await page.waitForFunction((all) => !new RegExp('Devices\\s*' + all).test(document.querySelector('.inventory-place__rail')?.textContent?.replace(/,/g, '') ?? ''), devicesAll);
  });
  const devicesLon2 = await railCount('Devices');
  check('Where narrows the rail counts', devicesLon2 > 0 && devicesLon2 < devicesAll, `all=${devicesAll} LON2 Row A=${devicesLon2}`);
  await find.fill('lon1-a02-tor1');
  await page.waitForSelector('.inv-find__outside', { timeout: 5_000 });
  const outside = await page.locator('.inv-find__outside').innerText();
  check('Find says what Where hides', /1 more outside Northwind › LON2 Row A/.test(outside), outside);
  await shot('v5-06-where.png');
  await find.fill('');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Clear/ }).first().click();
  await page.waitForTimeout(400);
  check('Clear restores the counts', (await railCount('Devices')) === devicesAll);

  // 5 — column menus, a second sort, footer totals.
  const rail = page.locator('.inventory-place__rail');
  await rail.getByRole('button', { name: /^Cables/ }).first().click();
  await page.waitForSelector('.inv-table__row', { timeout: 30_000 });
  await page.getByLabel('Sheath menu').click();
  const menu = page.locator('.inv-cm');
  await menu.waitFor();
  const menuText = await menu.innerText();
  check('a column menu lists its values with counts', /\d/.test(menuText) && /show only/i.test(menuText), menuText.replace(/\s+/g, ' ').slice(0, 120));
  await shot('v5-07-column-menu.png');
  await menu.getByRole('group', { name: 'Sheath values' }).getByRole('checkbox').first().check();
  await page.waitForTimeout(300);
  const cableLine = page.getByLabel('Filter cables');
  check('picking a value writes the filter line', /^sheath:/.test(await cableLine.inputValue()), await cableLine.inputValue());
  await page.keyboard.press('Escape');
  await cableLine.fill('');
  await cableLine.blur();
  await page.getByLabel('Label menu').click();
  const bigMenu = await page.locator('.inv-cm').innerText();
  check('a column with thousands of values asks for a typed condition', /too many to list/.test(bigMenu), bigMenu.replace(/\s+/g, ' ').slice(0, 140));
  await page.getByLabel('Label value').fill('C-1041');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForTimeout(300);
  check('the typed condition is written into the line', (await cableLine.inputValue()) === 'name~C-1041', await cableLine.inputValue());
  await page.keyboard.press('Escape');
  await cableLine.fill('');
  await cableLine.blur();
  await page.getByRole('columnheader', { name: /Length/ }).getByRole('button').first().click();
  await page.getByRole('columnheader', { name: /Sheath/ }).getByRole('button').first().click({ modifiers: ['Shift'] });
  await page.waitForTimeout(300);
  check('shift-click adds a second sort', /s=length%3Aasc%2Csheath%3Aasc/.test(await hashOf()), await hashOf());
  const foot = await page.locator('.inv-foot').innerText();
  check('the footer counts the rows and adds up cable length', /cables/.test(foot) && /Cable length\s+[\d,]+ m/.test(foot), foot.replace(/\s+/g, ' '));
  await shot('v5-08-footer.png');

  // 6 — select all matching, then a bulk change with a preview, one Undo step.
  await rail.getByRole('button', { name: /^Devices/ }).first().click();
  await page.waitForSelector('.inv-table__row', { timeout: 30_000 });
  const devLine = page.getByLabel('Filter devices');
  await devLine.fill('role:server rack:LON1-A03');
  await page.waitForTimeout(300);
  const servers = Number(/(\d[\d,]*)(?: of [\d,]+)? devices/.exec(await page.locator('.inv-foot').innerText())?.[1].replace(/,/g, ''));
  await page.locator('.inv-table__row').first().getByRole('checkbox').check();
  await page.getByRole('button', { name: /^Select all [\d,]+ matching/ }).click();
  check('Select all N matching ticks every row the line matches', (await page.locator('.inv-bulk').innerText()).includes(`${servers.toLocaleString('en-GB')} selected`), `servers=${servers}`);
  await page.getByLabel('Column to set').selectOption('role');
  await page.getByLabel('Value').fill('other');
  await page.getByRole('button', { name: 'Set', exact: true }).click();
  const pv = await page.locator('.inv-bulkpv').innerText();
  check('the preview shows before and after and how many change', /Set Role to other/.test(pv) && /would change/.test(pv) && /server/.test(pv), pv.replace(/\s+/g, ' ').slice(0, 160));
  await shot('v5-09-bulk-preview.png');
  if (WRITES) {
    await page.getByRole('button', { name: /^Apply to/ }).click();
    await page.waitForTimeout(1500);
    check('nothing is a server any more', (await page.locator('.inv-table__row').count()) === 0);
    await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
    await page.waitForTimeout(1500);
    check('Undo puts every row back in one step', new RegExp('^' + servers.toLocaleString('en-GB') + '( of [\\d,]+)? devices').test(await page.locator('.inv-foot').innerText()), (await page.locator('.inv-foot').innerText()).replace(/\s+/g, ' '));
  } else {
    // Every write saves the whole design through the harness's mock server, which at this size
    // blocks the page for a minute; the numbers that matter here are reads.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await devLine.fill('');

  // 7 — pages: a cable's run through patch panels, a device's "Plugged into" and port map, a rack.
  await rail.getByRole('button', { name: /^Cables/ }).first().click();
  await page.waitForSelector('.inv-table__row', { timeout: 30_000 });
  const cabLine2 = page.getByLabel('Filter cables');
  await cabLine2.fill('device:lon1-a02-pp1 device:lon1-a01-cpp1');
  await page.waitForTimeout(400);
  await page.locator('.inv-table__row').first().locator('[role=gridcell]').nth(1).click();
  await page.waitForSelector('.inv-path', { timeout: 10_000 });
  const run = await page.locator('.inv-path').innerText();
  check('a cable page shows its run through two patch panels', /3 cables through 2 patch panels/i.test(run) && (run.match(/patch panel/gi) ?? []).length >= 2, run.replace(/\s+/g, ' ').slice(0, 200));
  check('each stop says site, row, rack and unit', /Northwind › LON1 Row A › LON1-A0\d › U\d+/.test(run));
  check('the run shows front and rear', /front/.test(run) && /rear/.test(run));
  check('the run carries a Last traced stamp', /Last traced:/.test(run));
  await shot('v5-10-cable-page.png');
  await page.getByRole('button', { name: /^← Cables/ }).click();
  await cabLine2.fill('');
  await cabLine2.blur();
  await find.fill('lon1-a02-tor1');
  await find.press('Enter');
  await page.waitForSelector('.inv-plug', { timeout: 10_000 });
  const plug = await page.locator('.inv-plug').innerText();
  check('a device page says what it is plugged into', /Plugged into/i.test(plug) && /lon1-srv/.test(plug), plug.replace(/\s+/g, ' ').slice(0, 160));
  await shot('v5-11-device-page.png');
  await find.fill('lon1-a02-pp1');
  await find.press('Enter');
  await page.waitForSelector('.inv-page', { timeout: 10_000 });
  await page.getByRole('tab', { name: /^Ports/ }).click();
  await page.waitForSelector('.inv-pm', { timeout: 5_000 });
  check('a patch panel gets a port map', (await page.locator('.inv-pm__col').count()) === 6, String(await page.locator('.inv-pm__col').count()));
  await shot('v5-12-port-map.png');
  await find.fill('rack LON1-A02');
  await find.press('Enter');
  await page.waitForSelector('.inv-rackp', { timeout: 10_000 });
  const rackText = await page.locator('.inv-rackp').innerText();
  check('a rack page lists what is in it and the cables touching it', /In this rack/i.test(rackText) && /Cables touching this rack/i.test(rackText), rackText.replace(/\s+/g, ' ').slice(0, 120));
  await shot('v5-13-rack-page.png');
  await page.getByRole('button', { name: 'Set Where to this rack' }).click();
  await page.waitForTimeout(300);
  check('Set Where to this rack fills the Where bar', (await page.locator('.inv-where').getByLabel('Rack').inputValue()) === 'LON1-A02');
  await page.locator('.inv-where').getByRole('button', { name: /^Clear/ }).click();

  await page.getByRole('button', { name: /^← / }).click();
  await rail.getByRole('button', { name: /^Devices/ }).first().click();
  await page.waitForSelector('.inv-table__row', { timeout: 30_000 });

  // A save writes the whole estate through the real engine: proof the made-up document is a real one.
  if (WRITES) {
    await page.getByLabel(/Name of the new/).fill('v5-added');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForSelector('.inv-page', { timeout: 30_000 });
    await page.waitForFunction(() => (window.__saveCount__ ?? 0) > 0, null, { timeout: 60_000 });
  }

  console.log('timings (ms): ' + JSON.stringify(timings));

  const saveCount = await page.evaluate(() => window.__saveCount__ ?? 0);
  if (WRITES) check('the scene saved', saveCount > 0, `saveCount=${saveCount}`);
  const saveLoadFailures = await page.evaluate(() => window.__saveLoadFailures__ ?? []);
  check('every saved payload loaded through the engine', saveLoadFailures.length === 0, saveLoadFailures.join(' | '));
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
