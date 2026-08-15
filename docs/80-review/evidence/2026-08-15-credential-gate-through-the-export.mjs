/* Invariant 3, driven through the only door the product has.
   Three credential leaks were closed this round. This pastes each leaking
   statement into the real page and reads back the STORED capture, because a
   Rust test asserts on a function and this asserts on the product. */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const URL = 'file:///home/user/Fathom/target/artifact/fathom-dev.html';

const SECRETS = {
  'ospf simple-password (leak 1: judged by entry, not statement)':
    ['set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 authentication simple-password',
     'Tr0ub4dor3xKf9QmZpLw2Nv'],
  'ike pre-shared-key hexadecimal (leak 2: opened by the widening)':
    ['set security ike policy hq-policy pre-shared-key hexadecimal',
     'a3f9c2e18b7d4056af219cbe83d7f145'],
  'bgp authentication-key (leak 3: missing catalogue level)':
    ['set protocols bgp group ibgp authentication-key',
     'BgpNeighborSecret2026xyz'],
  'rip authentication-key (the unconstrained-capture neighbour)':
    ['set protocols rip group core authentication-key',
     'RipGroupSecret99887766'],
  'ike gateway pre-shared-key (the original, must still hold)':
    ['set security ike policy p1 pre-shared-key ascii-text',
     'OriginalPskMustStillGo1'],
};

const lines = ['set system host-name srx-leak-probe'];
for (const [, [stmt, sec]] of Object.entries(SECRETS)) lines.push(stmt + ' ' + sec);
const CONFIG = lines.join('\n') + '\n';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.goto(URL);
await page.waitForFunction(() => document.querySelector('#band button') !== null);
await page.click('#tabPaste');
await page.fill('#pta', CONFIG);
await page.click('#pRun');
await page.waitForTimeout(1200);

/* The journal holds the REDACTED capture — invariant 3's whole point is that
   what is stored is not what was pasted. Export it and read every byte. */
/* Take the journal through the product's own export button, not through a
   global: the export is what leaves the machine, so it is the thing that must
   be clean. The download is intercepted rather than saved. */
const dl = page.waitForEvent('download');
await page.click('#tabExport');
const d = await dl;
const fs = await import('node:fs');
const path = '/tmp/claude-0/-home-user-Fathom/6b99fe87-c207-5a7a-a276-aace66402f90/scratchpad/exported.json';
await d.saveAs(path);
const stored = fs.readFileSync(path, 'utf8');
console.log('exported journal: ' + stored.length + ' bytes\n');
const panel = await page.evaluate(() => document.body.innerText);

const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   ' + d : '')); };

for (const [name, [, secret]] of Object.entries(SECRETS)) {
  check('destroyed at the gate: ' + name,
    !stored.includes(secret),
    stored.includes(secret) ? 'THE SECRET IS IN THE STORED JOURNAL' : '');
  check('  ... and never rendered on screen: ' + name.split(' (')[0],
    !panel.includes(secret));
}
check('the page says how many it destroyed', /secret/i.test(panel),
  (panel.match(/\d+ secrets? removed/) || ['(no count found)'])[0]);
check('no page errors', errs.length === 0, errs.join(' | '));

console.log('\n' + results.filter(Boolean).length + '/' + results.length + ' checks pass');
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
