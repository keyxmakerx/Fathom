// A console port's way in (ADR-0080 decision 10). Always: the speed, and lines for PuTTY, screen and
// picocom. With Termix running its Serial add-on: Open Termix, and where to click there.

import { CopyButton } from '../firmware/parts';
import { CommandToType } from '../typing/CommandToType';
import { useTypeItYourself } from '../typing/typeItYourself';
import { LINUX_PORT, SERIAL, WINDOWS_PORT, serialWays } from './serial';
import { useAddOns } from './useAddOns';
import { useTermix } from './useTermix';
import './termix.css';

export function SerialConsole({ baud }: { baud?: number }) {
  const { url: origin } = useTermix();
  const addOns = useAddOns(origin);
  const typing = useTypeItYourself();
  const speed = baud !== undefined ? `${baud} bits per second` : 'the speed the device’s guide gives';
  return (
    <div className="termix-serial" data-testid="serial-console">
      {origin !== null ? (
        addOns !== null && !addOns.has(SERIAL) ? (
          <p className="termix__hint" data-testid="termix-serial-off">
            This Termix does not run its Serial add-on. Use one of the lines below.
          </p>
        ) : (
          <p className="termix-serial__termix">
            <a className="btn-quiet" href={new URL('/', origin).toString()} target="_blank" rel="noopener noreferrer" data-testid="termix-serial-open">
              Open Termix
            </a>{' '}
            <span className="termix__hint">
              Then choose Serial on its left rail, pick the port this cable is on and set {speed}. In a browser it needs Chrome, Edge, or Firefox 151 or newer.
            </span>
          </p>
        )
      ) : null}
      <details className="termix-plain" open={origin === null} data-testid="serial-lines">
        <summary>Connect with a serial program</summary>
        {serialWays(baud).map((w) => (
          <div key={w.label} className="termix-plain__way">
            <span className="termix-plain__label">{w.label}</span>
            {typing ? (
              <CommandToType command={w.command} />
            ) : (
              <span className="termix-plain__line">
                <code className="termix-mono">{w.command}</code> <CopyButton text={w.command} label="Copy" className="btn-quiet" />
              </span>
            )}
          </div>
        ))}
        <p className="termix__hint">
          {WINDOWS_PORT} and {LINUX_PORT} stand for the port your cable is on: Device Manager lists it on Windows; on Linux it is usually a /dev/ttyUSB or
          /dev/ttyACM device. Set data bits, parity and stop bits as the device’s guide says.
        </p>
      </details>
    </div>
  );
}
