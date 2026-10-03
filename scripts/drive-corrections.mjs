// Proves cable corrections from the floor against the real compiled client: a Read reader sends
// Traced / Label wrong / Not here (and the design is never written), a Draw reader sees
// "Corrections waiting", accepts one as an ordinary undoable edit and dismisses another, and
// the history says whose correction it was. Usage: node scripts/drive-corrections.mjs
// (FATHOM_SHOTS picks the screenshot dir)
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
const PORT = 18361;
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
    <meta name="viewport" content="width=device-width, initial-scale=1" />
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
  const pageErrors = [];

  /** A fresh page on the estate scene as a Read or Draw reader, on the Inventory. */
  const open = async (capability) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('    console error: ' + m.text().slice(0, 300)); });
    await page.goto(`${BASE}/drive.html?scene=estate&scale=0.15&corrections=1&capability=${capability}`);
    await page.waitForSelector('.drawing', { timeout: 240_000 });
    await page.getByRole('button', { name: 'Inventory', exact: true }).click();
    await page.waitForSelector('.inv-table__row', { timeout: 60_000 });
    const shot = async (name) => {
      await page.screenshot({ path: SHOTS + name });
      console.log('    wrote ' + SHOTS + name);
    };
    const cableIds = await page.evaluate(() => window.__cableIds__);
    const gotoCable = async (index, tab = '') => {
      await page.evaluate(([id, t]) => { window.location.hash = `inventory?k=cables&o=${encodeURIComponent('cable:' + id)}${t ? '&t=' + t : ''}`; }, [cableIds[index], tab]);
      await page.waitForSelector('.inv-page', { timeout: 10_000 });
    };
    const posts = () => page.evaluate(() => window.__requests__.filter((r) => r.method === 'POST' && /corrections/.test(r.url)).map((r) => ({ url: r.url, body: r.bodyLatin1 })));
    const saves = () => page.evaluate(() => window.__saveCount__ ?? 0);
    return { context, page, shot, cableIds, gotoCable, posts, saves };
  };

  // ---- A reader who can only read ----
  {
    const r = await open('read');
    const { page } = r;
    check('read: the rail has no "Corrections waiting"', (await page.locator('.inventory-place__rail').innerText()).indexOf('Corrections waiting') < 0);
    await r.gotoCable(0);
    await page.waitForSelector('.inv-corr', { timeout: 10_000 });
    const sect = page.locator('.inv-corr');
    check('read: the cable page offers the three buttons', (await sect.getByRole('button').allInnerTexts()).join('|') === 'Traced ✓|Label wrong|Not here', (await sect.getByRole('button').allInnerTexts()).join('|'));
    check('read: no Accept or Dismiss', (await page.getByRole('button', { name: /^(Accept|Dismiss)$/ }).count()) === 0);
    check('read: their own dismissed correction shows its text is gone', /dismissed/.test(await sect.innerText()) && /removed once dismissed/.test(await sect.innerText()) && !/In the other row/.test(await sect.innerText()), await sect.innerText());
    check('read: nobody else\'s correction is shown', !/PP1-04|Ann Floor/.test(await sect.innerText()));
    await r.shot('corrections-01-read-cable.png');

    await sect.getByRole('button', { name: 'Label wrong' }).click();
    await page.getByLabel('What should the label say?').fill('  PP9-99 ');
    await r.shot('corrections-02-read-form.png');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForSelector('.inv-corr [role=status]', { timeout: 5_000 });
    await sect.getByRole('button', { name: 'Traced ✓' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.inv-corr__sent li').length >= 3, null, { timeout: 5_000 });
    await sect.getByRole('button', { name: 'Not here' }).click();
    check('read: the form says Fathom does not hide what you type', (await sect.innerText()).includes('Fathom does not hide what you type, so do not type passwords.'));
    const where = page.getByLabel('Where is it actually?');
    await where.fill('');
    // A paste is gated: a device-style secret does not arrive in the box.
    await where.focus();
    await page.evaluate(() => {
      const box = document.activeElement;
      const dt = new DataTransfer();
      dt.setData('text/plain', 'behind patch panel enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0');
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(1500);
    const pasted = await where.inputValue();
    check('read: a pasted secret does not arrive in the box', !/\$1\$mERr|hx5rVt7/.test(pasted), pasted);
    await where.fill('Rack B3, U12');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.inv-corr__sent li').length >= 4, null, { timeout: 5_000 });
    const sent = (await r.posts()).map((p) => JSON.parse(p.body));
    check('read: three corrections went to the server with their kinds', sent.map((s) => s.kind).join(',') === 'label,traced,not_here', JSON.stringify(sent));
    check('read: the label text went as typed', sent[0].text === '  PP9-99 ' || sent[0].text === 'PP9-99', JSON.stringify(sent[0]));
    check('read: the sent list says waiting', (await page.locator('.inv-corr__sent').innerText()).includes('waiting'));
    check('read: the design itself was never written', (await r.saves()) === 0 && !(await page.evaluate(() => window.__requests__.some((q) => q.method === 'POST' && /versions/.test(q.url)))));
    await r.shot('corrections-03-read-sent.png');
    await r.context.close();
  }

  // ---- A reader who can draw ----
  {
    const r = await open('steward');
    const { page } = r;
    const rail = page.locator('.inventory-place__rail');
    check('draw: the rail shows Corrections waiting 4', /Corrections waiting\s*4/.test(await rail.innerText()), await rail.innerText());
    await r.shot('corrections-04-draw-rail.png');
    await rail.getByRole('button', { name: /Corrections waiting/ }).click();
    await page.waitForSelector('.inv-corr--page', { timeout: 10_000 });
    const list = page.locator('.inv-corr--page');
    check('draw: the waiting page lists all four', (await list.locator('h3').textContent()).includes('(4)'), await list.locator('h3').textContent());
    const orphan = list.locator('li', { hasText: 'GONE-1' });
    check('draw: the orphan has Dismiss but no Accept', (await orphan.getByRole('button', { name: 'Accept' }).count()) === 0 && (await orphan.getByRole('button', { name: 'Dismiss' }).count()) === 1);
    check('draw: the orphan says its cable is gone', (await orphan.innerText()).includes('no longer in this design'));
    check('draw: the others can be accepted', (await list.getByRole('button', { name: 'Accept' }).count()) === 3);
    await r.shot('corrections-04b-draw-waiting-page.png');
    await orphan.getByRole('button', { name: 'Dismiss' }).click();
    await page.waitForFunction(() => document.querySelector('.inv-corr--page h3')?.textContent?.includes('(3)'), null, { timeout: 5_000 });
    check('draw: dismissing the orphan clears it', /Corrections waiting\s*3/.test(await rail.innerText()), await rail.innerText());
    await r.gotoCable(0);
    await page.waitForSelector('.inv-corr', { timeout: 10_000 });
    const sect = page.locator('.inv-corr');
    check('draw: the first cable shows "Corrections waiting (2)"', (await sect.locator('h3').textContent()).includes('Corrections waiting (2)'), await sect.locator('h3').textContent());
    check('draw: no send buttons', (await page.getByRole('button', { name: 'Label wrong' }).count()) === 0);
    check('draw: the sender is named', (await sect.innerText()).includes('Ann Floor'));
    await r.shot('corrections-05-draw-cable.png');

    // The server's "accepted" is taken back when the edit cannot be saved.
    await page.evaluate(() => { window.__failSaves__ = true; });
    await sect.locator('li', { hasText: 'PP1-04' }).getByRole('button', { name: 'Accept' }).click();
    await page.waitForSelector('.inv-corr__refused', { timeout: 15_000 });
    const why = await page.locator('.inv-corr__refused').innerText();
    check('draw: a failed save says the correction is back in the waiting list', /could not be saved/.test(why) && /back in the waiting list/.test(why), why);
    check('draw: it is still listed as waiting (2)', (await sect.locator('h3').textContent()).includes('(2)'), await sect.locator('h3').textContent());
    await r.shot('corrections-05b-draw-save-failed.png');
    await page.evaluate(() => { window.__failSaves__ = false; });
    // Reload drops the unsaved local edit, as the refusal wash says.
    await page.getByRole('button', { name: 'Reload' }).click();
    await page.waitForTimeout(1500);
    await r.gotoCable(0);
    await page.waitForSelector('.inv-corr', { timeout: 15_000 });
    check('draw: after Reload the correction is still waiting (2)', (await page.locator('.inv-corr h3').textContent()).includes('(2)'), await page.locator('.inv-corr h3').textContent());

    const before = await r.saves();
    await sect.locator('li', { hasText: 'PP1-04' }).getByRole('button', { name: 'Accept' }).click();
    await page.waitForFunction(() => document.querySelector('.inv-corr h3')?.textContent?.includes('(1)'), null, { timeout: 5_000 });
    check('draw: accepting a label correction saved once', await page.waitForFunction((b) => window.__saveCount__ === b + 1, before, { timeout: 8_000 }).then(() => true, () => false));
    check('draw: the label is now PP1-04', (await page.locator('.inv-page__title').innerText()) === 'PP1-04', await page.locator('.inv-page__title').innerText());
    await r.shot('corrections-06-draw-accepted.png');
    await page.getByRole('tab', { name: 'History' }).click();
    check("draw: History says \"Accepted Ann Floor's correction\"", (await page.locator('.inv-page__list').innerText()).includes("Accepted Ann Floor's correction"), await page.locator('.inv-page__list').innerText());
    await r.shot('corrections-07-draw-history.png');
    await page.getByRole('tab', { name: 'Overview' }).click();

    await sect.locator('li', { hasText: 'traced this cable' }).getByRole('button', { name: 'Dismiss' }).click();
    await page.waitForFunction(() => !document.querySelector('.inv-corr'), null, { timeout: 5_000 });
    await page.getByRole('tab', { name: 'History' }).click();
    check("draw: History says \"Dismissed Ann Floor's correction\"", (await page.locator('.inv-page__list').innerText()).includes("Dismissed Ann Floor's correction"), await page.locator('.inv-page__list').innerText());
    check('draw: the rail count fell to 1', /Corrections waiting\s*1\b/.test(await rail.innerText()), await rail.innerText());
    const dismissedSaves = await r.saves();
    check('draw: dismissing wrote nothing to the design', dismissedSaves === before + 1, `${dismissedSaves} vs ${before + 1}`);

    await rail.getByRole('button', { name: /Corrections waiting/ }).click();
    await page.waitForSelector('.inv-corr--page', { timeout: 10_000 });
    await page.locator('.inv-corr--page li', { hasText: 'blanking plate' }).getByRole('button', { name: 'Accept' }).click();
    await page.waitForFunction(() => document.querySelector('.inv-corr--page h3')?.textContent?.includes('(0)'), null, { timeout: 8_000 });
    await r.gotoCable(1, 'notes');
    await page.waitForSelector('.inv-page__body', { timeout: 10_000 });
    check('draw: a not-here report became a note on the cable', (await page.locator('.inv-page__body').innerText()).includes('Reported not here: Behind the blanking plate in B3'), await page.locator('.inv-page__body').innerText());
    check('draw: nothing is waiting now', !/Corrections waiting/.test(await rail.innerText()));
    await r.shot('corrections-08-draw-note.png');

    // One undo step takes the note back out.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.waitForTimeout(500);
    check('draw: Undo takes the acceptance back as one step', !(await page.locator('.inv-page__body').innerText()).includes('Reported not here'), await page.locator('.inv-page__body').innerText());
    const failures = await page.evaluate(() => window.__saveLoadFailures__ ?? []);
    check('every saved payload loaded through the engine', failures.length === 0, failures.join(' | '));
    await r.context.close();
  }

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
