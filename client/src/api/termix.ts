// The operator's Termix (ADR-0078): `GET /integrations/termix`, `design_api.rs`'s
// `termix_handler`. `{"url": <origin> | null}`; null when `FATHOM_TERMIX_URL` is unset.

import { jsonObject, optStr } from './json';
import { signedFetch } from './signedFetch';

const WHAT = 'termix';

export function parseTermixUrl(bytes: Uint8Array): string | null {
  return optStr(jsonObject(bytes, WHAT), 'url', WHAT);
}

let asked: Promise<string | null> | null = null;

/** Asked once per page: the operator's setting does not change while the server runs. */
export function fetchTermixUrl(): Promise<string | null> {
  asked ??= signedFetch('GET', '/integrations/termix').then(parseTermixUrl, (e: unknown) => {
    asked = null;
    throw e;
  });
  return asked;
}
