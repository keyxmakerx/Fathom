// "Connect an AI app" (ADR-0072 decisions 14 to 17; mockup r33-ai-reach3-a, approved
// 2026-10-25). An AI app such as Claude sends the person here, at `/oauth/authorize`, to
// sign in and choose what it may read. Nothing is shared until Allow; Allow makes a
// connection in one organisation, which shows under Organisation › AI, where the person or
// a Steward can narrow it or turn it off.

import { useEffect, useMemo, useState } from 'react';

import {
  APP_NAME,
  answerConnect,
  checkConnect,
  cleanAccount,
  fetchAi,
  plainWords,
  safeRedirect,
  type AiOverview,
  type ConnectCheck,
  type Tier,
} from '../../api/ai';
import type { Organisation } from '../../api/organisations';
import { fetchOrganisations } from '../../api/organisations';
import { fetchScopes, type Scope } from '../../api/scopes';
import { aiError, DayChoice, FolderChips, Info, PlainWords, Ticks } from './parts';

type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

export interface ConnectAiAppProps {
  /** The app's sign-in request: this page's query string. */
  query: string;
  /** Leave the page without answering the app (to Home). */
  onLeave: () => void;
  /** Where the browser goes; a test passes its own. */
  go?: (url: string) => void;
}

export function ConnectAiApp({ query, onLeave, go = (url) => window.location.assign(url) }: ConnectAiAppProps) {
  const [check, setCheck] = useState<ConnectCheck | null>(null);
  const [orgs, setOrgs] = useState<Load<Organisation[]>>({ status: 'loading' });
  const [orgId, setOrgId] = useState<string | null>(null);
  const [overview, setOverview] = useState<Load<AiOverview>>({ status: 'loading' });
  const [folders, setFolders] = useState<Scope[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [sees, setSees] = useState<Tier[]>(['layout']);
  const [mayRecommend, setMayRecommend] = useState(true);
  const [days, setDays] = useState(90);
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkConnect(query).then(setCheck, () =>
      setCheck({ ok: false, description: 'Fathom could not be reached to check this sign-in.', back: null }),
    );
    fetchOrganisations().then(
      (value) => {
        setOrgs({ status: 'ready', value });
        if (value.length > 0) setOrgId(value[0].organisationId);
      },
      (e: unknown) => setOrgs({ status: 'error', message: aiError(e) }),
    );
  }, [query]);

  useEffect(() => {
    if (orgId === null) return;
    setOverview({ status: 'loading' });
    setScopes([]);
    setError(null);
    fetchAi(orgId).then(
      (value) => {
        setOverview({ status: 'ready', value });
        setSees((s) => s.filter((t) => t === 'layout' || value.policy.ceiling.includes(t)));
        setDays((d) => (d > value.policy.maxDays ? value.policy.maxDays : d));
      },
      (e: unknown) => setOverview({ status: 'error', message: aiError(e) }),
    );
    fetchScopes(orgId).then(setFolders, () => setFolders([]));
  }, [orgId]);

  const app = check?.ok ? check.app : null;
  const appName = app ? (app.kind === 'other' ? app.name || app.returnsTo : APP_NAME[app.kind]) : 'An AI app';
  const orgName = orgs.status === 'ready' ? (orgs.value.find((o) => o.organisationId === orgId)?.displayName ?? '') : '';

  // Why Allow cannot be pressed here, in words that say who can change it.
  const blocked = useMemo((): string | null => {
    if (overview.status !== 'ready' || !app) return null;
    const o = overview.value;
    if (!o.server.allowed) return 'Whoever runs this Fathom has turned AI access off for the whole server.';
    if (!o.policy.allowed) return `AI access is off in ${orgName}. A Steward there can turn it on under Organisation › AI.`;
    if (!o.canMake) return `You are not one of the people a Steward in ${orgName} has named to connect AI apps. Ask one to add you under Organisation › AI.`;
    if (!o.policy.apps.includes(app.kind)) {
      return `${app.kind === 'other' ? 'Apps other than Claude and Claude Code are' : `${APP_NAME[app.kind]} is`} not allowed in ${orgName}. A Steward can allow it under Organisation › AI.`;
    }
    return null;
  }, [overview, app, orgName]);

  async function answer(allow: boolean) {
    if (orgId === null) return;
    setBusy(true);
    setError(null);
    try {
      const { redirect } = await answerConnect(
        orgId,
        query,
        allow ? { allow: true, aiAccount: cleanAccount(account) ?? '', scopes, sees, mayRecommend, days } : { allow: false },
      );
      if (!safeRedirect(redirect)) throw new Error('The app’s return address is not one Fathom will send you to.');
      go(redirect);
    } catch (e) {
      setError(aiError(e));
      setBusy(false);
    }
  }

  if (check === null) {
    return (
      <div className="ai-connect">
        <p className="ai-muted">Checking what the app asked for…</p>
      </div>
    );
  }

  if (!check.ok) {
    return (
      <div className="ai-connect">
        <div className="ai-connect__main">
          <div className="ai-kicker">Connect an AI app</div>
          <h1 className="ai-title">This sign-in can’t go ahead</h1>
          <p className="ai-body" role="alert">
            {check.description}
          </p>
          <p className="ai-muted">Nothing was shared. Start again from the AI app.</p>
          <div className="ai-actions">
            {check.back && safeRedirect(check.back) && (
              <button type="button" className="ai-btn" onClick={() => go(check.back as string)}>
                Back to the app
              </button>
            )}
            <button type="button" className="ai-btn" onClick={onLeave}>
              Go to Fathom
            </button>
          </div>
        </div>
      </div>
    );
  }

  const ready = overview.status === 'ready' ? overview.value : null;
  const ceiling = ready?.policy.ceiling ?? [];
  const folderName = (id: string) => folders.find((f) => f.scopeId === id)?.displayName ?? 'a folder';
  const words = plainWords({ scopes, sees, mayRecommend }, folderName).map((l) =>
    l === 'What it reads goes to the company behind your AI app.' && app?.kind !== 'other'
      ? `What it reads goes to Anthropic, the company behind ${APP_NAME[app?.kind ?? 'claude']}.`
      : l,
  );

  return (
    <div className="ai-connect" data-testid="connect-ai-app">
      <div className="ai-connect__main">
        <div className="ai-kicker">
          {appName} wants to connect{orgName ? ` · ${orgName}` : ''}
        </div>
        <h1 className="ai-title">Let {appName} read your designs, as you</h1>
        <p className="ai-body">
          {appName} sent you here to sign in. Nothing is shared until you press Allow, and it can only ever read what you can read.
          {app && app.kind === 'other' && (
            <>
              {' '}
              It named itself “{app.name}” and returns to <code>{app.returnsTo}</code>. Fathom cannot check an app’s name, so allow it only if
              you started this from that app just now.
            </>
          )}
        </p>

        <div className="ai-label">Which organisation</div>
        {orgs.status === 'loading' && <p className="ai-muted">Loading…</p>}
        {orgs.status === 'error' && <p className="ai-error">{orgs.message}</p>}
        {orgs.status === 'ready' && (
          <>
            <div className="ai-seg" role="radiogroup" aria-label="Which organisation">
              {orgs.value.map((o) => (
                <button
                  key={o.organisationId}
                  type="button"
                  role="radio"
                  aria-checked={o.organisationId === orgId}
                  className={o.organisationId === orgId ? 'ai-seg__item ai-seg__item--on' : 'ai-seg__item'}
                  onClick={() => setOrgId(o.organisationId)}
                >
                  {o.displayName}
                </button>
              ))}
            </div>
            <p className="ai-muted">One organisation per connection. Connect again to add another.</p>
          </>
        )}

        <div className="ai-label">
          After you allow{' '}
          <Info label="What a connection is">
            A connection is like a key Fathom gives {appName}, tied to you and to one organisation. {appName} asks Fathom questions with it:
            which designs there are, and what is in one. Fathom answers only with what you ticked, and only for designs you can open
            yourself. It can never change a design; an idea it sends waits for a person. It ends on the date you pick, when you or a
            Steward turns it off, or the moment you lose access.
          </Info>
        </div>
        <ol className="ai-steps">
          <li>
            You go back to {appName}. It can use Fathom
            {app?.kind === 'claude' ? ' in claude.ai, the desktop app and the phone app.' : app?.kind === 'claude-code' ? ' in Claude Code on this computer.' : '.'}
          </li>
          <li>{appName} gets a sign-in that lasts one hour and renews itself until the end date you pick. Fathom keeps only a fingerprint of it.</li>
          <li>
            It shows up under Organisation › AI as <strong>{appName}</strong>, where you or a Steward can narrow it or turn it off.
          </li>
        </ol>
        <div className="ai-warn" data-testid="connect-work-account">
          Use the {app?.kind === 'other' ? `account your organisation gave you for ${appName}` : 'Claude account your organisation gave you'}, not a
          personal one. What {appName} reads from Fathom ends up in that account’s chats, and a personal account is outside your
          organisation’s control. Fathom cannot see which {app?.kind === 'other' ? '' : 'Claude '}account you are signed in to, so it cannot check
          this for you.
        </div>
        <label className="ai-label" htmlFor="connect-ai-account">
          Which {app?.kind === 'other' ? appName : 'Claude'} account is it signed in to?
        </label>
        <input
          id="connect-ai-account"
          className="ai-input"
          type="email"
          autoComplete="off"
          placeholder="you@yourcompany.com"
          maxLength={254}
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        />
        <p className="ai-muted">
          Your organisation’s Stewards and admins see this beside the connection, with your Fathom sign-in. Fathom can’t check it,
          so give the one you’re really using.
        </p>
        {app?.kind === 'claude' && (
          <div className="ai-warn">
            Claude connects from Anthropic’s cloud, not from your computer, so this Fathom has to be reachable from Anthropic’s addresses
            (160.79.104.0/21). Fathom accepts this connection only from there.
          </div>
        )}
        {app?.kind === 'claude-code' && (
          <div className="ai-warn">
            Claude Code runs on your computer. Fathom cannot tell it apart from another program on this computer that starts the same
            sign-in, so allow this only if you just ran it yourself.
          </div>
        )}

        {overview.status === 'error' && <p className="ai-error">{overview.message}</p>}
        {blocked && (
          <p className="ai-error" role="alert" data-testid="connect-blocked">
            {blocked}
          </p>
        )}
        {error && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
        <div className="ai-actions">
          <button
            type="button"
            className="ai-btn ai-btn--primary"
            disabled={busy || ready === null || blocked !== null || cleanAccount(account) === null}
            onClick={() => void answer(true)}
          >
            Allow
          </button>
          <button type="button" className="ai-btn" disabled={busy || orgId === null} onClick={() => void answer(false)}>
            Don’t allow
          </button>
        </div>
      </div>

      <aside className="ai-connect__side">
        <div className="ai-label">What {appName} may read</div>
        <label className="ai-tick">
          <input type="checkbox" checked={scopes.length > 0} onChange={(e) => setScopes(e.target.checked && folders[0] ? [folders[0].scopeId] : [])} />
          <span>Only these folders</span>
        </label>
        <FolderChips chosen={scopes} folders={folders} onChange={setScopes} />

        <div className="ai-label">What it can see</div>
        <Ticks sees={sees} ceiling={ceiling} onChange={setSees} />
        <label className="ai-tick">
          <input type="checkbox" checked={mayRecommend} onChange={(e) => setMayRecommend(e.target.checked)} />
          <span>Send ideas for a person to accept</span>
        </label>

        <div className="ai-label">Stops working after</div>
        <DayChoice days={days} maxDays={ready?.policy.maxDays ?? 90} onChange={setDays} />

        <PlainWords lines={words} />
      </aside>
    </div>
  );
}
