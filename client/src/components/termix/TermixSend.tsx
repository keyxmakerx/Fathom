// "Send to Termix" on Inventory's ticked devices (ADR-0078, card r43-termix: "send a whole design").
// Select all matching, then Send, adds every device with a management address that Termix does
// not have yet, in the folder `Fathom / <design>`. Same key, same rules as Open in Termix, and
// gone when a steward turned Termix off here.

import { useState } from 'react';

import './termix.css';
import { TermixError, folderFor, forgetKey, isTermixKey, readKey, saveKey, sendHosts, sendSummary } from './termix';
import { useTermix } from './useTermix';

interface Props {
  devices: readonly { name: string; address: string }[];
  design: string;
  /** For tests: the operator's Termix without asking the server. */
  origin?: string | null;
}

export function TermixSend({ devices, design, origin: given }: Props) {
  const { url: origin } = useTermix(given);
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const withAddress = devices.filter((d) => d.address.trim() !== '');
  if (!origin) return null;

  const run = async (key: string) => {
    setBusy({ done: 0, total: withAddress.length });
    setSaid(null);
    try {
      const r = await sendHosts(origin, key, withAddress, folderFor(design), fetch, (done, total) => setBusy({ done, total }));
      setSaid(sendSummary(r));
    } catch (e) {
      if (e instanceof TermixError && /API key/.test(e.message)) forgetKey();
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const start = () => {
    const key = readKey();
    if (key) void run(key);
    else setAsking(true);
  };

  const submitKey = () => {
    if (!isTermixKey(typed)) {
      setSaid('A Termix API key starts tmx_ and has 64 letters and digits after it.');
      return;
    }
    saveKey(typed);
    setAsking(false);
    setTyped('');
    void run(typed.trim());
  };

  return (
    <span className="termix-send" data-testid="termix-send">
      <button type="button" disabled={busy !== null || withAddress.length === 0} onClick={start} title={withAddress.length === 0 ? 'None of these has a management address' : undefined}>
        {busy ? `Sending ${busy.done} of ${busy.total}…` : `Send ${withAddress.length} to Termix`}
      </button>
      {asking ? (
        <span className="termix-send__key">
          <input
            type="password"
            className="termix__key"
            aria-label="Termix API key"
            placeholder="Termix API key (tmx_…)"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitKey()}
          />
          <button type="button" className="btn-main" onClick={submitKey}>
            Send
          </button>
        </span>
      ) : null}
      {said ? (
        <span className="termix__hint" role="status">
          {said}
        </span>
      ) : null}
    </span>
  );
}
