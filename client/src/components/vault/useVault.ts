// One organisation's vault for a screen: what the server lists, and whether it is unlocked here.
// Reloads after every act, so a screen never shows a holder list the server did not send.

import { createContext, useCallback, useEffect, useSyncExternalStore } from 'react';

import { describeError } from '../design/useDesignSession';
import type { VaultOverview } from '../../api/vault';
import { fetchVault, onVaultChange, vaultUnlocked } from '../../vault/session';

export type VaultLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: VaultOverview };

export interface Vault {
  organisation: string;
  load: VaultLoad;
  reload(): void;
  /** Open in this tab, and until when (ms). */
  unlocked: { until: number } | null;
}

export function useVaultUnlocked(organisation?: string): { until: number } | null {
  const read = () => JSON.stringify(vaultUnlocked(organisation));
  const snapshot = useSyncExternalStore(onVaultChange, read, () => 'null');
  return JSON.parse(snapshot) as { until: number } | null;
}

// One load per organisation, shared by every screen showing it: the Logins tab, its count and
// the Passwords page reload together, so they never disagree.
const loads = new Map<string, VaultLoad>();
const loadListeners = new Set<() => void>();
const inFlight = new Map<string, number>();

function setLoad(organisation: string, load: VaultLoad): void {
  loads.set(organisation, load);
  for (const l of loadListeners) l();
}

function fetchInto(organisation: string): void {
  const n = (inFlight.get(organisation) ?? 0) + 1;
  inFlight.set(organisation, n);
  fetchVault(organisation).then(
    (value) => inFlight.get(organisation) === n && setLoad(organisation, { status: 'ready', value }),
    (e: unknown) => inFlight.get(organisation) === n && setLoad(organisation, { status: 'error', message: describeError(e) }),
  );
}

const LOADING: VaultLoad = { status: 'loading' };

export function useVault(organisation: string): Vault {
  const load = useSyncExternalStore(
    (l) => {
      loadListeners.add(l);
      return () => loadListeners.delete(l);
    },
    () => loads.get(organisation) ?? LOADING,
    () => LOADING,
  );
  useEffect(() => {
    if (organisation !== '' && !loads.has(organisation)) fetchInto(organisation);
  }, [organisation]);
  const reload = useCallback(() => {
    if (organisation !== '') fetchInto(organisation);
  }, [organisation]);
  return { organisation, load, reload, unlocked: useVaultUnlocked(organisation) };
}

/** What the canvas and Inventory give the vault screens: whose design this is, and device names. */
export interface VaultPlace {
  organisation: string;
  organisationName: string;
  design: string;
  deviceName(deviceId: string): string | null;
  deviceIds: readonly string[];
}

export const VaultPlaceContext = createContext<VaultPlace | null>(null);
