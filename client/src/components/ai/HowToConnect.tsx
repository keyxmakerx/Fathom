// "Connect an AI app" on Organisation › AI (ADR-0072 decisions 3 and 13). Two ways in, one
// kind of grant: an app that signs in (Claude, Claude Code, other remote MCP apps) is given
// the connector's address; an app that only starts a local MCP server uses the Fathom AI
// helper, whose key the person makes on their own computer and registers here. Fathom only
// ever holds the public half of that key.

import { useState } from 'react';

import {
  HELPER_PATH,
  cleanPublicKey,
  helperAppConfig,
  helperPairCommand,
  makeKey,
  plainWords,
  type AiKeyView,
  type AiOverview,
  type Tier,
} from '../../api/ai';
import type { Scope } from '../../api/scopes';
import { aiError, DayChoice, FolderChips, Info, PlainWords, Ticks } from './parts';

type Way = 'sign-in' | 'key';

/** Why this person cannot connect an app here, in words that say who can change it. */
export function whyCannotConnect(o: AiOverview, organisationName: string): string | null {
  if (!o.server.allowed) return 'Whoever runs this Fathom has turned AI access off for the whole server.';
  if (!o.policy.allowed) return `AI access is off in ${organisationName}. A Steward can turn it on below.`;
  if (!o.canMake) return `A Steward in ${organisationName} has to name you as someone who may connect AI apps.`;
  return null;
}

