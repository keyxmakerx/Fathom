import { describe, expect, it } from 'vitest';

import { cleanExportText } from './textClean';

describe('cleanExportText', () => {
  it('keeps tab, LF and CR', () => {
    expect(cleanExportText('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('drops C0 controls other than tab/LF/CR', () => {
    expect(cleanExportText('a\u0000b\u0001c\u001fd')).toBe('abcd');
  });

  it('drops U+FFFE and U+FFFF', () => {
    expect(cleanExportText('a￾b￿c')).toBe('abc');
  });

  it('drops a lone high surrogate', () => {
    expect(cleanExportText('a\uD800b')).toBe('ab');
  });

  it('drops a lone low surrogate', () => {
    expect(cleanExportText('a\uDC00b')).toBe('ab');
  });

  it('keeps a properly paired surrogate (a real supplementary character)', () => {
    const emoji = '😀'; // U+1F600, a valid pair
    expect(cleanExportText(`x${emoji}y`)).toBe(`x${emoji}y`);
  });

  it('cuts a cell at 32,767 characters', () => {
    const long = 'a'.repeat(40_000);
    const cleaned = cleanExportText(long);
    expect(cleaned.length).toBe(32_767);
  });

  it('never splits a surrogate pair at the cut point', () => {
    const pair = '😀';
    const long = 'a'.repeat(32_766) + pair; // the pair would straddle 32767/32768
    const cleaned = cleanExportText(long);
    expect(cleaned.length).toBe(32_766); // the pair is cut whole, not split
    expect(cleaned).toBe('a'.repeat(32_766));
  });
});
