// ADR-0057 decision 4: a session is cleared the moment it passes its
// `expiresAtUnix` — the absolute limit, or a server-enacted idle death —
// rather than waiting for a click to hit `401`.
//
// One timer per plane, resynced on every `sessionState.ts` change.

import { clearGraceToken } from './graceToken';
import { ACCOUNT_PLANE, clearPlane, heldSessions, OPERATOR_PLANE, subscribe, type Plane } from './sessionState';
import { clearAccountSession, thisTabId } from './tabSessions';

const PLANES: Plane[] = [ACCOUNT_PLANE, OPERATOR_PLANE];

const timers: Partial<Record<Plane, ReturnType<typeof setTimeout>>> = {};

function clearTimer(plane: Plane): void {
  const timer = timers[plane];
  if (timer !== undefined) {
    clearTimeout(timer);
    delete timers[plane];
  }
}

function fire(plane: Plane): void {
  clearPlane(plane);
  if (plane === ACCOUNT_PLANE) {
    void clearAccountSession(thisTabId());
    clearGraceToken();
  }
}

function schedule(plane: Plane, expiresAtUnix: number): void {
  clearTimer(plane);
  const delayMs = expiresAtUnix * 1000 - Date.now();
  // `setTimeout`'s bound (~24.8 days as a signed 32-bit ms count) is wider
  // than `SESSION_LIFETIME` ever is, so no session outlives it; a negative
  // delay -- already past -- fires on the next tick, immediately.
  timers[plane] = setTimeout(() => fire(plane), Math.max(0, delayMs));
}

let installed = false;

function resync(): void {
  for (const plane of PLANES) {
    const held = heldSessions().find((h) => h.plane === plane);
    if (held) {
      schedule(plane, held.session.expiresAtUnix);
    } else {
      clearTimer(plane);
    }
  }
}

/**
 * Start watching every held session's expiry. Idempotent — call this once,
 * at startup (`App.tsx`); a second call does nothing, so a component that
 * remounts in a test never doubles the timers.
 */
export function installExpiryTimers(): void {
  if (installed) return;
  installed = true;
  subscribe(resync);
  resync();
}
