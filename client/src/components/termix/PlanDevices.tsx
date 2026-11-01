// A plan's devices, each with Open in Termix and the plain way beside it (ADR-0080 decisions 2 and 8).
// The plan's panel lists them once, so a person can open every terminal before the window starts; a
// step in Do shows only the devices it names. Termix opens in a new tab; nothing is framed in Fathom.
// In Do, each also shows Termix's up or down (decision 7), read when the list opens and on Refresh,
// never on a timer, and labelled as Termix's. Without Termix nothing says up or down.

import { useCallback, useEffect, useState } from 'react';

import { CopyButton } from '../firmware/parts';
import { ConnectLines } from './ConnectLines';
import { TermixActions } from './TermixActions';
import type { ReachableDevice } from './planDevices';
import { HOST_STATE_WORD, hostStatus, type HostState } from './maintenance';
import { hostIdsFor } from './snippets';
import { bareAddress, listHosts, matchHost } from './termix';
import { useTermixKey } from './useAddOns';
import { useTermix } from './useTermix';
import './termix.css';

function DeviceRow({ device, termix, state }: { device: ReachableDevice; termix: boolean; state?: HostState | null }) {
  return (
    <li className="termix-device" data-testid="plan-device">
      <span className="termix-device__name">{device.name}</span>{' '}
      {state ? (
        <span className="termix-device__state" data-state={state} data-testid="termix-state">
          Termix says {HOST_STATE_WORD[state]}
        </span>
      ) : null}{' '}
      {device.address === '' ? (
        <span className="termix__hint">No management address. Add one on the device to open it from here.</span>
      ) : (
        <>
          <code className="termix-mono">{bareAddress(device.address)}</code> <CopyButton text={bareAddress(device.address)} label="Copy" className="btn-quiet" />
          <TermixActions name={device.name} address={device.address} deviceId={device.id} inline />
          <ConnectLines address={device.address} folded={termix} />
        </>
      )}
    </li>
  );
}

/** Termix's up or down for these devices, by address: read once, and again on `refresh`. */
function useHostStates(devices: readonly ReachableDevice[], on: boolean) {
  const { url: origin } = useTermix();
  const key = useTermixKey();
  const [states, setStates] = useState<Map<string, HostState> | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const addresses = devices.map((d) => d.address).join('\n');
  useEffect(() => {
    if (!on || !origin || !key || addresses === '') return;
    let live = true;
    void (async () => {
      try {
        const list = addresses.split('\n');
        const hosts = await listHosts(origin, key);
        const byId = await hostStatus(origin, key, hostIdsFor(hosts, list));
        const out = new Map<string, HostState>();
        for (const a of list) {
          const h = matchHost(hosts, a);
          const s = h ? byId.get(h.id) : undefined;
          if (s) out.set(a, s);
        }
        if (live) {
          setStates(out);
          setSaid(null);
        }
      } catch (e) {
        if (live) setSaid(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [on, origin, key, addresses, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { states, said, refresh, shown: on && origin !== null && key !== null };
}

/** `heading` names the list ("Devices" for the plan, nothing inside a step). `withState`: Do's up or down. */
export function PlanDevices({ devices, heading, withState = false }: { devices: readonly ReachableDevice[]; heading?: string; withState?: boolean }) {
  const { url } = useTermix();
  const live = useHostStates(devices, withState);
  if (devices.length === 0) return null;
  return (
    <div className="termix-devices" data-testid="plan-devices">
      {heading ? <h3 className="plans-label">{heading}</h3> : null}
      <ul className="termix-devices__list">
        {devices.map((d) => (
          <DeviceRow key={d.id} device={d} termix={url !== null} state={live.states?.get(d.address) ?? null} />
        ))}
      </ul>
      {live.shown ? (
        <p className="termix__hint">
          Up or down is Termix’s view, read when this opened.{' '}
          <button type="button" className="btn-quiet" onClick={live.refresh} data-testid="termix-refresh">
            Refresh
          </button>
          {live.said ? ` ${live.said}` : ''}
        </p>
      ) : null}
    </div>
  );
}
