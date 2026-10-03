// Small readers for the canonical-JSON answers the People and invitation
// routes give. Each throws a plain `Error` (never an `ApiRefusal`, which is
// reserved for what the server itself refused) naming the field that is wrong.

export type Rec = Record<string, unknown>;

export function jsonObject(bytes: Uint8Array, what: string): Rec {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Rec;
  } catch {
    // falls through to the one error below
  }
  throw new Error(`malformed ${what} response`);
}

export function asRec(value: unknown, what: string): Rec {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Rec;
  throw new Error(`malformed ${what} response`);
}

export function arrayOf(rec: Rec, key: string, what: string): unknown[] {
  const value = rec[key];
  if (Array.isArray(value)) return value;
  throw new Error(`malformed ${what} response: no ${key}`);
}

export function str(rec: Rec, key: string, what: string): string {
  const value = rec[key];
  if (typeof value === 'string') return value;
  throw new Error(`malformed ${what} response: no ${key}`);
}

export function optStr(rec: Rec, key: string, what: string): string | null {
  const value = rec[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new Error(`malformed ${what} response: bad ${key}`);
}

export function int(rec: Rec, key: string, what: string): number {
  const value = rec[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new Error(`malformed ${what} response: no ${key}`);
}

export function optInt(rec: Rec, key: string, what: string): number | null {
  const value = rec[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new Error(`malformed ${what} response: bad ${key}`);
}

export function bool(rec: Rec, key: string, what: string): boolean {
  const value = rec[key];
  if (typeof value === 'boolean') return value;
  throw new Error(`malformed ${what} response: no ${key}`);
}

export function oneOf<T extends string>(rec: Rec, key: string, allowed: readonly T[], what: string): T {
  const value = rec[key];
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`malformed ${what} response: bad ${key}`);
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
