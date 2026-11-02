// What the Upload form can check before anything is sent. The server checks all of it again.

import { FIRMWARE_PLATFORMS } from '../../document/firmwareVersion';
import { cleanSha256, cleanVersion, FirmwareRefusal } from '../../document/firmware';

/** `safe_filename` in firmware.rs: letters, digits, dot, dash, underscore; no leading dot; 255 at most. */
export function safeFilename(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith('.') && /^[A-Za-z0-9._-]+$/.test(name);
}

/** The longest original name sent along (`RENAMED_FROM_MAX` in firmware.rs). */
export const RENAMED_FROM_MAX = 1024;

/**
 * A name `safeFilename` accepts, made from `name`: accents dropped (é to e), every run of other
 * characters to one `_`, leading dots removed, and the extension kept when the name is cut to 255.
 * A name already safe comes back unchanged.
 */
export function cleanFilename(name: string): string {
  if (safeFilename(name)) return name;
  let out = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '');
  // A name with nothing readable before its extension ("日本.bin" is "_.bin" by now) is called firmware.
  const dot = out.lastIndexOf('.');
  if (!/[A-Za-z0-9]/.test(dot >= 0 ? out.slice(0, dot) : out)) out = `firmware${dot >= 0 ? out.slice(dot) : ''}`;
  if (out.length > 255) {
    const at = out.lastIndexOf('.');
    const ext = at > 0 && out.length - at <= 16 ? out.slice(at) : '';
    out = out.slice(0, 255 - ext.length) + ext;
  }
  return out;
}

export interface UploadInput {
  filename: string;
  size: number;
  platform: string;
  version: string;
  sha256: string;
}

export interface UploadChecked {
  /** The name it is kept under: `cleanFilename` of the file's own. */
  filename: string;
  /** The file's own name, when Fathom changed it; sent so the history keeps it. */
  renamedFrom: string | null;
  byteLength: number;
  platform: string;
  version: string;
  sha256: string;
}

/** The first thing wrong, in words; otherwise the cleaned values. */
export function checkUpload(i: UploadInput): { problem: string } | { ok: UploadChecked } {
  if (i.filename === '') return { problem: 'Choose the image file.' };
  if (i.size === 0) return { problem: 'That file is empty.' };
  const filename = cleanFilename(i.filename);
  if (!FIRMWARE_PLATFORMS.some((p) => p.id === i.platform)) return { problem: 'Pick the platform this image is for.' };
  let version: string;
  try {
    version = cleanVersion(i.version);
  } catch (e) {
    return { problem: e instanceof FirmwareRefusal ? e.message : 'Give the version.' };
  }
  if (i.sha256.trim() === '') return { problem: "Paste the SHA-256 from the vendor's download page. Fathom checks the file against it." };
  const sha256 = cleanSha256(i.sha256);
  if (sha256 === null) return { problem: 'A SHA-256 is 64 hexadecimal characters. Paste it as the vendor shows it.' };
  return { ok: { filename, renamedFrom: renamedFromOf(i.filename, filename), byteLength: i.size, platform: i.platform, version, sha256 } };
}

/** The original name to keep, or null when nothing changed. Cut to `RENAMED_FROM_MAX` bytes' worth
 * of characters, never through a character, and with control characters shown as `?`. */
export function renamedFromOf(original: string, kept: string): string | null {
  if (original === kept) return null;
  // eslint-disable-next-line no-control-regex
  let out = original.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  const enc = new TextEncoder();
  while (enc.encode(out).length > RENAMED_FROM_MAX) out = Array.from(out).slice(0, -1).join('');
  return out;
}
