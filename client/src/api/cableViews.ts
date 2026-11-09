// A person's own Cables list for one design, on the server (migration 0076, sign-off r111).
// Sealed under the organisation content key; only its owner reads or writes it.

import { body } from './fieldDefinitions';
import { signedFetch } from './signedFetch';

const path = (organisationId: string, designId: string): string =>
  `/organisations/${encodeURIComponent(organisationId)}/designs/${encodeURIComponent(designId)}/cable-view`;

/** The stored state as the server sent it, unchecked (the caller validates), or `null` when none is saved. */
export async function fetchCableView(organisationId: string, designId: string): Promise<unknown> {
  const bytes = await signedFetch('GET', path(organisationId, designId));
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('malformed cable-view response: body is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || !('view' in parsed)) throw new Error('malformed cable-view response');
  return (parsed as { view: unknown }).view;
}

/** Replaces the whole stored state. Last write wins. */
export async function putCableView(organisationId: string, designId: string, view: unknown): Promise<void> {
  await signedFetch('PUT', path(organisationId, designId), body({ view }));
}
