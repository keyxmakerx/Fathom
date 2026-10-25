// A folder of configs dropped on the canvas (round 29, card r29-pull A): what a backup playbook saved, one file per
// device. Each file goes through the same gate and reader as a paste (`previewPaste`, CLAUDE.md rule 4) and is matched
// to a drawn device by the hostname it names, or by its file name when it names none. The card lists every file and
// its outcome; nothing is written until the person presses Add, and then as one change in the history (ADR-0046).
//
// A device that already carries a config cannot take a second one until "replace a capture" exists (`capture.ts`), so
// such a file is compared instead: what the new copy has that the drawing's does not, read off the gate's output and
// never off the raw text. The texts are parameters, held only while the card is open, never stored or sent.

import { foldIntoOneBatch } from '../../document/bulk';
import { setDeviceField } from '../../document/edit';
import { deviceOf } from '../../document/portTies';
import { asString, fieldValue, findNode, type Document } from '../../document/model';
import type { PastePlatform } from '../../engine/frames';
import { refusalSentence, type Mirror } from '../../engine/mirror';
import { looksLikeFacts } from '../../document/facts';
import { looksLikeMacTable } from '../../document/hosts';
import { looksLikeNeighbours } from '../../document/neighbours';
import { devicePlatform, interfacesOf, platformChoices, previewPaste, sameNamed, worthReading, type PasteInterface } from './pasteConfig';

export interface FolderFile {
  name: string;
  text: string;
  /** Set when the file was too large to read; its text is then empty. */
  tooLarge?: boolean;
}

/** The most files one drop reads, and the largest one: a backup folder, not a disk. */
export const MAX_FILES = 200;
export const MAX_BYTES = 4 * 1024 * 1024;

/** What one file would change. `attach`: the first config of a drawn device. `add`: a device not drawn yet.
 * `compare`: the device already carries a config, so only what changed is said. `skip`: nothing Fathom will write. */
export type FolderOutcome = 'attach' | 'add' | 'compare' | 'skip';

export interface FolderChanges {
  added: string[];
  gone: string[];
  readdressed: string[];
  version: { was: string | null; now: string } | null;
}

export interface FolderRow {
  file: string;
  hostname: string;
  platform: string;
  outcome: FolderOutcome;
  /** The drawn device it attaches to or is compared with. */
  deviceId: string | null;
  /** Values the gate destroyed, counted; never the values. */
  destroyed: number;
  /** Set for `compare`. */
  changes: FolderChanges | null;
  /** Said under the row: why it is skipped, or what it matched by. */
  why: string | null;
  /** The platform the file was read as when its device named one; read the same way again on Add. */
  hint?: PastePlatform;
}

const stem = (file: string): string => (file.split('/').pop() ?? file).replace(/\.(conf|cfg|txt|xml|set|config)$/i, '');
const fold = (s: string): string => s.trim().toLowerCase();

function changesOf(doc: Document, deviceId: string, theirs: PasteInterface[], version: string | null): FolderChanges {
  const ours = new Map(interfacesOf(doc, deviceId).map((i) => [i.name, i.addresses.slice().sort().join(' ')]));
  const now = new Map(theirs.map((i) => [i.name, i.addresses.slice().sort().join(' ')]));
  const was = asString(fieldValue(findNode(doc, deviceId)?.fields ?? {}, 'Device.os_version')) ?? null;
  return {
    added: [...now.keys()].filter((n) => !ours.has(n)),
    gone: [...ours.keys()].filter((n) => !now.has(n)),
    readdressed: [...now].filter(([n, a]) => ours.has(n) && ours.get(n) !== a).map(([n]) => n),
    version: version !== null && version !== was ? { was, now: version } : null,
  };
}

export const changed = (c: FolderChanges): boolean => c.added.length + c.gone.length + c.readdressed.length > 0 || c.version !== null;

/** Why a file is not read as a config at all, or null when it may be one. */
function notAConfig(file: FolderFile): string | null {
  if (file.tooLarge === true || file.text.length > MAX_BYTES) return 'Too large to be a config.';
  if (file.text.includes('\u0000')) return 'Not a text file.';
  if (!worthReading(file.text)) return 'Empty, or a single line.';
  if (looksLikeNeighbours(file.text) || looksLikeMacTable(file.text) || looksLikeFacts(file.text)) return 'Not a config: paste it on its own to get its suggestions.';
  return null;
}

