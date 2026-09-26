import { describe, expect, it } from 'vitest';

import { crc32, readStoredZip, writeStoredZip } from './zip';

describe('crc32', () => {
  it('matches the well-known vector for "123456789"', () => {
    // The standard CRC-32 (0xEDB88320) check value for this exact string
    // is 0xCBF43926 — every implementation of this polynomial agrees on it.
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes).toString(16)).toBe('cbf43926');
  });
});

describe('writeStoredZip / readStoredZip', () => {
  it('round-trips one entry byte for byte', () => {
    const data = new TextEncoder().encode('hello, zip');
    const zip = writeStoredZip([{ name: 'hello.txt', data }]);
    const back = readStoredZip(zip);
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe('hello.txt');
    expect(new TextDecoder().decode(back[0].data)).toBe('hello, zip');
  });

  it('round-trips several entries in order', () => {
    const entries = [
      { name: 'a.xml', data: new TextEncoder().encode('<a/>') },
      { name: 'dir/b.xml', data: new TextEncoder().encode('<b/>') },
      { name: 'empty.xml', data: new Uint8Array(0) },
    ];
    const zip = writeStoredZip(entries);
    const back = readStoredZip(zip);
    expect(back.map((e) => e.name)).toEqual(['a.xml', 'dir/b.xml', 'empty.xml']);
    expect(back.map((e) => new TextDecoder().decode(e.data))).toEqual(['<a/>', '<b/>', '']);
  });

  it('opens every local header with the stored-zip signature PK\\x03\\x04', () => {
    const zip = writeStoredZip([{ name: 'x.txt', data: new TextEncoder().encode('x') }]);
    expect(zip[0]).toBe(0x50); // 'P'
    expect(zip[1]).toBe(0x4b); // 'K'
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
  });

  it('ends with the end-of-central-directory signature PK\\x05\\x06', () => {
    const zip = writeStoredZip([{ name: 'x.txt', data: new TextEncoder().encode('x') }]);
    const tail = zip.slice(zip.length - 22);
    expect(tail[0]).toBe(0x50);
    expect(tail[1]).toBe(0x4b);
    expect(tail[2]).toBe(0x05);
    expect(tail[3]).toBe(0x06);
  });

  it('marks every entry as method 0 — stored, never deflated', () => {
    const zip = writeStoredZip([{ name: 'x.txt', data: new TextEncoder().encode('some content here') }]);
    // Compression method is the two bytes at local-header offset 8.
    expect(zip[8]).toBe(0);
    expect(zip[9]).toBe(0);
  });

  it('refuses a compressed entry on read (this reader is stored-only)', () => {
    const zip = writeStoredZip([{ name: 'x.txt', data: new TextEncoder().encode('x') }]);
    const tampered = Uint8Array.from(zip);
    const view = new DataView(tampered.buffer);
    const eocdOffset = tampered.length - 22;
    const centralOffset = view.getUint32(eocdOffset + 16, true);
    // The central directory entry's own compression-method field —
    // `readStoredZip` reads this one, not the local header's copy.
    view.setUint16(centralOffset + 10, 8, true);
    expect(() => readStoredZip(tampered)).toThrow();
  });
});
