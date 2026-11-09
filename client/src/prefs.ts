// What this browser remembers for the person: view choices, panel widths, recent designs. Every
// read and write here is best effort. A private window or blocked storage throws on access, and a
// remembered choice is never worth an error, so a refused read gives the caller's default and a
// refused write means the choice lasts until the page closes.

/** The stored text, or null when there is none or storage is refused. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store `value`, or forget the key when it is null. */
export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}

/** The stored JSON read through `parse`, or `fallback` when there is none, it is damaged, or
 *  storage is refused. `parse` throwing counts as damaged. */
export function loadJsonPref<T>(key: string, parse: (raw: unknown) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) return parse(JSON.parse(raw));
  } catch {
    // storage unavailable or damaged
  }
  return fallback;
}

/** Store `value` as JSON. */
export function saveJsonPref(key: string, value: unknown): void {
  writePref(key, JSON.stringify(value));
}

/** Forget every stored key that starts with `prefix`. Used at sign-out for what names other people. */
export function forgetPrefsStartingWith(prefix: string): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // storage refused; nothing was kept either
  }
}