/** Every file read against `doc`, in file-name order. Leaves the module holding a scratch design. */
export function planFolder(mirror: Mirror, doc: Document, files: readonly FolderFile[]): FolderRow[] {
  const rows: FolderRow[] = [];
  const claimed = new Map<string, string>();
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).slice(0, MAX_FILES)) {
    const base: FolderRow = { file: file.name, hostname: '', platform: '', outcome: 'skip', deviceId: null, destroyed: 0, changes: null, why: null };
    const not = notAConfig(file);
    if (not !== null) {
      rows.push({ ...base, why: not });
      continue;
    }
    // A file with no hostname of its own may still be named after its device: the platform that device carries reads it.
    const byName = sameNamed(doc, stem(file.name));
    const hint = byName !== null && !byName.ambiguous ? (devicePlatform(doc, byName.deviceId) ?? undefined) : undefined;
    let preview;
    try {
      preview = previewPaste(mirror, doc, file.text, { x: 0, y: 0 }, undefined, hint);
    } catch (error) {
      rows.push({ ...base, why: platformChoices(error) !== null ? 'Fathom could not tell which kind of device this is from. Paste it on its own to choose.' : refusalSentence(error) });
      continue;
    }
    const destroyed = preview.destroyed.reduce((n, d) => n + d.count, 0);
    const named = preview.hostname !== '' ? preview.hostname : stem(file.name);
    const match = preview.hostname !== '' ? preview.match : byName;
    const row: FolderRow = { ...base, hostname: named, platform: preview.platform, destroyed, ...(hint !== undefined ? { hint } : {}) };
    const first = claimed.get(fold(named));
    if (first !== undefined) {
      rows.push({ ...row, why: `${first} already names ${named}; only that one is read.` });
      continue;
    }
    claimed.set(fold(named), file.name);
    if (match?.ambiguous) rows.push({ ...row, why: `More than one drawn device is called ${named}. Paste it into the right one.` });
    else if (match === null) rows.push({ ...row, outcome: 'add', why: preview.hostname === '' ? 'It names no hostname, so the new device takes the file name.' : null });
    else if (match.hasCapture) rows.push({ ...row, outcome: 'compare', deviceId: match.deviceId, changes: changesOf(doc, match.deviceId, preview.interfaces, preview.osVersion) });
    else rows.push({ ...row, outcome: 'attach', deviceId: match.deviceId, why: preview.hostname === '' ? 'Matched by its file name.' : null });
  }
  return rows;
}

/**
 * The ticked rows written onto `doc` as one change. `files` are the same files `planFolder` read; `spots` gives
 * where each new device sits. Returns `doc` itself when nothing was written. Leaves the module holding the result.
 */
export function applyFolder(
  mirror: Mirror,
  doc: Document,
  files: readonly FolderFile[],
  rows: readonly FolderRow[],
  spots: (n: number) => { x: number; y: number }[],
  opts?: { actor?: string; now?: number },
): Document {
  const text = new Map(files.map((f) => [f.name, f.text]));
  const adds = rows.filter((r) => r.outcome === 'add');
  const at = spots(adds.length);
  const from = doc.batches.length;
  let working = doc;
  for (const row of rows) {
    const t = text.get(row.file);
    if (t === undefined) continue;
    if (row.outcome === 'attach' && row.deviceId !== null) {
      mirror.load(working);
      working = mirror.pasteInto(row.deviceId, t, devicePlatform(working, row.deviceId) ?? row.hint).doc;
    } else if (row.outcome === 'add') {
      const p = previewPaste(mirror, working, t, at[adds.indexOf(row)] ?? { x: 0, y: 0 }, opts, row.hint);
      working = p.addDoc;
      // A file that names no hostname gives the new device its file name.
      const made = deviceOf(working, p.addChassisId);
      if (p.hostname === '' && made !== null) working = setDeviceField(working, made, 'hostname', row.hostname, opts);
    }
  }
  return working.batches.length === from ? doc : foldIntoOneBatch(working, from, 'configs from a folder');
}

// ---------------------------------------------------------------------------
// Reading a drop

/** True when a drag carries files, so the canvas may take the drop. */
export const dragHasFiles = (dt: DataTransfer | null): boolean => dt !== null && [...dt.types].includes('Files');

async function walk(entry: FileSystemEntry, out: File[], names: Map<File, string>): Promise<void> {
  if (out.length >= MAX_FILES) return;
  if (entry.isFile) {
    const f = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
    out.push(f);
    names.set(f, entry.fullPath.replace(/^\//, ''));
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // A directory reader hands entries over in pages until it hands over none.
    for (;;) {
      const page = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (page.length === 0) break;
      for (const e of page) await walk(e, out, names);
    }
  }
}

/** The text files a drop carries, folders opened. A file too large is kept with no text, so the card can say why. */
export async function filesFromDrop(dt: DataTransfer): Promise<FolderFile[]> {
  const files: File[] = [];
  const names = new Map<File, string>();
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.() ?? null).filter((e): e is FileSystemEntry => e !== null);
  if (entries.length > 0) for (const e of entries) await walk(e, files, names);
  else files.push(...[...dt.files].slice(0, MAX_FILES));
  return Promise.all(
    files.map(async (f) => (f.size > MAX_BYTES ? { name: names.get(f) ?? f.name, text: '', tooLarge: true } : { name: names.get(f) ?? f.name, text: await f.text() })),
  );
}
