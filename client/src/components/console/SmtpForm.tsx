import { useState, type FormEvent } from 'react';

import { requestSmtpSetting, sendTestMessage, type PendingChange, type SmtpTlsMode } from '../../api/console';
import { describeConsoleError } from './describeConsoleError';
import '../../styles/console.css';

/**
 * §5.3's `smtp` setting, with a form -- ADR-0055 decision 11.
 *
 * The value is one sealed `site_settings_versions` row and not a table:
 * `LP(host) ‖ LP(port) ‖ LP(tls_mode) ‖ LP(user) ‖ LP(password) ‖
 * LP(from_address)`, checked by the server before it is sealed
 * (`placement::parse_smtp_value`) so a malformed form is a typed refusal
 * rather than a row nobody can read later.
 *
 * **The password is a credential** (§5.3: *"SMTP credentials are
 * credentials"*). It is sealed under the site settings key, it is never
 * shown again, and the server's refusals name the field and never the value.
 * So this form does not pretend to display what is stored: it writes a new
 * version, and shows when that version takes effect.
 *
 * **The test send has nothing behind it yet.** The route exists and answers
 * 503 with one sentence; that sentence is shown as it arrived, because a
 * console that said "sent" would be lying about the one thing this form is
 * for.
 */
export interface SmtpFormProps {
  actingOperatorId: string;
}

const TLS_MODES: { value: SmtpTlsMode; label: string }[] = [
  { value: 'starttls', label: 'STARTTLS — connect in the clear, upgrade (RFC 3207)' },
  { value: 'implicit', label: 'Implicit TLS — TLS from the first byte (RFC 8314)' },
  { value: 'none', label: 'None — no TLS, for a relay on this host only' },
];

export function SmtpForm({ actingOperatorId }: SmtpFormProps) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [tlsMode, setTlsMode] = useState<SmtpTlsMode>('starttls');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<PendingChange | null>(null);
  const [testAnswer, setTestAnswer] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setTestAnswer(null);
    const parsedPort = Number.parseInt(port.trim(), 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError('The port is a number from 1 to 65535.');
      setBusy(false);
      return;
    }
    try {
      const pending = await requestSmtpSetting(actingOperatorId, {
        host: host.trim(),
        port: parsedPort,
        tlsMode,
        user: user.trim(),
        password,
        fromAddress: fromAddress.trim(),
      });
      setSaved(pending);
      // The password leaves this browser's memory the moment the server has
      // it: there is nothing more to do with it here, and a field still
      // holding it is a field a screenshot can hold.
      setPassword('');
    } catch (e) {
      setError(describeConsoleError(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!saved) return;
    setBusy(true);
    setError(null);
    try {
      setTestAnswer(await sendTestMessage(saved.id));
    } catch (e) {
      setError(describeConsoleError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="console__form" onSubmit={submit}>
      <div className="console__form-title">Mail (SMTP)</div>
      <p className="console__note">
        Where this install hands its mail. Set it here rather than in a file: the operator console is the one place
        that can change it without a restart, and doing it here is what keeps a lockout from needing one. The value
        is sealed before it is stored and is never shown again — to change any field, send the whole form again.
      </p>
      <div className="console__fieldrow">
        <div className="console__field">
          <label className="console__label" htmlFor="smtp-host">
            Host
          </label>
          <input
            id="smtp-host"
            className="console__input"
            type="text"
            autoComplete="off"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            disabled={busy}
            required
          />
        </div>
        <div className="console__field console__field--narrow">
          <label className="console__label" htmlFor="smtp-port">
            Port
          </label>
          <input
            id="smtp-port"
            className="console__input console__input--mono"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={busy}
            required
          />
        </div>
      </div>
      <label className="console__label" htmlFor="smtp-tls">
        TLS
      </label>
      <select
        id="smtp-tls"
        className="console__select"
        value={tlsMode}
        onChange={(e) => setTlsMode(e.target.value as SmtpTlsMode)}
        disabled={busy}
      >
        {TLS_MODES.map((mode) => (
          <option key={mode.value} value={mode.value}>
            {mode.label}
          </option>
        ))}
      </select>
      <label className="console__label" htmlFor="smtp-user">
        User
      </label>
      <input
        id="smtp-user"
        className="console__input"
        type="text"
        autoComplete="off"
        value={user}
        onChange={(e) => setUser(e.target.value)}
        disabled={busy}
      />
      <label className="console__label" htmlFor="smtp-password">
        Password
      </label>
      <input
        id="smtp-password"
        className="console__input"
        type="password"
        autoComplete="off"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
      />
      <label className="console__label" htmlFor="smtp-from">
        From address
      </label>
      <input
        id="smtp-from"
        className="console__input"
        type="text"
        autoComplete="off"
        value={fromAddress}
        onChange={(e) => setFromAddress(e.target.value)}
        disabled={busy}
        required
      />
      <button type="submit" className="console__btn" disabled={busy || host.trim().length === 0}>
        {busy ? 'Saving…' : 'Save the mail settings'}
      </button>
      {saved && (
        <>
          <p className="console__muted">
            Saved as change <code>{saved.id}</code>, in effect at{' '}
            {new Date(saved.effectiveAtUnix * 1000).toLocaleString()}.
          </p>
          <button type="button" className="console__btn console__btn--quiet" disabled={busy} onClick={test}>
            {busy ? 'Asking…' : 'Send a test to my own address'}
          </button>
        </>
      )}
      {testAnswer && (
        <p className="console__warn" role="status">
          The server's answer, in its own words: “{testAnswer}”. Nothing was sent, and nothing can be until the
          mail client ships. The destination is never a field on this form — it is your own address of record, so
          there is nothing here to point at somebody else.
        </p>
      )}
      {error && (
        <p className="console__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
