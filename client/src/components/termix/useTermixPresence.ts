// The "In Termix" column of Inventory › Devices (ADR-0080 decision 11). Filled in the browser from the
// host list Send to Termix reads, once per visit and on Refresh: In Termix, Not in Termix, or blank when
// Termix is off, the key is not pasted, or the device has no management address. Termix's view, read,
// never stored in the design.

import { useCallback, useEffect, useState } from 'react';

import { listHosts, matchHost, type TermixHost } from './termix';
import { useTermixKey } from './useAddOns';

export const IN_TERMIX = 'In Termix';
export const NOT_IN_TERMIX = 'Not in Termix';

/** The cell for one address: blank without a list or an address. */
export function presenceCell(hosts: readonly TermixHost[] | null, address: string): string {
  if (hosts === null || address.trim() === '') return '';
  return matchHost([...hosts], address) ? IN_TERMIX : NOT_IN_TERMIX;
}

export function useTermixPresence(origin: string | null, on: boolean) {
  const key = useTermixKey();
  const [hosts, setHosts] = useState<TermixHost[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on || !origin || !key) {
      setHosts(null);
      return;
    }
    let live = true;
    listHosts(origin, key).then(
      (h) => live && setHosts(h),
      () => live && setHosts(null),
    );
    return () => {
      live = false;
    };
  }, [on, origin, key, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { hosts, refresh };
}
