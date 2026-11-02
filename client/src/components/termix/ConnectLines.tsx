// The plain way to reach a device (ADR-0080 decision 8): the management address with Copy, and the
// `ssh` line for Windows and for Linux. Always there, Termix or not. Open while there is no Termix
// button beside it; folded under it when there is one, so the Termix button stays the short way.

import { CopyButton } from '../firmware/parts';
import { CommandToType } from '../typing/CommandToType';
import { useTypeItYourself } from '../typing/typeItYourself';
import { bareAddress } from './termix';
import { connectWays } from './connect';
import './termix.css';

export function ConnectLines({ address, folded = false }: { address: string; folded?: boolean }) {
  const typing = useTypeItYourself();
  const ways = connectWays(address);
  if (ways.length === 0) return null;
  const at = bareAddress(address);
  return (
    <details className="termix-plain" open={!folded} data-testid="connect-lines">
      <summary>Connect with ssh</summary>
      <p className="termix-plain__line">
        <code className="termix-mono">{at}</code>, port 22 <CopyButton text={at} label="Copy address" className="btn-quiet" />
      </p>
      {ways.map((w) => (
        <div key={w.os} className="termix-plain__way">
          <span className="termix-plain__label">{w.label}</span>
          {typing ? (
            <CommandToType command={w.command} />
          ) : (
            <span className="termix-plain__line">
              <code className="termix-mono">{w.command}</code> <CopyButton text={w.command} label="Copy" className="btn-quiet" />
            </span>
          )}
          <span className="termix__hint">{w.note}</span>
        </div>
      ))}
    </details>
  );
}
