import { useEffect, useState, type FormEvent } from 'react';

import {
  consoleUrlForHost,
  fetchConsoleFlag,
  normalisePlacementHosts,
  normalisePlacementSources,
  requestPlacement,
  type PlacementRequested,
} from '../../api/placement';
import { describeConsoleError } from './describeConsoleError';
import {
  countdownSentence,
  DEFAULT_WINDOW_MINUTES,
  MAX_WINDOW_MINUTES,
  MIN_WINDOW_MINUTES,
  placementProblem,
  placementWarning,
  secondsLeft,
  formatCountdown,
} from './placementCopy';
import '../../styles/console.css';

/**
 * Where the console answers -- ADR-0055 decision 11, and the owner's own
 * instruction that it be set here rather than in a file.
 *
 * **Confirm or revert, not a delay.** The change applies the moment it is
 * saved; the guard is that this page has warned first, takes the browser to
 * the new host, and that an operator sign-in there inside the window is what
 * confirms it. If nobody signs in there, the placement reverts on its own
 * and the revert is sealed.
 *
 * **How this page knows the environment has overridden it.**
 * `FATHOM_ADMIN_HOSTS` / `FATHOM_ADMIN_SOURCES` win outright over anything
 * saved here (decision 11), and no route in this build reports that fact
 * directly. What `GET /placement/flag` does report is the deadline of an
 * unconfirmed placement, and `AdminExposure::confirm_by` returns none when
 * the environment wins. So: after a save, this page re-reads the flag, and
 * an answer of "yes, and nothing is pending" on the host that just saved a
 * placement can only mean the environment decided. That is inferred rather
 * than told, and it is said in those words on the screen.
 */
export interface PlacementFormProps {
  actingOperatorId: string;
  /** This page's own host, `window.location.host` — named in the warning so
   * the operator reads what they are leaving, not a guess at it. */
  currentHost: string;
  /** Seconds before the browser is taken to the new host. Not zero: the
   * countdown and the sentence beside it are the last chance to read what
   * just happened. */
  redirectAfterSeconds?: number;
}

type Stage =
  | { kind: 'form' }
  | { kind: 'warned' }
  | { kind: 'moved'; requested: PlacementRequested; host: string; readOnly: boolean };

