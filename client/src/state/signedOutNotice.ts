// ADR-0057 decision 8: the line a tab shows when its session died elsewhere,
// set by `signedFetch.ts`, read once by `App.tsx`. Per-tab, not a broadcast:
// a tab making no further request learns instead via `tabSessions.ts`.

let pending = false;

export function markSignedOutElsewhere(): void {
  pending = true;
}

/** Reads and clears the flag in one step, so a door drawn twice in a row
 * says it once. */
export function takeSignedOutNotice(): boolean {
  const was = pending;
  pending = false;
  return was;
}
