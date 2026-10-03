// What a file is, by its content and never its name. The server decides again on what it receives.

export type Sniffed = 'text' | 'pdf' | 'image' | 'refused';

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

export function sniffFile(b: Uint8Array): Sniffed {
  if (b.length === 0) return 'refused';
  if (starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (
    starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    starts(b, [0xff, 0xd8, 0xff]) ||
    starts(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    starts(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) ||
    (starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8))
  )
    return 'image';
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(b);
    // eslint-disable-next-line no-control-regex
    return /[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(t) ? 'refused' : 'text';
  } catch {
    return 'refused';
  }
}
