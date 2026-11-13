/** A download with no server round trip. The object URL is revoked a few seconds later, not straight
 * away: read too soon, a browser saves an empty file. */
export function downloadBytes(filename: string, bytes: Uint8Array, mime: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
