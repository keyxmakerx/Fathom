// A plan's devices, each with Open in Termix and the plain way beside it (ADR-0080 decisions 2 and 8).
// The plan's panel lists them once, so a person can open every terminal before the window starts; a
// step in Do shows only the devices it names. Termix opens in a new tab; nothing is framed in Fathom.

import { CopyButton } from '../firmware/parts';
import { ConnectLines } from './ConnectLines';
import { TermixActions } from './TermixActions';
import type { ReachableDevice } from './planDevices';
import { bareAddress } from './termix';
import { useTermix } from './useTermix';
import './termix.css';

function DeviceRow({ device, termix }: { device: ReachableDevice; termix: boolean }) {
  return (
    <li className="termix-device" data-testid="plan-device">
      <span className="termix-device__name">{device.name}</span>{' '}
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

/** `heading` names the list ("Devices" for the plan, nothing inside a step). */
export function PlanDevices({ devices, heading }: { devices: readonly ReachableDevice[]; heading?: string }) {
  const { url } = useTermix();
  if (devices.length === 0) return null;
  return (
    <div className="termix-devices" data-testid="plan-devices">
      {heading ? <h3 className="plans-label">{heading}</h3> : null}
      <ul className="termix-devices__list">
        {devices.map((d) => (
          <DeviceRow key={d.id} device={d} termix={url !== null} />
        ))}
      </ul>
    </div>
  );
}
