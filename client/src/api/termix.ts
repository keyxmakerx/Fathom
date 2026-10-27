// The operator's Termix for this person in one organisation (ADR-0078): `GET
// /organisations/{o}/termix`, `design_api.rs`'s `termix_handler`. `{"url": <origin> | null,
// "off": null | "everyone" | "you"}`. `url` is null when `FATHOM_TERMIX_URL` is unset, and when a
// steward turned Termix off here (decision 6); `off` says for whom.

import { jsonObject, optStr } from './json';
import { signedFetch } from './signedFetch';

const WHAT = 'termix';

export type TermixOff = 'everyone' | 'you';

export interface TermixAccess {
  url: string | null;
  off: TermixOff | null;
}

export function parseTermixAccess(bytes: Uint8Array): TermixAccess {
  const r = jsonObject(bytes, WHAT);
  const off = r.off === 'everyone' || r.off === 'you' ? r.off : null;
  return { url: off ? null : optStr(r, 'url', WHAT), off };
}

const asked = new Map<string, Promise<TermixAccess>>();

/** Asked once per organisation per page; a steward's change shows on the next load. */
export function fetchTermixAccess(organisation: string): Promise<TermixAccess> {
  let p = asked.get(organisation);
  if (!p) {
    p = signedFetch('GET', `/organisations/${encodeURIComponent(organisation)}/termix`).then(parseTermixAccess, (e: unknown) => {
      asked.delete(organisation);
      throw e;
    });
    asked.set(organisation, p);
  }
  return p;
}

/** A steward turns Termix off, or back on, for everyone here (`account` null) or for one person. */
export async function setTermixOff(organisation: string, account: string | null, off: boolean): Promise<boolean> {
  const o = encodeURIComponent(organisation);
  const path = account === null ? `/organisations/${o}/termix` : `/organisations/${o}/people/${encodeURIComponent(account)}/termix`;
  const bytes = await signedFetch('POST', path, new TextEncoder().encode(`{"off":${off}}\n`));
  asked.delete(organisation);
  const answer = JSON.parse(new TextDecoder().decode(bytes)) as { termix_off?: unknown };
  return answer.termix_off === true;
}