export function PlacementForm({
  actingOperatorId,
  currentHost,
  redirectAfterSeconds = 5,
}: PlacementFormProps) {
  const [hosts, setHosts] = useState('');
  const [sources, setSources] = useState('');
  const [windowMinutes, setWindowMinutes] = useState(DEFAULT_WINDOW_MINUTES);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [movedAt, setMovedAt] = useState<number | null>(null);

  // One clock for the countdown and for the redirect, so the two can never
  // disagree about how long is left.
  useEffect(() => {
    if (stage.kind !== 'moved') return;
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(tick);
  }, [stage.kind]);

  useEffect(() => {
    if (stage.kind !== 'moved' || movedAt === null || stage.readOnly) return;
    if (now - movedAt < redirectAfterSeconds) return;
    window.location.assign(
      consoleUrlForHost(stage.host, {
        protocol: window.location.protocol,
        port: window.location.port,
        pathname: window.location.pathname,
      }),
    );
  }, [now, movedAt, redirectAfterSeconds, stage]);

  const draft = { hosts, sources, windowMinutes };
  const problem = placementProblem(draft);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (problem) {
      setError(problem);
      return;
    }
    setStage({ kind: 'warned' });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const requested = await requestPlacement({
        operatorId: actingOperatorId,
        hosts,
        sources,
        windowSeconds: windowMinutes * 60,
      });
      // The inference described on this component: a fresh placement is
      // always unconfirmed, so a flag that says "yes, nothing pending" on
      // this host means the environment overrode it.
      let readOnly = false;
      try {
        const flag = await fetchConsoleFlag();
        readOnly = flag.consoleHost && flag.confirmByUnix === null;
      } catch {
        // The flag is a courtesy here; its absence must not stop the
        // countdown that is already running on the server.
      }
      setMovedAt(Math.floor(Date.now() / 1000));
      setNow(Math.floor(Date.now() / 1000));
      setStage({ kind: 'moved', requested, host: normalisePlacementHosts(hosts), readOnly });
    } catch (e) {
      setError(describeConsoleError(e));
      setStage({ kind: 'form' });
    } finally {
      setBusy(false);
    }
  }

  if (stage.kind === 'moved') {
    const remaining = secondsLeft(stage.requested.confirmByUnix, now);
    const target = consoleUrlForHost(stage.host, {
      protocol: typeof window === 'undefined' ? 'http:' : window.location.protocol,
      port: typeof window === 'undefined' ? '' : window.location.port,
      pathname: typeof window === 'undefined' ? '/' : window.location.pathname,
    });
    return (
      <div className="console__form">
        <div className="console__form-title">The console has moved</div>
        <p className="console__countdown" role="status" data-testid="placement-countdown">
          {formatCountdown(remaining)}
        </p>
        <p className="console__note">{countdownSentence(stage.host, remaining)}</p>
        {stage.readOnly ? (
          <p className="console__readonly">
            The server answered that this host is still the console host and that nothing is waiting to be
            confirmed. On a host that has just saved a placement that can only mean FATHOM_ADMIN_HOSTS or
            FATHOM_ADMIN_SOURCES are set, and the environment wins over anything saved here. The row was written
            and sealed; it is not in force. Clear those variables and restart to place the console from here.
          </p>
        ) : (
          <p className="console__note">
            Taking you to <code>{target}</code>. Sign in there as the operator: the first console request that
            verifies on that host is the confirmation.{' '}
            <a href={target}>Go now</a>.
          </p>
        )}
        <p className="console__muted">
          Placement <code>{stage.requested.id}</code>, recorded on the site trail.
        </p>
      </div>
    );
  }

  if (stage.kind === 'warned') {
    return (
      <div className="console__form">
        <div className="console__form-title">Read this before the console moves</div>
        <ul className="console__warnlist">
          {placementWarning(draft, currentHost).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="console__row">
          <button type="button" className="console__btn" disabled={busy} onClick={save}>
            {busy ? 'Moving…' : `Move the console to ${normalisePlacementHosts(hosts)}`}
          </button>
          <button
            type="button"
            className="console__btn console__btn--quiet"
            disabled={busy}
            onClick={() => setStage({ kind: 'form' })}
          >
            Go back
          </button>
        </div>
        {error && (
          <p className="console__error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="console__form" onSubmit={review}>
      <div className="console__form-title">Where this console answers</div>
      <p className="console__note">
        The console can be confined to a host of its own and to the addresses it answers from — so that
        <code> /admin</code> is a 404 everywhere else, at this server as well as at your proxy. An allowlist at the
        proxy is worth having too; it is never the only gate, because sign-in with a second factor stands under it.
      </p>
      <label className="console__label" htmlFor="placement-hosts">
        Hosts, comma-separated
      </label>
      <input
        id="placement-hosts"
        className="console__input console__input--mono"
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="console.example.net"
        value={hosts}
        onChange={(e) => setHosts(e.target.value)}
        disabled={busy}
        required
      />
      <label className="console__label" htmlFor="placement-sources">
        Source addresses, comma-separated CIDRs
      </label>
      <input
        id="placement-sources"
        className="console__input console__input--mono"
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="10.0.0.0/8, 2001:db8::/32"
        value={sources}
        onChange={(e) => setSources(e.target.value)}
        disabled={busy}
      />
      <p className="console__note">
        Leave the sources empty to answer from everywhere: the server stores that as{' '}
        <code>{normalisePlacementSources('')}</code>, because the column cannot be blank, and the site trail will
        show exactly that.
      </p>
      <label className="console__label" htmlFor="placement-window">
        Window, in minutes
      </label>
      <input
        id="placement-window"
        className="console__input console__input--mono console__field--narrow"
        type="number"
        min={MIN_WINDOW_MINUTES}
        max={MAX_WINDOW_MINUTES}
        step={1}
        value={windowMinutes}
        onChange={(e) => setWindowMinutes(Number.parseInt(e.target.value, 10))}
        disabled={busy}
        required
      />
      <p className="console__note">
        How long you have to sign in on the new host before the placement reverts by itself. From{' '}
        {MIN_WINDOW_MINUTES} to {MAX_WINDOW_MINUTES} minutes; it cannot be turned off, because a move nobody has
        to confirm is a lockout nobody can undo.
      </p>
      <button type="submit" className="console__btn" disabled={busy || hosts.trim().length === 0}>
        Review this move
      </button>
      {error && (
        <p className="console__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
