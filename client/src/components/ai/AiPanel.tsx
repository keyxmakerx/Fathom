// Steward › AI and Steward › AI rules (ADR-0072; mockups r33-ai-org-a and r33-ai-keys,
// approved; split in two after the owner's note of 2026-10-27 that the connect tabs hid the
// rules beneath them). AI: one line saying what the rules allow, Connect an AI app, and the
// connections, every one for a Steward and their own for anyone else. AI rules, a Steward's
// alone: whether AI is on here, who may connect, which apps, the most any connection may
// see, how long one lasts, and who accepts its ideas. The server decides all of it again on
// every request; these pages only show and ask.

import { useCallback, useEffect, useState } from "react";

import {
  APPS,
  APP_NAME,
  KEY_DAYS,
  MAX_PER_DAY,
  MAX_PER_MINUTE,
  MAX_REMOVALS,
  changeKey,
  fetchAi,
  parseOnly,
  plainWords,
  setPolicy,
  stopKey,
  type AiKeyView,
  type AiOverview,
  type AiPolicy,
  type App,
  type Tier,
  type WorkLevels,
} from "../../api/ai";
import { fetchPeople, type Person } from "../../api/people";
import type { Scope } from "../../api/scopes";
import { HowToConnect } from "./HowToConnect";
import { lowerAll, WorkTable, workInWords } from "./WorkTable";
import {
  aiError,
  ago,
  DAY_WORDS,
  FolderChips,
  PlainWords,
  Ticks,
  TIER_WORDS,
  until,
} from "./parts";

export interface AiPanelProps {
  /** `connections`: Connect an AI app and the connections. `rules`: the Steward's policy. */
  view?: "connections" | "rules";
  organisationId: string;
  organisationName: string;
  folders: Scope[];
  /** Opens AI rules; absent where the person has no rules page. */
  onOpenRules?: () => void;
  /** Back from AI rules to the connections. */
  onOpenConnections?: () => void;
}

type Load<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

const APP_NOTE: Record<App, string> = {
  claude:
    "claude.ai, the desktop and phone apps. Held to Anthropic’s addresses.",
  "claude-code":
    "Runs on the person’s computer. Fathom cannot tell it from another program there.",
  other:
    "Any app that registers itself. Fathom shows it by its name and return address, which it cannot check.",
};

export function keyAppName(key: AiKeyView): string {
  return key.app === "helper" ? "Fathom AI helper" : APP_NAME[key.app];
}

export function stateWords(key: AiKeyView): string {
  if (key.state === "on") return "On";
  if (key.state === "expired") return "Ended";
  if (key.stoppedByKind === "operator") return "Off by admin";
  if (key.stoppedByKind === "steward") return "Off by a Steward";
  return "Off";
}

/** What the rules allow, in one sentence, for the top of the AI page. */
export function rulesInWords(policy: AiPolicy, steward: boolean): string {
  if (!policy.allowed)
    return steward
      ? "AI is off here. Nobody can connect an AI app until you turn it on in AI rules."
      : "AI is off here. A Steward can turn it on.";
  const list = (words: string[]) =>
    words.length < 2
      ? (words[0] ?? "")
      : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  const apps = policy.apps.map((a) => APP_NAME[a]);
  const appWords =
    apps.length === 0 ? "No AI app is allowed yet" : `${list(apps)} may connect`;
  const sees = list([
    "the layout",
    ...policy.ceiling.filter((t) => t !== "layout"),
  ]);
  const people =
    policy.makers.length === 1 ? "1 person" : `${policy.makers.length} people`;
  return `AI is on. ${appWords}, for ${people}, seeing at most ${sees}, for up to ${DAY_WORDS[policy.maxDays] ?? `${policy.maxDays} days`}. ${workInWords(policy.work)}`;
}

