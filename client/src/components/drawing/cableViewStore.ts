// Where a person's Cables list is kept (sign-off r114). With an organisation it is on the server,
// one per person per design, sealed (`api/cableViews.ts`, migration 0076); this module holds the
// latest copy in memory so switching back to a design draws at once, and sends saves a moment
// after the last click. A list this browser kept before then is sent up the first time the design
// opens, and the browser copy cleared; when the server already has one, the server's wins. With
// no organisation, or when the server cannot be reached, the browser store in `cableGroups.ts`
// is used as before.

import { fetchCableView, putCableView } from '../../api/cableViews';
import { writePref } from '../../prefs';
import { cableGroupsStorageKey, isStoredCableGroupsState, loadCableGroupsState, saveCableGroupsState, type StoredCableGroupsState } from './cableGroups';
import { ACCOUNT_PLANE, getSessionOn, subscribe as subscribeSession } from '../../state/sessionState';

const SAVE_AFTER_MS = 600;
const RETRY_AFTER_MS = 5000;

const memory = new Map<string, StoredCableGroupsState>();
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; send: () => void }>();

const keyOf = (organisationId: string, designId: string): string => `${organisationId}/${designId}`;

/** What can be drawn right now, before any answer from the server: the memory copy, or with no
 * organisation the browser's. `null` when nothing is known yet. */
export function peekCableView(organisationId: string | null, designId: string): StoredCableGroupsState | null {
  if (organisationId === null) return loadCableGroupsState(designId);
  return memory.get(keyOf(organisationId, designId)) ?? null;
}

export interface LoadedCableView {
  state: StoredCableGroupsState | null;
  /** True when later saves go to the server; false when it could not be reached. */
  server: boolean;
}

/** Reads the person's list from the server, moving the browser's copy up when the server has none. */
export async function loadCableView(organisationId: string, designId: string): Promise<LoadedCableView> {
  const key = keyOf(organisationId, designId);
  let raw: unknown;
  try {
    raw = await fetchCableView(organisationId, designId);
  } catch {
    return { state: loadCableGroupsState(designId), server: false };
  }
  // A save still waiting to go is newer than what the server holds.
  const waiting = pending.has(key) ? memory.get(key) : undefined;
  if (waiting) return { state: waiting, server: true };
  const local = loadCableGroupsState(designId);
  if (isStoredCableGroupsState(raw)) {
    memory.set(key, raw);
    if (local) writePref(cableGroupsStorageKey(designId), null);
    return { state: raw, server: true };
  }
  if (local) {
    try {
      await putCableView(organisationId, designId, local);
    } catch {
      // Not moved yet: keep the browser copy and try again next time the design opens.
      return { state: local, server: false };
    }
    writePref(cableGroupsStorageKey(designId), null);
    memory.set(key, local);
    return { state: local, server: true };
  }
  return { state: null, server: true };
}

/** Saves the list: on the server a moment after the last change (`server`), else in this browser. */
export function storeCableView(organisationId: string | null, designId: string, state: StoredCableGroupsState, server: boolean): void {
  if (organisationId === null || !server) {
    saveCableGroupsState(designId, state);
    return;
  }
  const key = keyOf(organisationId, designId);
  memory.set(key, state);
  const before = pending.get(key);
  if (before) clearTimeout(before.timer);
  const send = (retry: boolean): void => {
    pending.delete(key);
    const latest = memory.get(key);
    if (!latest) return;
    putCableView(organisationId, designId, latest).catch(() => {
      // One more try; after that the memory copy still draws, and the next change sends it again.
      if (retry && !pending.has(key)) pending.set(key, { timer: setTimeout(() => send(false), RETRY_AFTER_MS), send: () => send(false) });
    });
  };
  pending.set(key, { timer: setTimeout(() => send(true), SAVE_AFTER_MS), send: () => send(true) });
}

/** Sends every waiting save now: the page is going away. */
export function flushCableViews(): void {
  for (const { timer, send } of [...pending.values()]) {
    clearTimeout(timer);
    send();
  }
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushCableViews);

/** For tests: forget the memory copies and any waiting save. */
export function resetCableViewStoreForTests(): void {
  forgetAll();
}

function forgetAll(): void {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
  memory.clear();
}

// What another person's session loaded never shows to the next one in this tab: the memory copy
// goes when the account signs out or another signs in.
let heldAccount: string | null = getSessionOn(ACCOUNT_PLANE)?.accountId ?? null;
subscribeSession(() => {
  const now = getSessionOn(ACCOUNT_PLANE)?.accountId ?? null;
  if (now !== heldAccount) {
    heldAccount = now;
    forgetAll();
  }
});
