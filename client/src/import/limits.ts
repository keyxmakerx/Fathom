// Caps for a file we did not write (round 9, the importer). Refused before the work is done.

export const LIMITS = {
  /** File size in bytes. */
  bytes: 5 * 1024 * 1024,
  /** Data rows (devices) in one file. Writing is linear per row in the size of the design, so
   * 2000 rows into a design of 1000 devices took about 35 s when measured; more is split into parts. */
  rows: 2000,
  columns: 100,
  /** Characters kept of one cell; the rest is cut before the redaction gate sees it. */
  cellChars: 4000,
  /** JSON nesting depth, and brackets plus commas in the whole file. */
  jsonDepth: 64,
  jsonTokens: 400_000,
  /** XML elements. */
  xmlElements: 50_000,
  /** A shared-field value (document/fields.ts refuses longer). */
  fieldChars: 1000,
} as const;

/** The file cannot be read for a reason the person can act on; the message is shown as is. */
export class ImportRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRefusal';
  }
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}
