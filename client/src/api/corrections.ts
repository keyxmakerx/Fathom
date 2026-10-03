// Cable corrections from the floor. Anyone who can read a design sends one about a cable
// ("traced", "label wrong", "not here"); someone who can draw accepts or dismisses it. A
// correction is its own server record, never part of the design. Bodies are canonical JSON.

import { body } from './fieldDefinitions';
import { signedFetch } from './signedFetch';

export const CORRECTION_KINDS = ['traced', 'label', 'not_here'] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
export type CorrectionState = 'open' | 'accepted' | 'dismissed';

export interface CorrectionView {
  id: string;
  cable: string;
  kind: CorrectionKind;
  /** What the sender typed: the proposed label, or where the cable is. Empty for "traced". */
  text: string;
  sender: string;
  senderName: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  state: CorrectionState;
  decidedBy: string | null;
  decidedAt: number | null;
  version: number;
}

const base = (organisationId: string, designId: string): string =>
  `/organisations/${encodeURIComponent(organisationId)}/designs/${encodeURIComponent(designId)}/corrections`;

function parseOne(raw: unknown): CorrectionView {
  const o = (raw ?? {}) as Record<string, unknown>;
  const kind = o.kind as CorrectionKind;
  const state = o.state as CorrectionState;
  if (
    typeof o.id !== 'string' ||
    typeof o.cable !== 'string' ||
    !CORRECTION_KINDS.includes(kind) ||
    (state !== 'open' && state !== 'accepted' && state !== 'dismissed') ||
    typeof o.sender !== 'string' ||
    typeof o.createdAt !== 'number' ||
    typeof o.version !== 'number'
  ) {
    throw new Error('malformed correction in the response');
  }
  return {
    id: o.id,
    cable: o.cable,
    kind,
    text: typeof o.text === 'string' ? o.text : '',
    sender: o.sender,
    senderName: typeof o.senderName === 'string' && o.senderName !== '' ? o.senderName : 'Someone',
    createdAt: o.createdAt,
    state,
    decidedBy: typeof o.decidedBy === 'string' ? o.decidedBy : null,
    decidedAt: typeof o.decidedAt === 'number' ? o.decidedAt : null,
    version: o.version,
  };
}

function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('malformed correction response: body is not JSON');
  }
}

/** A draw reader gets every open correction (and recent decisions); a read-only one gets their own. */
export async function fetchCorrections(organisationId: string, designId: string): Promise<CorrectionView[]> {
  const list = parse(await signedFetch('GET', base(organisationId, designId)));
  if (!Array.isArray(list)) throw new Error('malformed correction list');
  return list.map(parseOne);
}

export async function sendCorrection(
  organisationId: string,
  designId: string,
  correction: { cable: string; kind: CorrectionKind; text?: string },
): Promise<CorrectionView> {
  return parseOne(parse(await signedFetch('POST', base(organisationId, designId), body(correction))));
}

/** Accepts, dismisses, or (an accepted one whose edit failed) reopens a correction. The edit an
 * acceptance makes is the caller's own. A dismissal scrubs the text on the server. */
export async function decideCorrection(
  organisationId: string,
  designId: string,
  correction: Pick<CorrectionView, 'id' | 'version'>,
  verb: 'accept' | 'dismiss' | 'reopen',
): Promise<CorrectionView> {
  const path = `${base(organisationId, designId)}/${encodeURIComponent(correction.id)}/${verb}`;
  return parseOne(parse(await signedFetch('POST', path, body({ ifVersion: correction.version }))));
}