export function AiPanel({
  view = "connections",
  organisationId,
  organisationName,
  folders,
  onOpenRules,
  onOpenConnections,
}: AiPanelProps) {
  const [overview, setOverview] = useState<Load<AiOverview>>({
    status: "loading",
  });
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchAi(organisationId).then(
      (value) => {
        setOverview({ status: "ready", value });
        if (value.steward)
          fetchPeople(organisationId).then(
            (p) => setPeople(p.people),
            () => setPeople([]),
          );
      },
      (e: unknown) => setOverview({ status: "error", message: aiError(e) }),
    );
  }, [organisationId]);

  useEffect(() => {
    setOverview({ status: "loading" });
    setSelected(null);
    reload();
  }, [reload]);

  if (overview.status === "loading")
    return <p className="ai-muted">Loading…</p>;
  if (overview.status === "error") {
    return (
      <section className="org-page">
        <div className="org-page__title">AI</div>
        <p className="ai-error" role="alert">
          {overview.message}
        </p>
      </section>
    );
  }
  const o = overview.value;
  const key = o.keys.find((k) => k.id === selected) ?? null;

  if (view === "rules") {
    return (
      <div className="ai-org-frame">
        <section className="ai-org__main ai-rules-page" data-testid="ai-rules">
          <div className="ai-kicker">{organisationName} · Stewards only</div>
          <h2 className="ai-title">AI rules in {organisationName}</h2>
          {!o.server.allowed && (
            <p className="ai-warn" role="alert">
              Whoever runs this Fathom has turned AI access off for the whole
              server{o.server.reason ? `: “${o.server.reason}”` : "."} These
              rules wait until they turn it back on.
            </p>
          )}
          {notice && (
            <p className="ai-muted" role="status">
              {notice}{" "}
              {onOpenConnections && (
                <button
                  type="button"
                  className="ai-link"
                  onClick={onOpenConnections}
                >
                  See the connections
                </button>
              )}
            </p>
          )}
          {o.steward ? (
            <PolicyForm
              key={o.policy.version}
              organisationId={organisationId}
              policy={o.policy}
              serverWork={o.server.work}
              people={people}
              folders={folders}
              onSaved={() => {
                setNotice("Saved. It is in the organisation’s history.");
                reload();
              }}
            />
          ) : (
            <p className="ai-muted">
              Only a Steward of the whole organisation changes these.{" "}
              {rulesInWords(o.policy, false)}
            </p>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="ai-org-frame">
      <div className="ai-org" data-testid="ai-panel">
        <section className="ai-org__main">
          <div className="ai-kicker">{organisationName}</div>
          <h2 className="ai-title">AI in {organisationName}</h2>
          {!o.server.allowed && (
            <p className="ai-warn" role="alert">
              Whoever runs this Fathom has turned AI access off for the whole
              server{o.server.reason ? `: “${o.server.reason}”` : "."} Nothing
              here works until they turn it back on.
            </p>
          )}
          <div className="ai-rules-line" data-testid="ai-rules-line">
            <span>{rulesInWords(o.policy, o.steward)}</span>
            {o.steward && onOpenRules && (
              <button
                type="button"
                className="ai-btn btn-small"
                data-testid="ai-open-rules"
                onClick={onOpenRules}
              >
                {o.policy.allowed ? "Change the rules" : "Open AI rules"}
              </button>
            )}
          </div>
          <HowToConnect
            organisationId={organisationId}
            organisationName={organisationName}
            overview={o}
            folders={folders}
            onMade={() => reload()}
          />
          <KeyTable
            keys={o.keys}
            steward={o.steward}
            folders={folders}
            selected={selected}
            onSelect={setSelected}
          />
        </section>
        {key && (
          <KeyPage
            key={`${key.id}:${key.version}`}
            organisationId={organisationId}
            aiKey={key}
            policy={o.policy}
            serverWork={o.server.work}
            steward={o.steward}
            folders={folders}
            onClose={() => setSelected(null)}
            onChanged={reload}
          />
        )}
      </div>
    </div>
  );
}

function PolicyForm({
  organisationId,
  policy,
  serverWork,
  people,
  folders,
  onSaved,
}: {
  organisationId: string;
  policy: AiPolicy;
  /** The server administrator's ceiling: no kind of work may be set above it. */
  serverWork: WorkLevels;
  people: Person[];
  folders: Scope[];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<AiPolicy>(policy);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyText, setOnlyText] = useState(policy.only.join("\n"));
  const badOnly = parseOnly(onlyText).bad;
  const nameOf = (id: string) =>
    people.find((p) => p.account === id)?.name ?? "Someone";
  const changed = JSON.stringify(draft) !== JSON.stringify(policy);
  const candidates = people.filter(
    (p) => p.state === "active" && !draft.makers.includes(p.account),
  );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await setPolicy(organisationId, draft, policy.version);
      onSaved();
    } catch (e) {
      setError(aiError(e));
    } finally {
      setBusy(false);
    }
  }

  // One column, one question per section, in the order a Steward decides them: on or off,
  // who, which apps, how much, how long, and what an AI may do with ideas and changes.
  return (
    <div className="ai-policy">
      <section className="ai-rule ai-rule--first">
        <label className="ai-switch">
          <input
            type="checkbox"
            checked={draft.allowed}
            onChange={(e) => setDraft({ ...draft, allowed: e.target.checked })}
          />
          <span className="ai-switch__label">AI access allowed</span>
        </label>
        <p className="ai-muted">
          Off by default. Turning it off stops every connection here at once.
          {!draft.allowed &&
            " You can set the rules below first; they apply once it is on."}
        </p>
      </section>

      <section className="ai-rule">
        <h3 className="ai-rule__head">Who may connect AI apps</h3>
        <div className="ai-chips">
          {draft.makers.length === 0 && (
            <span className="ai-chip ai-chip--plain">Nobody yet</span>
          )}
          {draft.makers.map((id) => (
            <span key={id} className="ai-chip">
              {nameOf(id)}
              <button
                type="button"
                className="ai-chip__x"
                aria-label={`Remove ${nameOf(id)}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    makers: draft.makers.filter((m) => m !== id),
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
          {!adding && candidates.length > 0 && (
            <button
              type="button"
              className="ai-chip ai-chip--add"
              onClick={() => setAdding(true)}
            >
              + Person
            </button>
          )}
          {adding && (
            <select
              className="ai-select"
              autoFocus
              defaultValue=""
              aria-label="Add a person"
              onBlur={() => setAdding(false)}
              onChange={(e) => {
                if (e.target.value)
                  setDraft({
                    ...draft,
                    makers: [...draft.makers, e.target.value],
                  });
                setAdding(false);
              }}
            >
              <option value="" disabled>
                Choose a person
              </option>
              {candidates.map((p) => (
                <option key={p.account} value={p.account}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="ai-muted">
          Nobody else sees AI access. A person still needs Read on a folder for
          their connection to see it.
        </p>
      </section>

      <section className="ai-rule">
        <h3 className="ai-rule__head">Which AI apps may connect</h3>
        <div className="ai-ticks">
          {APPS.map((a) => (
            <label key={a} className="ai-tick">
              <input
                type="checkbox"
                checked={draft.apps.includes(a)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    apps: e.target.checked
                      ? [...draft.apps, a]
                      : draft.apps.filter((x) => x !== a),
                  })
                }
              />
              <span>
                {APP_NAME[a]}
                <span className="ai-tick__why"> · {APP_NOTE[a]}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="ai-rule">
        <h3 className="ai-rule__head">The most any connection may see</h3>
        <div className="ai-ticks">
          {(["layout", "addresses", "notes"] as Tier[]).map((t) => (
            <label key={t} className="ai-tick">
              <input
                type="checkbox"
                checked={t === "layout" || draft.ceiling.includes(t)}
                disabled={t === "layout"}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    ceiling: e.target.checked
                      ? [...draft.ceiling, t]
                      : draft.ceiling.filter((c) => c !== t),
                  })
                }
              />
              <span>{TIER_WORDS[t]}</span>
            </label>
          ))}
        </div>
        <p className="ai-muted">
          Narrowing this narrows every connection at its next request.
        </p>
      </section>

      <section className="ai-rule">
        <h3 className="ai-rule__head">Longest a connection lasts</h3>
        <div
          className="ai-seg"
          role="radiogroup"
          aria-label="Longest a connection lasts"
        >
          {KEY_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={draft.maxDays === d}
              className={
                draft.maxDays === d
                  ? "ai-seg__item ai-seg__item--on"
                  : "ai-seg__item"
              }
              onClick={() => setDraft({ ...draft, maxDays: d })}
            >
              {DAY_WORDS[d]}
            </button>
          ))}
        </div>
      </section>

      <section className="ai-rule">
        <h3 className="ai-rule__head">Ideas and changes from AI</h3>
        <div className="ai-label">A second person accepts AI ideas in</div>
        <FolderChips
          chosen={draft.secondPersonScopes}
          folders={folders}
          everyLabel="No folder"
          onChange={(next) => setDraft({ ...draft, secondPersonScopes: next })}
        />
        <p className="ai-muted">
          Elsewhere anyone with Draw accepts, including the connection’s owner.
        </p>
      </section>

      <section className="ai-rule">
        <h3 className="ai-rule__head">What an AI may do</h3>
        <WorkTable
          testId="ai-policy-work"
          value={draft.work}
          cap={serverWork}
          capWho="This server"
          onChange={(work) => setDraft({ ...draft, work })}
        />
        <p className="ai-muted">
          Ideas are steps a person carries out. Proposes means the AI sends the
          change itself: it is shown on the canvas in the plan colour and waits
          for a person to accept it. An AI never changes a design itself, and
          only proposes where its owner can draw. A connection’s owner can set
          less for their own.
        </p>
      </section>

      <section className="ai-rule">
        <h3 className="ai-rule__head">Folders</h3>
        <div className="ai-label">Ideas only, no proposed changes, in</div>
        <FolderChips
          chosen={draft.ideasOnlyScopes}
          folders={folders}
          everyLabel="No folder"
          onChange={(next) => setDraft({ ...draft, ideasOnlyScopes: next })}
        />
        <div className="ai-label">AI sees nothing in</div>
        <FolderChips
          chosen={draft.noAiScopes}
          folders={folders}
          everyLabel="No folder"
          onChange={(next) => setDraft({ ...draft, noAiScopes: next })}
        />
        <p className="ai-muted">
          A folder counts with everything inside it. A connection never reads a
          design in a folder it may not see, nor lists it.
        </p>
      </section>

      <section className="ai-rule">
        <h3 className="ai-rule__head">Only these kinds and fields</h3>
        <textarea
          className="ai-input ai-only"
          data-testid="ai-policy-only"
          rows={3}
          value={onlyText}
          placeholder={"Empty: everything a connection may see.\nDevice\nPort.description"}
          aria-label="Only these kinds and fields"
          onChange={(e) => {
            setOnlyText(e.target.value);
            setDraft({ ...draft, only: parseOnly(e.target.value).entries });
          }}
        />
        <p className={badOnly.length > 0 ? "ai-error" : "ai-muted"}>
          {badOnly.length > 0
            ? `Not a kind or a kind and field: ${badOnly.join(", ")}`
            : "One per line. A kind (Device) lets an AI add, remove and change it; a kind and a field (Device.hostname) lets it change that field only."}
        </p>
      </section>

      <section className="ai-rule">
        <h3 className="ai-rule__head">Limits</h3>
        <div className="ai-limits">
          {(
            [
              ["perMinute", "Proposals a minute", 1, MAX_PER_MINUTE],
              ["perDay", "Proposals a day", 1, MAX_PER_DAY],
              ["maxRemovals", "Removals in one proposal", 0, MAX_REMOVALS],
            ] as const
          ).map(([field, words, min, max]) => (
            <label key={field} className="ai-limit">
              <span>{words}</span>
              <input
                type="number"
                className="ai-input ai-input--num"
                data-testid={`ai-policy-${field}`}
                min={min}
                max={max}
                value={draft[field]}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n))
                    setDraft({
                      ...draft,
                      [field]: Math.min(max, Math.max(min, n)),
                    });
                }}
              />
              <span className="ai-tick__why">at most {max}</span>
            </label>
          ))}
        </div>
      </section>

      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      <div className="ai-actions ai-rules__save">
        <button
          type="button"
          className="ai-btn btn-main"
          disabled={!changed || busy || badOnly.length > 0}
          onClick={() => void save()}
        >
          Save
        </button>
        {changed && (
          <button
            type="button"
            className="ai-btn"
            disabled={busy}
            onClick={() => {
              setDraft(policy);
              setOnlyText(policy.only.join("\n"));
            }}
          >
            Undo changes
          </button>
        )}
        {changed && <span className="ai-muted">Not saved yet.</span>}
      </div>
    </div>
  );
}

function KeyTable({
  keys,
  steward,
  folders,
  selected,
  onSelect,
}: {
  keys: AiKeyView[];
  steward: boolean;
  folders: Scope[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const where = (k: AiKeyView) =>
    k.scopes.length === 0
      ? "Every folder"
      : k.scopes
          .map(
            (id) =>
              folders.find((f) => f.scopeId === id)?.displayName ?? "A folder",
          )
          .join(", ");
  const stopped = keys.filter(
    (k) =>
      k.mine &&
      k.state === "disabled" &&
      k.stoppedByKind !== "owner" &&
      k.stoppedByKind !== null,
  );
  return (
    <div className="ai-keys">
      <div className="ai-label">
        {steward ? "Every AI connection here" : "Your AI connections"}
      </div>
      {keys.length === 0 ? (
        <p className="ai-muted">
          None yet. Connect an AI app above; it shows here once you press
          Allow or make a key.
        </p>
      ) : (
        <table className="ai-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>App</th>
              {steward && <th>Person</th>}
              <th>Sees</th>
              <th>Folders</th>
              <th>Last used</th>
              <th>Ends</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr
                key={k.id}
                className={
                  k.id === selected
                    ? "ai-table__row ai-table__row--on"
                    : "ai-table__row"
                }
                onClick={() => onSelect(k.id)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(k.id);
                }}
              >
                <td className="ai-table__name">{k.label}</td>
                <td>{keyAppName(k)}</td>
                {steward && (
                  <td>
                    {k.ownerName}
                    {k.aiAccount && <div className="ai-muted">uses {k.aiAccount}</div>}
                  </td>
                )}
                <td>
                  {k.sees
                    .map((t) =>
                      t === "layout"
                        ? "Layout"
                        : t === "addresses"
                          ? "addresses"
                          : "notes",
                    )
                    .join(", ")}
                </td>
                <td>{where(k)}</td>
                <td>{ago(k.lastUsedAt)}</td>
                <td>{k.state === "on" ? until(k.expiresAt) : "—"}</td>
                <td>
                  <span
                    className={
                      k.state === "on"
                        ? "ai-state ai-state--on"
                        : "ai-state ai-state--off"
                    }
                  >
                    {stateWords(k)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {stopped.map((k) => (
        <p key={k.id} className="ai-stopped" role="note">
          <strong>
            {k.stoppedByKind === "operator"
              ? "Whoever runs this Fathom"
              : "A Steward"}{" "}
            turned off “{k.label}”
          </strong>
          {k.stoppedReason ? `: “${k.stoppedReason}”.` : "."} Connect again if
          that was you; this one stays off.
        </p>
      ))}
    </div>
  );
}

function KeyPage({
  organisationId,
  aiKey,
  policy,
  serverWork,
  steward,
  folders,
  onClose,
  onChanged,
}: {
  organisationId: string;
  aiKey: AiKeyView;
  policy: AiPolicy;
  serverWork: WorkLevels;
  steward: boolean;
  folders: Scope[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [sees, setSees] = useState<Tier[]>(aiKey.sees);
  const [scopes, setScopes] = useState<string[]>(aiKey.scopes);
  const [mayRecommend, setMayRecommend] = useState(aiKey.mayRecommend);
  // The most this connection may be set to: what the organisation and the server allow, and
  // for a Steward narrowing someone else's, no more than it has now.
  const allowed = lowerAll(policy.work, serverWork);
  const shown = lowerAll(aiKey.work, allowed);
  const [work, setWork] = useState<WorkLevels>(shown);
  const [reason, setReason] = useState("");
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = aiKey.state === "on";
  // The owner widens within the policy; a Steward only narrows someone else's.
  const narrowOnly = !aiKey.mine;
  const ceiling: Tier[] = narrowOnly ? aiKey.sees : policy.ceiling;
  const changed =
    JSON.stringify(sees) !== JSON.stringify(aiKey.sees) ||
    JSON.stringify(scopes) !== JSON.stringify(aiKey.scopes) ||
    mayRecommend !== aiKey.mayRecommend ||
    JSON.stringify(work) !== JSON.stringify(shown);
  const mayPropose = Object.values(work).includes("propose");
  const folderName = (id: string) =>
    folders.find((f) => f.scopeId === id)?.displayName ?? "a folder";
  // A Steward narrowing folders may only pick inside the ones already chosen.
  const folderChoices =
    narrowOnly && aiKey.scopes.length > 0
      ? folders.filter((f) => aiKey.scopes.includes(f.scopeId))
      : folders;

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (e) {
      setError(aiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="ai-org__side" aria-label="AI connection">
      <div className="ai-side-head">
        <div className="ai-kicker">{keyAppName(aiKey)}</div>
        <button
          type="button"
          className="ai-btn btn-small"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <h3 className="ai-subtitle">{aiKey.label}</h3>
      <dl className="ai-facts">
        <dt>Person</dt>
        <dd>
          {aiKey.ownerName}
          {aiKey.ownerEmail ? ` (${aiKey.ownerEmail})` : ""}
        </dd>
        <dt>AI account</dt>
        <dd data-testid="ai-key-account">
          {aiKey.aiAccount
            ? `${aiKey.aiAccount}, as ${aiKey.mine ? "you" : aiKey.ownerName} gave it. Fathom can’t check it.`
            : "Not given: made before Fathom asked."}
        </dd>
        <dt>Made</dt>
        <dd>{ago(aiKey.createdAt)}</dd>
        <dt>Used</dt>
        <dd>
          {aiKey.requestsToday} times today
          {aiKey.lastUsedFrom ? `, last from ${aiKey.lastUsedFrom}` : ""}
        </dd>
        <dt>Ends</dt>
        <dd>{live ? until(aiKey.expiresAt) : stateWords(aiKey)}</dd>
      </dl>

      {live && (
        <>
          <div className="ai-label">What it can see</div>
          <Ticks sees={sees} ceiling={ceiling} onChange={setSees} />
          <div className="ai-label">Designs</div>
          <FolderChips
            chosen={scopes}
            folders={folderChoices}
            onChange={setScopes}
          />
          <label className="ai-tick">
            <input
              type="checkbox"
              checked={mayRecommend}
              disabled={narrowOnly && !aiKey.mayRecommend}
              onChange={(e) => setMayRecommend(e.target.checked)}
            />
            <span>Send ideas for a person to accept</span>
          </label>
          <div className="ai-label">What it may do</div>
          <WorkTable
            testId="ai-key-work"
            value={work}
            cap={narrowOnly ? shown : allowed}
            capWho={narrowOnly ? undefined : "The organisation"}
            onChange={setWork}
          />
          <p className="ai-muted">
            {narrowOnly
              ? "You can narrow this connection or turn it off. Only its owner can widen it."
              : "Seeing less takes effect at once. Seeing more is checked against what the organisation allows."}
          </p>
          <PlainWords
            lines={plainWords(
              {
                scopes,
                sees,
                mayRecommend,
                mayChange: mayPropose,
              },
              folderName,
            )}
          />
        </>
      )}
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      {live && !stopping && (
        <div className="ai-actions">
          <button
            type="button"
            className="ai-btn btn-main"
            disabled={!changed || busy}
            onClick={() =>
              void act(() =>
                changeKey(organisationId, aiKey, {
                  sees,
                  scopes,
                  mayRecommend,
                  ...(JSON.stringify(work) !== JSON.stringify(shown)
                    ? { work }
                    : {}),
                }),
              )
            }
          >
            Save changes
          </button>
          <button
            type="button"
            className="ai-btn btn-danger"
            disabled={busy}
            onClick={() => setStopping(true)}
          >
            Turn off
          </button>
        </div>
      )}
      {live && stopping && (
        <div className="ai-stop">
          {narrowOnly && (
            <>
              <div className="ai-label">Why</div>
              <input
                className="ai-input"
                value={reason}
                maxLength={200}
                placeholder="May be compromised: used from an address we don’t know"
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="ai-muted">
                {aiKey.ownerName} sees your reason. It stops at its next request
                and can’t be turned back on.
              </p>
            </>
          )}
          {!narrowOnly && (
            <p className="ai-muted">
              It stops at its next request and can’t be turned back on. Connect
              again for a new one.
            </p>
          )}
          <div className="ai-actions">
            <button
              type="button"
              className="ai-btn btn-danger"
              disabled={busy || (narrowOnly && reason.trim() === "")}
              onClick={() =>
                void act(() =>
                  stopKey(
                    organisationId,
                    aiKey,
                    "disable",
                    narrowOnly ? reason : undefined,
                  ),
                )
              }
            >
              Turn off now
            </button>
            <button
              type="button"
              className="ai-btn"
              disabled={busy}
              onClick={() => setStopping(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {aiKey.mine && !live && (
        <div className="ai-actions">
          <button
            type="button"
            className="ai-btn"
            disabled={busy}
            onClick={() =>
              void act(() => stopKey(organisationId, aiKey, "delete"))
            }
          >
            Remove from this list
          </button>
        </div>
      )}
      {steward && !aiKey.mine && !live && aiKey.stoppedReason && (
        <p className="ai-muted">Reason given: “{aiKey.stoppedReason}”</p>
      )}
    </aside>
  );
}
