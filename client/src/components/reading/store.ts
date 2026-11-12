// What the device panel's head and its Readings tab share about one device: what was read, a read
// under way, and the last refusal. Kept outside React so the two parts of the panel see one state,
// and the organisation's switches are fetched once.

import { createContext, useEffect, useSyncExternalStore } from 'react';

import { fetchDeviceReading, fetchReadingPanel, readDevice, type DeviceReading, type Identity, type ReadAnswer, type ReadKind, type ReadingPanel } from '../../api/deviceRead';
import type { EditorChange } from '../drawing';
import { asString, fieldValue, findNode, type Document } from '../../document/model';

/** What the design gives the panel. Absent outside a saved design, and then nothing here shows. */
export interface ReadingPlace {
  organisation: string;
  design: string;
  doc: Document;
  canDraw: boolean;
  onEdit(change: EditorChange): { refused: string } | void;
}

export const ReadingContext = createContext<ReadingPlace | null>(null);

/**
 * Hands text to the canvas's paste reader, as if it had been pasted (`RacksPlace.tsx` listens, with
 * `detail: { text, platform }`): a configuration read over SSH goes through the same readers, and the
 * same card, as a pasted one. Nothing changes in the design until the person chooses on the card.
 */
export const READ_AS_PASTE = 'fathom:read-as-paste';

export type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

/** A refusal, said once in words, or a confirmation still owed. */
export type Halt =
  | { kind: 'failed'; code: string; message: string; identity: Identity | null; previous: string | null; read: ReadKind; retryAt?: number | null }
  | { kind: 'confirm'; identity: Identity; state: 'seen' | 'changed'; previous: string | null };

export interface DeviceState {
  panel: Load<ReadingPanel>;
  /** A read under way, and what it is for. */
  busy: { kind: ReadKind; since: number } | null;
  halt: Halt | null;
  /** The login the last read here used, so the next one need not ask. */
  login: string | null;
  /** The Read dialog, open for this kind of read. */
  dialog: ReadKind | null;
  /** The platform a person chose for a configuration read, when the design names none. */
  sshPlatform: string | null;
}

const states = new Map<string, DeviceState>();
const listeners = new Set<() => void>();
const settings = new Map<string, Load<DeviceReading>>();

const EMPTY: DeviceState = { panel: { status: 'loading' }, busy: null, halt: null, login: null, dialog: null, sshPlatform: null };

function key(design: string, element: string): string {
  return `${design}|${element}`;
}

function tell() {
  for (const l of listeners) l();
}

