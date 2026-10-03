// A design's saves and the server's check of them. Shapes read off `history_handler` and
// `json_of_report` in `crates/fathom-server/src/design_api.rs`. A past version's bytes come
// from `openDesign(org, design, version)`.

import { signedFetch } from './signedFetch';

export interface HistoryEntry {
  seq: number;
  entryType: string;
  /** The version this entry wrote; every entry has one. */
  designVersion: number;
  atUnix: number;
  /** The account that saved; `null` when the entry's metadata would not read. */
  actor: string | null;
}

export type VerifyOutcome =
  | { kind: 'verified'; entries: number }
  | { kind: 'broken'; save: number }
  | { kind: 'old-key' };

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`malformed history response: ${label} is not an object`);
  return value as Record<string, unknown>;
}

export function parseHistory(bytes: Uint8Array): HistoryEntry[] {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(parsed)) throw new Error('malformed history response: not an array');
  return parsed.map((raw, i) => {
    const r = record(raw, `entry ${i}`);
    if (typeof r.seq !== 'number' || typeof r.design_version !== 'number' || typeof r.at_unix !== 'number') {
      throw new Error(`malformed history response: entry ${i} has no seq, design_version or at_unix`);
    }
    return {
      seq: r.seq,
      entryType: typeof r.entry_type === 'string' ? r.entry_type : 'update',
      designVersion: r.design_version,
      atUnix: r.at_unix,
      actor: typeof r.actor === 'string' ? r.actor : null,
    };
  });
}

export function parseVerify(bytes: Uint8Array): VerifyOutcome {
  const r = record(JSON.parse(new TextDecoder().decode(bytes)), 'the report');
  if (r.outcome === 'verified') return { kind: 'verified', entries: typeof r.entries === 'number' ? r.entries : 0 };
  if (r.outcome === 'broken_at') {
    const save = typeof r.design_version === 'number' ? r.design_version : r.seq;
    if (typeof save !== 'number') throw new Error('malformed verify response: broken_at names no save');
    return { kind: 'broken', save };
  }
  if (r.outcome === 'cannot_verify_under_key_epoch') return { kind: 'old-key' };
  throw new Error('malformed verify response: unknown outcome');
}

/** The top line of the panel. Plain words, never a colour. */
export function verifyWords(outcome: VerifyOutcome): string {
  switch (outcome.kind) {
    case 'verified':
      return 'Checked: every save is intact';
    case 'broken':
      return `Broken at save ${outcome.save}`;
    case 'old-key':
      return "Can't be checked under an old key";
  }
}

const base = (organisationId: string, designId: string) =>
  `/organisations/${encodeURIComponent(organisationId)}/designs/${encodeURIComponent(designId)}`;

export async function fetchHistory(organisationId: string, designId: string): Promise<HistoryEntry[]> {
  return parseHistory(await signedFetch('GET', `${base(organisationId, designId)}/history`));
}

export async function fetchVerify(organisationId: string, designId: string): Promise<VerifyOutcome> {
  return parseVerify(await signedFetch('GET', `${base(organisationId, designId)}/verify`));
}