function CopyLine({ text, testId, block }: { text: string; testId?: string; block?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={block ? 'ai-copy ai-copy--block' : 'ai-copy'}>
      {block ? <pre data-testid={testId}>{text}</pre> : <code data-testid={testId}>{text}</code>}
      <button
        type="button"
        className="ai-btn ai-btn--small"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function HowToConnect({
  organisationId,
  organisationName,
  overview,
  folders,
  origin = typeof window === 'undefined' ? '' : window.location.origin,
  onMade,
}: {
  organisationId: string;
  organisationName: string;
  overview: AiOverview;
  folders: Scope[];
  /** This Fathom's address, as the helper will reach it. */
  origin?: string;
  onMade: (key: AiKeyView) => void;
}) {
  const url = overview.connector;
  const [way, setWay] = useState<Way>(url ? 'sign-in' : 'key');
  const blocked = whyCannotConnect(overview, organisationName);
  return (
    <div className="ai-how" data-testid="ai-how">
      <div className="ai-label">
        Connect an AI app{' '}
        <Info label="How AI apps connect to Fathom">
          An AI app reaches Fathom as an MCP server. An app that signs in, such as Claude, gets the address below and sends you
          to Fathom to choose what it may read. An app that only starts a program on your computer uses the Fathom AI helper
          and a key you make there. Either way it only reads, only in this organisation, only what you can see, and never
          passwords or the vault. Ideas it sends wait here for a person to accept.
        </Info>
      </div>
      <div className="ai-seg" role="radiogroup" aria-label="How your app connects">
        <button
          type="button"
          role="radio"
          aria-checked={way === 'sign-in'}
          className={way === 'sign-in' ? 'ai-seg__item ai-seg__item--on' : 'ai-seg__item'}
          onClick={() => setWay('sign-in')}
        >
          It signs in (Claude, Claude Code)
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={way === 'key'}
          className={way === 'key' ? 'ai-seg__item ai-seg__item--on' : 'ai-seg__item'}
          onClick={() => setWay('key')}
        >
          It uses a key (any app on your computer)
        </button>
      </div>
      {blocked && (
        <p className="ai-muted ai-how__blocked" data-testid="ai-how-blocked">
          {blocked}
        </p>
      )}
      {way === 'sign-in' ? (
        <SignIn url={url} />
      ) : (
        <HelperKey
          organisationId={organisationId}
          overview={overview}
          folders={folders}
          origin={origin}
          blocked={blocked !== null}
          onMade={onMade}
        />
      )}
    </div>
  );
}

function SignIn({ url }: { url: string | null }) {
  if (!url) {
    return (
      <p className="ai-muted">
        Apps can’t sign in to this Fathom yet: whoever runs it has not given it an address they can reach (
        <code>FATHOM_AI_PUBLIC_URL</code>). An app on your computer can still connect with a key.
      </p>
    );
  }
  return (
    <>
      <CopyLine text={url} testId="ai-connector-url" />
      <ul className="ai-how__list">
        <li>
          <strong>Claude</strong> (claude.ai, desktop, phone, and Claude Code on the web): Customize › Connectors › Add custom
          connector, and paste the address. Leave the advanced settings empty. A Claude Code web session started after that
          has Fathom's tools.
        </li>
        <li>
          <strong>Claude Code</strong>: <code>claude mcp add --transport http fathom {url}</code>, then <code>/mcp</code> to sign
          in.
        </li>
        <li>
          <strong>Another app</strong> that takes a remote MCP server with sign-in: the same address, if a Steward allows other
          apps.
        </li>
      </ul>
      <p className="ai-muted">
        There is nothing to copy back: the app sends you to Fathom, you choose what it may read and press Allow, and it shows
        in the list below.
      </p>
    </>
  );
}

function HelperKey({
  organisationId,
  overview,
  folders,
  origin,
  blocked,
  onMade,
}: {
  organisationId: string;
  overview: AiOverview;
  folders: Scope[];
  origin: string;
  blocked: boolean;
  onMade: (key: AiKeyView) => void;
}) {
  const policy = overview.policy;
  const [publicKey, setPublicKey] = useState('');
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [sees, setSees] = useState<Tier[]>(['layout']);
  const [mayRecommend, setMayRecommend] = useState(true);
  const [days, setDays] = useState(Math.min(90, policy.maxDays));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<AiKeyView | null>(null);
  const [file, setFile] = useState('/path/to/fathom-ai.mjs');

  const clean = cleanPublicKey(publicKey);
  const folderName = (id: string) => folders.find((f) => f.scopeId === id)?.displayName ?? 'a folder';
  const config = helperAppConfig(file.trim() || '/path/to/fathom-ai.mjs');

  async function make() {
    if (clean === null) return;
    setBusy(true);
    setError(null);
    try {
      const { key } = await makeKey(organisationId, { publicKey: clean, label: label.trim() || 'AI helper', scopes, sees, mayRecommend, days });
      setMade(key);
      setPublicKey('');
      onMade(key);
    } catch (e) {
      setError(aiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ai-helper" data-testid="ai-helper">
      <ol className="ai-steps">
        <li>
          <a href={HELPER_PATH} download="fathom-ai.mjs">
            Download the Fathom AI helper
          </a>{' '}
          (one file, needs Node 20 or later). This Fathom serves its own copy.
        </li>
        <li>
          Make a key on your computer. The private half stays there, readable by your account only:
          <CopyLine text={helperPairCommand(origin)} testId="ai-helper-pair" />
        </li>
        <li>
          Paste the line it prints, choose what the key may read, and press Make key.
          {!blocked && !made && (
            <div className="ai-helper__form">
              <textarea
                className="ai-input ai-input--key"
                aria-label="The helper’s public key"
                placeholder="04… (130 characters)"
                value={publicKey}
                spellCheck={false}
                onChange={(e) => setPublicKey(e.target.value)}
              />
              {publicKey.trim() !== '' && clean === null && (
                <p className="ai-error">That is not what the helper prints: it is 130 characters starting with 04.</p>
              )}
              <label className="ai-label" htmlFor="ai-helper-label">
                Name
              </label>
              <input
                id="ai-helper-label"
                className="ai-input"
                placeholder="AI helper on my laptop"
                maxLength={80}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <div className="ai-label">Which folders</div>
              <FolderChips chosen={scopes} folders={folders} onChange={setScopes} />
              <div className="ai-label">What it can see</div>
              <Ticks sees={sees} ceiling={policy.ceiling} onChange={setSees} />
              <label className="ai-tick">
                <input type="checkbox" checked={mayRecommend} onChange={(e) => setMayRecommend(e.target.checked)} />
                <span>Send ideas for a person to accept</span>
              </label>
              <div className="ai-label">Stops working after</div>
              <DayChoice days={days} maxDays={policy.maxDays} onChange={setDays} />
              <PlainWords lines={plainWords({ scopes, sees, mayRecommend }, folderName)} />
              {error && (
                <p className="ai-error" role="alert">
                  {error}
                </p>
              )}
              <div className="ai-actions">
                <button type="button" className="ai-btn ai-btn--primary" disabled={busy || clean === null} onClick={() => void make()}>
                  Make key
                </button>
              </div>
            </div>
          )}
          {made && (
            <p className="ai-muted" role="status" data-testid="ai-helper-made">
              Made “{made.label}”. Its key id is <code>{made.id}</code>; the helper printed the same. It is in the list below,
              where you can narrow it or turn it off.
            </p>
          )}
        </li>
        <li>
          Add the helper to your AI app, with where you saved it:
          <input
            className="ai-input"
            aria-label="Where you saved the helper"
            value={file}
            spellCheck={false}
            onChange={(e) => setFile(e.target.value)}
          />
          <div className="ai-muted">Claude Code:</div>
          <CopyLine text={config.claudeCode} testId="ai-helper-claude-code" />
          <div className="ai-muted">Claude Desktop, Cursor and other apps whose settings take an <code>mcpServers</code> list:</div>
          <CopyLine text={config.json} testId="ai-helper-json" block />
          <div className="ai-muted">
            Then <code>node fathom-ai.mjs check</code> shows what the key may do.
          </div>
        </li>
      </ol>
    </div>
  );
}
