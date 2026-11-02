// "Open in Termix" under a device's management address (ADR-0078). Shown only when the operator
// named a Termix (`FATHOM_TERMIX_URL`) and the device has an address; when a steward turned it
// off here, one line says so instead (decision 6). The person's Termix API key
// is asked for once and kept in this tab only; it goes to Termix and nowhere else.

import { useContext, useEffect, useState, type ReactNode } from 'react';

import type { TermixOff } from '../../api/termix';
import './termix.css';
import { VaultPlaceContext, useVault } from '../vault/useVault';
import { SECRET_SOURCES, referenceFor, type LoginReference } from './loginRef';
import { KEY_EVENT, TermixError, addHost, listAddOns, forgetKey, isHostAddress, isTermixKey, listHosts, matchHost, readKey, sameHostName, saveKey, terminalUrl } from './termix';
import type { TermixHost } from './termix';
import { offWords, useTermix } from './useTermix';

interface Props {
  name: string;
  address: string;
  /** For tests: the operator's Termix without asking the server. */
  origin?: string | null;
  /** For tests: a steward turned it off. */
  off?: TermixOff | null;
  /** In a plan's step or device list (ADR-0080 decision 2): no field label, one line. */
  inline?: boolean;
  /** The device, for a vault login marked on it (ADR-0080 decision 3). */
  deviceId?: string;
  /** For tests: the login, without asking the vault. */
  login?: LoginReference | null;
}

/** The device panel's field, or a bare block in a plan. */
function Frame({ inline, children }: { inline?: boolean; children: ReactNode }) {
  if (inline) {
    return (
      <div className="termix-inline" data-testid="termix-actions">
        {children}
      </div>
    );
  }
  return (
    <div className="drawing-editor__field" data-testid="termix-actions">
      <div className="drawing-editor__field-label">Termix</div>
      {children}
    </div>
  );
}

type Step =
  | { at: 'idle' }
  | { at: 'key' }
  | { at: 'busy' }
  | { at: 'missing'; secretSources: boolean }
  | { at: 'other'; host: TermixHost }
  | { at: 'opened'; host: TermixHost }
  | { at: 'error'; message: string };

export function TermixActions({ name, address, origin: given, off: givenOff, inline, deviceId, login: givenLogin }: Props) {
  const { url: origin, off } = useTermix(given, givenOff);
  const login = useLogin(origin !== null && givenLogin === undefined ? deviceId : undefined) ?? givenLogin ?? null;
  const [byReference, setByReference] = useState(true);
  const [key, setKey] = useState<string | null>(() => readKey());
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState<Step>({ at: 'idle' });

  // A key pasted or forgotten beside another device is this one's too.
  useEffect(() => {
    const follow = () => setKey(readKey());
    window.addEventListener(KEY_EVENT, follow);
    return () => window.removeEventListener(KEY_EVENT, follow);
  }, []);

  if (address.trim() === '') return null;
  const why = offWords(off);
  if (why) {
    return (
      <Frame inline={inline}>
        <p className="termix__hint">{why}</p>
      </Frame>
    );
  }
  if (!origin) return null;
  if (!isHostAddress(address)) {
    return (
      <Frame inline={inline}>
        <p className="termix__hint">This management address is not an IP address or host name, so it is not sent to Termix.</p>
      </Frame>
    );
  }

  // Opened before any await, so the browser counts it as the click's own window.
  const open = async (k: string, add: boolean) => {
    const win = window.open('about:blank', '_blank');
    if (win) win.opener = null;
    setStep({ at: 'busy' });
    try {
      const reference = add && login && byReference ? login.reference : null;
      const found = add ? await addHost(origin, k, name, address, fetch, undefined, reference) : matchHost(await listHosts(origin, k), address);
      if (!found) {
        win?.close();
        // Whether this Termix can take the login by reference: only asked when there is one to send.
        const addOns = login ? await listAddOns(origin, k).catch(() => new Set<string>()) : new Set<string>();
        setStep({ at: 'missing', secretSources: addOns.has(SECRET_SOURCES) });
        return;
      }
      // Matched by address alone: a host with another name is asked about first (sign-off r61).
      if (!add && !sameHostName(found, name)) {
        win?.close();
        setStep({ at: 'other', host: found });
        return;
      }
      if (win) win.location.href = terminalUrl(origin, found.id);
      setStep({ at: 'opened', host: found });
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
    <Frame inline={inline}>
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
          {login && step.secretSources && byReference ? 'It signs in with the vault login below.' : 'It goes in with no password; pick a credential in Termix.'}
        </p>
      ) : null}
      {step.at === 'missing' && key && login ? (
        step.secretSources ? (
          <div className="termix-ref" data-testid="termix-reference">
            <label>
              <input type="checkbox" checked={byReference} onChange={(e) => setByReference(e.target.checked)} /> Sign in with the vault login &ldquo;{login.name}&rdquo;, by reference
            </label>
            <p className="termix__hint">
              Termix is sent <code className="termix-mono">{login.reference}</code>, which names the login in Vaultwarden. It is not the password: Termix&rsquo;s Secret
              Sources add-on fetches that when you connect, from the vault its operator connected. What that vault can open is Termix&rsquo;s operator&rsquo;s to limit.
            </p>
          </div>
        ) : (
          <p className="termix__hint" data-testid="termix-reference-off">
            This device has the vault login &ldquo;{login.name}&rdquo;, but this Termix does not run its Secret Sources add-on, so the host goes in with no
            password. Use the login from Logins as you do now.
          </p>
        )
      ) : null}
      {step.at === 'other' ? (
        <p className="termix__hint" role="alert">
          Termix&rsquo;s host at {address.trim()} is called &ldquo;{step.host.name}&rdquo;, not &ldquo;{name.trim() || 'this device'}&rdquo;. Check it is
          the same machine before you sign in.{' '}
          <button
            type="button"
            className="btn-quiet"
            onClick={() => {
              window.open(terminalUrl(origin, step.host.id), '_blank', 'noopener');
              setStep({ at: 'opened', host: step.host });
            }}
          >
            Open {step.host.name} anyway
          </button>{' '}
          <button type="button" className="btn-quiet" onClick={() => setStep({ at: 'idle' })}>
            Cancel
          </button>
        </p>
      ) : null}
      {step.at === 'opened' ? (
        <p className="termix__hint" role="status">
          Opened Termix&rsquo;s host &ldquo;{step.host.name}&rdquo; ({step.host.ip}).
        </p>
      ) : null}
      {step.at === 'error' ? (
        <p className="termix__hint termix__hint--error" role="alert">
          {step.message}
        </p>
      ) : null}
    </Frame>
  );
}

/** The vault login marked on this device, by reference, when the design is open in a vault place. */
function useLogin(deviceId: string | undefined): LoginReference | null {
  const place = useContext(VaultPlaceContext);
  const vault = useVault(place && deviceId ? place.organisation : '');
  if (!place || !deviceId || vault.load.status !== 'ready') return null;
  return referenceFor(vault.load.value.outside, place.design, deviceId);
}
