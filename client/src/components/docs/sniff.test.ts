import { describe, expect, it } from 'vitest';
import { sniffFile } from './sniff';

const b = (...x: number[]) => new Uint8Array(x);
const t = (s: string) => new TextEncoder().encode(s);

describe('sniffFile', () => {
  it('goes by content, not name', () => {
    expect(sniffFile(t('%PDF-1.7\n'))).toBe('pdf');
    expect(sniffFile(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image');
    expect(sniffFile(b(0xff, 0xd8, 0xff, 0xe0))).toBe('image');
    expect(sniffFile(t('set system host-name a\n\tindented\r\n'))).toBe('text');
  });
  it('refuses empty, binary and invalid UTF-8', () => {
    expect(sniffFile(b())).toBe('refused');
    expect(sniffFile(b(0x4d, 0x5a, 0x90, 0x00, 0x03))).toBe('refused');
    expect(sniffFile(b(0x50, 0x4b, 0x03, 0x04, 0x00))).toBe('refused');
    expect(sniffFile(b(0xc3, 0x28))).toBe('refused');
  });
});
