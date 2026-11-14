import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchAbout, type About, type AboutConnections } from '../../api/about';
import { Engine } from '../../engine/engine';
import { useModal } from '../shell/useModal';
import '../../styles/palette.css';
import './about.css';
import { runSelfTests, type CheckResult, type SelfTestDeps } from './selfTests';

/** The commit this page was built from (`deploy/Dockerfile` stamps it); empty in development. */
const PAGE_COMMIT: string = (import.meta.env.VITE_FATHOM_COMMIT as string | undefined) ?? '';

let engine: Promise<Engine> | null = null;

/** The real outside world: this server, and the engine compiled for the browser. */
export const browserDeps: SelfTestDeps = {
  health: async () => {
    const r = await fetch('/health', { cache: 'no-store' });
    if (!r.ok) throw new Error(`answered ${r.status}`);
    return r.text();
  },
  about: fetchAbout,
  pageCommit: PAGE_COMMIT,
  redact: async (text) => {
    engine ??= Engine.init();
    return (await engine).redactText(text).text;
  },
  get location() {
    return window.location;
  },
  pagePolicy: async () => {
    const r = await fetch('/', { cache: 'no-store' });
    return r.headers.get('content-security-policy');
  },
};

/** Each outside connection in `docs/IS-IT-SAFE.md`'s table, in words a person reads. */
export const CONNECTION_ROWS: { key: keyof AboutConnections; label: string; what: string }[] = [
  { key: 'deviceRead', label: 'Reading devices', what: 'Asks switches and routers for their own settings, read-only, over SNMPv3.' },
  { key: 'outsideVaults', label: 'Outside password vaults', what: 'Looks up a password in your Vaultwarden or Delinea when someone asks.' },
  { key: 'passbolt', label: 'Passbolt', what: 'Looks up a password in your Passbolt when someone asks.' },
  { key: 'offsiteBackup', label: 'Off-site backup', what: 'Copies the encrypted backups to another place you chose.' },
  { key: 'auditSyslog', label: 'Change log to syslog', what: 'Sends each recorded change to your log server.' },
  { key: 'accessSyslog', label: 'Sign-ins to syslog', what: 'Sends each sign-in and refusal to your log server.' },
  { key: 'termix', label: 'Termix', what: 'Your browser opens Termix for a terminal; this server does not connect to it.' },
];

const MARK: Record<CheckResult['outcome'], string> = { pass: 'Passed', fail: 'Failed', skip: 'Not checked' };

function shortCommit(c: string) {
  return c === '' ? 'Not stamped (development build)' : c.slice(0, 12);
}

/**
 * The body of "About this Fathom": which build is running, its own checks, and which outside
 * connections this server has on. Separate from the sheet so the home page's About can show it too.
 */
export function ThisServer({ deps = browserDeps }: { deps?: SelfTestDeps }) {
  const [about, setAbout] = useState<About | null>(null);
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    const out = await runSelfTests(deps);
    setAbout(out.about);
    setResults(out.results);
    setRunning(false);
  }, [deps]);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <div className="about-server">
      <section aria-labelledby="about-build">
        <h3 id="about-build" className="about-server__heading">
          This build
        </h3>
        <dl className="about-server__facts">
          <div>
            <dt>Version</dt>
            <dd className="about__num">{about?.version ?? '…'}</dd>
          </div>
          <div>
            <dt>Commit</dt>
            <dd className="about__num">{about ? shortCommit(about.commit) : '…'}</dd>
          </div>
          {about?.built ? (
            <div>
              <dt>Built</dt>
              <dd className="about__num">{about.built.slice(0, 10)}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section aria-labelledby="about-checks">
        <div className="about-server__row">
          <h3 id="about-checks" className="about-server__heading">
            Checks
          </h3>
          <button type="button" className="btn-small" onClick={() => void run()} disabled={running}>
            {running ? 'Checking…' : 'Run again'}
          </button>
        </div>
        <ul className="about-checks" aria-live="polite" aria-busy={running}>
          {(results ?? []).map((r) => (
            <li key={r.id} className={`about-check about-check--${r.outcome}`} data-testid={`about-check-${r.id}`}>
              <span className="about-check__mark">{MARK[r.outcome]}</span>
              <span className="about-check__label">{r.label}</span>
              <span className="about-check__detail">{r.detail}</span>
            </li>
          ))}
          {results == null ? <li className="about__muted">Checking…</li> : null}
        </ul>
      </section>

      <section aria-labelledby="about-connections">
        <h3 id="about-connections" className="about-server__heading">
          Outside connections
        </h3>
        <p className="about__muted about-server__note">
          What this server has switched on. Anything off here makes no connection at all.
        </p>
        <ul className="about-conns">
          {CONNECTION_ROWS.map((row) => {
            const on = about?.connections[row.key];
            return (
              <li key={row.key} className="about-conn" data-testid={`about-conn-${row.key}`}>
                <span className={`about-conn__state about-conn__state--${on ? 'on' : 'off'}`}>
                  {on == null ? '…' : on ? 'On' : 'Off'}
                </span>
                <span className="about-conn__label">{row.label}</span>
                <span className="about-conn__what about__muted">{row.what}</span>
              </li>
            );
          })}
        </ul>
        <p className="about__muted about-server__note">
          The whole list, and what Fathom reads from a device, is in{' '}
          <a href="https://github.com/keyxmakerx/Fathom/blob/main/docs/IS-IT-SAFE.md" target="_blank" rel="noreferrer">
            Is it safe to point at my network?
          </a>
        </p>
      </section>
    </div>
  );
}

/** "About this Fathom", from the account menu or Ctrl K. Esc or a click outside closes it. */
export function AboutSheet({ onClose, deps }: { onClose: () => void; deps?: SelfTestDeps }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useModal(sheetRef, onClose, { focus: 'container' });
  return (
    <div className="float-scrim" onPointerDown={onClose}>
      <div
        ref={sheetRef}
        className="float-sheet about-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="About this Fathom"
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="float-sheet__head">
          <h2 className="float-sheet__title">About this Fathom</h2>
          <button type="button" className="float-sheet__close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="about-sheet__body">
          <ThisServer deps={deps} />
        </div>
      </div>
    </div>
  );
}
