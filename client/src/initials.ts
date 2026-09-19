/**
 * The two-letter mark in the bar's 24x24 account square.
 *
 * Derived from the address because that is the only thing about a person
 * this client is told. There is no endpoint that gives a display name to a
 * signed-in account today, and inventing one would be exactly the
 * plausible-looking value `docs/decisions/adr-0046-two-places-one-editor-and-an-undo-that-records.md`
 * forbids. When such an endpoint exists, the caller passes the real initials
 * and this helper stops being used.
 */
export function initialsFromAddress(address: string): string {
  const local = address.split('@')[0] ?? '';
  // Split on anything that is not a letter or a digit: `rowan.k`,
  // `rowan_k`, `rowan-k` and `rowan+tag` all read the same way.
  const parts = local.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 0);

  if (parts.length === 0) {
    // An address with no letters or digits before the `@` is not worth
    // guessing at. A single dash is honest; two invented letters are not.
    return '–';
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
