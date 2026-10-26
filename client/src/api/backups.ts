// The Backups panel's one call: `crates/fathom-server/src/backup_status.rs`'s
// `GET /admin/backups`, operators only (ADR-0070). The server only reads what
// the nightly service wrote into the backups volume; nothing here can make,
// copy or restore a backup, and no key or phrase ever passes through it.

import { readLp } from '../crypto/bytes';
import { signedFetch } from './signedFetch';

export interface BackupFile {
  name: string;
  bytes: number;
}

export interface BackupStatus {
  /** The service's `status` file, `name value` lines; empty when it has not
   * reported. Missing values are absent, never `-`. */
  status: Record<string, string>;
  /** The key ids the last keys file was made with, or empty: none made. */
  keysFile: Record<string, string>;
  /** The key ids this server holds now. */
  current: Record<string, string>;
  /** Newest first. */
  files: BackupFile[];
  /** One sentence each, in the operator's register; empty when all is well. */
  notices: string[];
}

/** `name value` lines to a map. A value of `-` means "none" and is dropped. */
export function parseFields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const value = line.slice(space + 1).trim();
    if (value && value !== '-') out[line.slice(0, space)] = value;
  }
  return out;
}

/** `LP(status) ‖ LP(keys-file record) ‖ LP(current ids) ‖ LP(files) ‖ LP(notices)`. */
export function parseBackupStatus(bytes: Uint8Array): BackupStatus {
  const decoder = new TextDecoder();
  const fields: string[] = [];
  let rest = bytes;
  for (let i = 0; i < 5; i++) {
    const read = readLp(rest);
    fields.push(decoder.decode(read.value));
    rest = read.rest;
  }
  if (rest.length !== 0) {
    throw new Error(`malformed backups answer: ${rest.length} trailing byte(s)`);
  }
  const [status, keysFile, current, listing, notices] = fields;
  const files: BackupFile[] = [];
  for (const line of listing.split('\n')) {
    const [name, size] = line.trim().split(/\s+/);
    if (name && size !== undefined) files.push({ name, bytes: Number(size) });
  }
  return {
    status: parseFields(status),
    keysFile: parseFields(keysFile),
    current: parseFields(current),
    files,
    notices: notices.split('\n').filter((l) => l.trim() !== ''),
  };
}

export async function fetchBackupStatus(): Promise<BackupStatus> {
  return parseBackupStatus(await signedFetch('GET', '/admin/backups'));
}
