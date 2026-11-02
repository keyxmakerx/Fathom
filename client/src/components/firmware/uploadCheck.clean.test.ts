import { describe, expect, it } from 'vitest';

import { checkUpload, cleanFilename, renamedFromOf, safeFilename } from './uploadCheck';

describe('cleanFilename', () => {
  const cases: [string, string][] = [
    ['junos-install-23.4R2.tgz', 'junos-install-23.4R2.tgz'],
    ['junos install (1).tgz', 'junos_install_1_.tgz'],
    ['cat9k_iosxe.17.09.04a.SPA copy.bin', 'cat9k_iosxe.17.09.04a.SPA_copy.bin'],
    ['.hidden.bin', 'hidden.bin'],
    ['...', 'firmware'],
    ['日本.bin', 'firmware.bin'],
    ['café-ñ.img', 'cafe-n.img'],
    ['a/b\\c.swi', 'a_b_c.swi'],
    ['a\u0000b.bin', 'a_b.bin'],
  ];
  for (const [from, to] of cases) {
    it(`${JSON.stringify(from)} becomes ${to}`, () => {
      expect(cleanFilename(from)).toBe(to);
      expect(safeFilename(cleanFilename(from))).toBe(true);
    });
  }

  it('cuts a long name to 255 and keeps the extension', () => {
    const out = cleanFilename(`${'x y'.repeat(200)}.tgz`);
    expect(out.length).toBe(255);
    expect(out.endsWith('.tgz')).toBe(true);
    expect(safeFilename(out)).toBe(true);
  });
});

describe('checkUpload renames instead of refusing', () => {
  const base = { size: 10, platform: 'junos-ex', version: '23.4R2', sha256: 'a'.repeat(64) };
  it('keeps the cleaned name and the original', () => {
    const got = checkUpload({ ...base, filename: 'junos install.tgz' });
    expect('ok' in got && got.ok.filename).toBe('junos_install.tgz');
    expect('ok' in got && got.ok.renamedFrom).toBe('junos install.tgz');
  });
  it('sends no original when nothing changed', () => {
    const got = checkUpload({ ...base, filename: 'junos.tgz' });
    expect('ok' in got && got.ok.renamedFrom).toBeNull();
  });
});

describe('renamedFromOf', () => {
  it('shows control characters as ? and keeps it to 1024 bytes without cutting a character', () => {
    expect(renamedFromOf('a\nb', 'a_b')).toBe('a?b');
    const long = renamedFromOf('é'.repeat(600), 'x')!;
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(1024);
    expect(long).toBe('é'.repeat(512));
  });
});

describe('RenameNote', () => {
  it('shows the name it will be kept under, and nothing for a name already safe', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { RenameNote } = await import('./UploadForm');
    expect(renderToStaticMarkup(createElement(RenameNote, { name: 'junos install.tgz' }))).toContain('Saved as <span class="fw-mono">junos_install.tgz</span>');
    expect(renderToStaticMarkup(createElement(RenameNote, { name: 'junos.tgz' }))).toBe('');
  });
});
