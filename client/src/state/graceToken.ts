// ADR-0057 decision 6: this grace token lives only in memory here — never
// `sessionStorage`, never IndexedDB (contrast `tabSessions.ts`) — and is
// gone the instant this tab reloads.
//
// A copied profile, or this tab after a reload, still has everything
// decision 4 persists — the session keypair, the token — but not this
// value, so `sessions.rs` falls back to asking Site for a fresh code.
//
// Holds one token for one session at a time, set by `completeSignIn`'s
// steward branch and replaced by any later sign-in. `clearGraceToken` runs
// on sign-out so a stale token is never offered to whatever replaces it.

let heldToken: Uint8Array | null = null;
let heldForSessionId: string | null = null;

/** Record the grace token a steward sign-in's answer just minted, for the
 * account session it belongs to. */
export function setGraceToken(sessionId: string, token: Uint8Array): void {
  heldToken = token;
  heldForSessionId = sessionId;
}

/** The grace token held for `sessionId`, or an empty array if this tab
 * holds none for it (never held, held for a different session, or lost to
 * a reload). */
export function graceTokenFor(sessionId: string): Uint8Array {
  return heldForSessionId === sessionId && heldToken ? heldToken : new Uint8Array(0);
}

/** Forget the held token -- sign-out, and any moment this tab's account
 * session ends. */
export function clearGraceToken(): void {
  heldToken = null;
  heldForSessionId = null;
}