function patch(k: string, p: Partial<DeviceState>) {
  states.set(k, { ...(states.get(k) ?? EMPTY), ...p });
  tell();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

function words(e: unknown): string {
  return e instanceof Error ? e.message : 'That did not work.';
}

async function loadPanel(place: ReadingPlace, element: string) {
  const k = key(place.design, element);
  try {
    patch(k, { panel: { status: 'ready', value: await fetchReadingPanel(place.organisation, place.design, element) } });
  } catch (e) {
    patch(k, { panel: { status: 'error', message: words(e) } });
  }
}

async function loadSettings(organisation: string) {
  try {
    settings.set(organisation, { status: 'ready', value: await fetchDeviceReading(organisation) });
  } catch (e) {
    settings.set(organisation, { status: 'error', message: words(e) });
  }
  tell();
}

/** The organisation's reading switches; fetched once per page load, and again after a Steward saves. */
export function useReadSettings(organisation: string | null): Load<DeviceReading> | null {
  const get = () => (organisation ? (settings.get(organisation) ?? null) : null);
  const s = useSyncExternalStore(subscribe, get, get);
  useEffect(() => {
    if (organisation && !settings.has(organisation)) {
      settings.set(organisation, { status: 'loading' });
      void loadSettings(organisation);
    }
  }, [organisation]);
  return s;
}

/** Forgets the switches, so the next panel fetches them again (a Steward just saved). */
export function forgetReadSettings(organisation: string) {
  settings.delete(organisation);
  tell();
}

/** One device's readings, fetched when first shown. `null` outside a saved design or when reading is off on this server. */
export function useDeviceReading(place: ReadingPlace | null, element: string, enabled: boolean): DeviceState | null {
  const k = place ? key(place.design, element) : '';
  const get = () => (place && enabled ? (states.get(k) ?? EMPTY) : null);
  const s = useSyncExternalStore(subscribe, get, get);
  useEffect(() => {
    if (place && enabled && !states.has(k)) {
      states.set(k, EMPTY);
      void loadPanel(place, element);
    }
  }, [place, enabled, k, element]);
  return s;
}

/** Reads the device and keeps what it answered; a `confirm` or a refusal is kept for the panel to say. */
export async function runRead(place: ReadingPlace, element: string, kind: ReadKind, login: string, confirm: string | null): Promise<ReadAnswer | null> {
  const k = key(place.design, element);
  patch(k, { busy: { kind, since: Date.now() }, halt: null, login });
  let answer: ReadAnswer | null = null;
  try {
    const platform = kind === 'config' ? (states.get(k)?.sshPlatform ?? null) : null;
    answer = await readDevice(place.organisation, place.design, { element, kind, login, confirm, platform });
    if (answer.outcome === 'read') {
      // A platform chosen for a device drawn without one is kept in the design once a read with it
      // succeeds: an ordinary change by this person (only someone with Draw is offered the choice).
      if (platform && place.canDraw && !drawnPlatform(place, element)) {
        const r = place.onEdit({ kind: 'device', id: element, field: 'platform', value: platform });
        if (!r) patch(k, { sshPlatform: null });
      }
      await loadPanel(place, element);
      patch(k, { busy: null, halt: null });
    } else if (answer.outcome === 'confirm') {
      patch(k, { busy: null, halt: { kind: 'confirm', identity: answer.identity, state: answer.state, previous: answer.previous } });
    } else {
      patch(k, { busy: null, halt: { kind: 'failed', code: answer.code, message: answer.message, identity: answer.identity, previous: answer.previous, read: kind, retryAt: answer.retryAt ?? null } });
    }
  } catch (e) {
    patch(k, { busy: null, halt: { kind: 'failed', code: 'refused', message: words(e), identity: null, previous: null, read: kind } });
  }
  return answer;
}

/** Stops waiting here. The server finishes the read and keeps it; the device is never changed either way. */
export function stopWaiting(place: ReadingPlace, element: string) {
  patch(key(place.design, element), { busy: null });
}

/** Opens the Read dialog; `halt` puts an agent to confirm in it ("Confirm the new one"). */
export function openDialog(place: ReadingPlace, element: string, kind: ReadKind, halt?: Halt) {
  patch(key(place.design, element), halt ? { dialog: kind, halt } : { dialog: kind });
}

export function closeDialog(place: ReadingPlace, element: string) {
  patch(key(place.design, element), { dialog: null });
}

function drawnPlatform(place: ReadingPlace, element: string): string | null {
  const node = findNode(place.doc, element);
  return node ? (asString(fieldValue(node.fields, 'Device.platform')) ?? null) : null;
}

/** The platform to read a configuration as, for a device the design names none for. */
export function chooseSshPlatform(place: ReadingPlace, element: string, platform: string | null) {
  patch(key(place.design, element), { sshPlatform: platform });
}

export function reloadPanel(place: ReadingPlace, element: string) {
  void loadPanel(place, element);
}

/** For tests: forget everything. */
export function resetReadingStore() {
  states.clear();
  settings.clear();
}

/** For render tests: set one device's state as if it had loaded. */
export function seedReading(design: string, element: string, s: Partial<DeviceState>, organisation?: string, on?: DeviceReading) {
  states.set(key(design, element), { ...EMPTY, ...s });
  if (organisation && on) settings.set(organisation, { status: 'ready', value: on });
}
