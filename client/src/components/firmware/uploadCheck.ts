// What the Upload form can check before anything is sent. The server checks all of it again.

import { FIRMWARE_PLATFORMS } from '../../document/firmwareVersion';
import { cleanSha256, cleanVersion, FirmwareRefusal } from '../../document/firmware';

/** `safe_filename` in firmware.rs: letters, digits, dot, dash, underscore; no leading dot; 255 at most. */
export function safeFilename(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith('.') && /^[A-Za-z0-9._-]+$/.test(name);
}

export interface UploadInput {
  filename: string;
  size: number;
  platform: string;
  version: string;
  sha256: string;
}

export interface UploadChecked {
  filename: string;
  byteLength: number;
  platform: string;
  version: string;
  sha256: string;
}

/** The first thing wrong, in words; otherwise the cleaned values. */
export function checkUpload(i: UploadInput): { problem: string } | { ok: UploadChecked } {
  if (i.filename === '') return { problem: 'Choose the image file.' };
  if (i.size === 0) return { problem: 'That file is empty.' };
  if (!safeFilename(i.filename)) {
    return { problem: 'Fathom keeps file names with letters, digits, dot, dash and underscore only, and none starting with a dot. Rename the file and choose it again.' };
  }
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
  return { ok: { filename: i.filename, byteLength: i.size, platform: i.platform, version, sha256 } };
}
