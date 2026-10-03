// Files on a doc (ADR-0061 round 10) — `design_api.rs`'s `store_file_handler` and
// `read_file_handler`. The server sniffs the content and answers `{file_id} {media}\n`; a
// download is checked against the SHA-256 the design's graph holds before it is handed on.

import { signedFetchWithHeaders } from './signedFetch';

export type StoredFile = { fileId: string; media: 'text' | 'pdf' | 'image'; sha256: string };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const base = (o: string, d: string) => `/organisations/${encodeURIComponent(o)}/designs/${encodeURIComponent(d)}/files`;

/** Stores the bytes (already through the gate, for text). The server refuses a type it does not
 * recognise by content, a size over 25 MB, and text that still carries a password. */
export async function storeFile(organisationId: string, designId: string, bytes: Uint8Array): Promise<StoredFile> {
  const { bytes: reply } = await signedFetchWithHeaders('POST', base(organisationId, designId), bytes);
  const [fileId, media] = new TextDecoder().decode(reply).trim().split(' ');
  if (!fileId || !/^[0-9a-f]{32}$/.test(fileId) || (media !== 'text' && media !== 'pdf' && media !== 'image'))
    throw new Error('The server answered a file upload in a form this page does not know.');
  return { fileId, media, sha256: await sha256Hex(bytes) };
}

/** The stored bytes, or an error if they are not the ones the design says. */
export async function fetchFile(
  organisationId: string,
  designId: string,
  fileId: string,
  sha256: string,
): Promise<Uint8Array> {
  const { bytes } = await signedFetchWithHeaders(
    'GET',
    `${base(organisationId, designId)}/${encodeURIComponent(fileId)}`,
  );
  if ((await sha256Hex(bytes)) !== sha256) throw new Error('This file does not match what the design recorded.');
  return bytes;
}

/** Hands the bytes to the browser as a download; never opened inside Fathom. */
export function saveAsDownload(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Erases the stored bytes for good (Draw holders). Asking twice is not an error. */
export async function deleteFile(organisationId: string, designId: string, fileId: string): Promise<void> {
  await signedFetchWithHeaders('DELETE', `${base(organisationId, designId)}/${encodeURIComponent(fileId)}`);
}
