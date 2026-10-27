// "Open in Termix" under a device's management address (ADR-0078). Shown only when the operator
// named a Termix (`FATHOM_TERMIX_URL`) and the device has an address; when a steward turned it
// off here, one line says so instead (decision 6). The person's Termix API key
// is asked for once and kept in this tab only; it goes to Termix and nowhere else.

import { useState } from 'react';

import type { TermixOff } from '../../api/termix';
import './termix.css';
import { TermixError, addHost, forgetKey, isHostAddress, isTermixKey, listHosts, matchHost, readKey, saveKey, terminalUrl } from './termix';
import { offWords, useTermix } from './useTermix';

interface Props {
  name: string;
  address: string;
  /** For tests: the operator's Termix without asking the server. */
  origin?: string | null;
  /** For tests: a steward turned it off. */
  off?: TermixOff | null;
}

type Step = { at: 'idle' } | { at: 'key' } | { at: 'busy' } | { at: 'missing' } | { at: 'error'; message: string };

export function TermixActions({ name, address, origin: given, off: givenOff }: Props) {
  const { url: origin, off } = useTermix(given, givenOff);
  const [key, setKey] = useState<string | null>(() => readKey());
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState<Step>({ at: 'idle' });

  if (address.trim() === '') return null;
  const why = offWords(off);
  if (why) {
    return (
      <div className="drawing-editor__field" data-testid="termix-actions">
        <div className="drawing-editor__field-label">Termix</div>
        <p className="termix__hint">{why}</p>
      </div>
    );
  }
  if (!origin) return null;
  if (!isHostAddress(address)) {
    return (
      <div className="drawing-editor__field" data-testid="termix-actions">
        <div className="drawing-editor__field-label">Termix</div>
        <p className="termix__hint">This management address is not an IP address or host name, so it is not sent to Termix.</p>
      </div>
    );
  }

  // Opened before any await, so the browser counts it as the click's own window.
  const open = async (k: string, add: boolean) => {
    const win = window.open('about:blank', '_blank');
    if (win) win.opener = null;
    setStep({ at: 'busy' });
    try {
      const found = add ? await addHost(origin, k, name, address) : matchHost(await listHosts(origin, k), address);
      if (!found) {
        win?.close();
        setStep({ at: 'missing' });
        return;
      }
      if (win) win.location.href = terminalUrl(origin, found.id);
      setStep({ at: 'idle' });
    } catch (e) {
      win?.close();
      if (e instanceof TermixError && /API key/.test(e.message)) {
        forgetKey();
        setKey(null);
      }
      setStep({ at: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const submitKey = () => {
    if (!isTermixKey(typed)) {
      setStep({ at: 'error', message: 'A Termix API key starts tmx_ and has 64 letters and digits after it.' });
      return;
    }
    const k = typed.trim();
    saveKey(k);
    setKey(k);
    setTyped('');
    void open(k, false);
  };

  return (
    <div className="drawing-editor__field" data-testid="termix-actions">
      <div className="drawing-editor__field-label">Termix</div>
      {step.at === 'key' || (!key && step.at !== 'idle' && step.at !== 'busy') ? (
        <div className="drawing-editor__field-value">
          <p className="termix__hint">Paste your Termix API key. It stays in this tab and goes only to {new URL(origin).host}.</p>
          <input
            type="password"
            className="termix__key"
            aria-label="Termix API key"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitKey()}
          />
          <button type="button" className="btn-main" onClick={submitKey}>
            Open
          </button>
        </div>
      ) : (
        <div className="drawing-editor__field-value">
          <button
            type="button"
            className="btn-quiet"
            disabled={step.at === 'busy'}
            onClick={() => (key ? void open(key, false) : setStep({ at: 'key' }))}
          >
            {step.at === 'busy' ? 'Opening…' : 'Open in Termix'}
          </button>
          {key ? (
            <button
              type="button"
              className="btn-quiet"
              onClick={() => {
                forgetKey();
                setKey(null);
                setStep({ at: 'idle' });
              }}
            >
              Forget key
            </button>
          ) : null}
        </div>
      )}
      {step.at === 'missing' && key ? (
        <p className="termix__hint" role="status">
          Termix has no host at {address.trim()}.{' '}
          <button type="button" className="btn-quiet" onClick={() => void open(key, true)}>
            Add it to Termix
          </button>{' '}
          It goes in with no password; pick a credential in Termix.
        </p>
      ) : null}
      {step.at === 'error' ? (
        <p className="termix__hint termix__hint--error" role="alert">
          {step.message}
        </p>
      ) : null}
    </div>
  );
}
