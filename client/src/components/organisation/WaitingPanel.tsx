import { useEffect, useMemo, useState } from 'react';

import {
  BATCH_CAP,
  type Asked,
  type CheckedProposal,
  type ConfirmResult,
  type SecondingItem,
  type Waiting,
} from '../../api/invitations';
import { spacedCode } from '../../api/grantBytes';
import type { Scope } from '../../api/scopes';
import {
  accessWords,
  applyEdits,
  CAPABILITY_WORD,
  confirmButton,
  confirmRowOf,
  dateLabel,
  expiryFromDays,
  initialTicks,
  splitRows,
  stewardNeeds,
  ticked,
  whenLabel,
  type RowEdit,
  type WaitingRow,
} from './model';

const CAPS: Asked[] = ['read', 'draw', 'steward'];

// ---- The table of people to confirm together ----------------------------

export interface WaitingTableProps {
  rows: readonly WaitingRow[];
  ticks: ReadonlySet<string>;
  nowMs: number;
  folders: readonly Scope[];
  organisationName: string;
  editing: string | null;
  refusing: string | null;
  busy: boolean;
  onToggle: (id: string) => void;
  onToggleAll: (on: boolean) => void;
  onEditOpen: (id: string | null) => void;
  onEditSave: (id: string, edit: RowEdit) => void;
  onRefuseAsk: (id: string | null) => void;
  onRefuse: (id: string) => void;
}

/** Name and email carry this label everywhere they appear: the steward typed them. */
export const TYPED_BY_STEWARD = 'Name and email are what the steward typed when inviting. The person has not confirmed them.';

export function WaitingTable(p: WaitingTableProps) {
  const allOn = p.rows.length > 0 && p.rows.every((r) => p.ticks.has(r.invitation.id));
  return (
    <table className="org-table org-table--waiting" data-testid="waiting-table">
      <thead>
        <tr>
          <th>
            <input type="checkbox" aria-label="Tick everyone" checked={allOn} onChange={(e) => p.onToggleAll(e.target.checked)} />
          </th>
          <th>Name (typed by the steward)</th>
          <th>Key-check code</th>
          <th>Access asked for</th>
          <th>Invited by · joined</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {p.rows.map((r) => {
          const i = r.invitation;
          return (
            <tr key={i.id}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Confirm ${i.displayName}`}
                  checked={p.ticks.has(i.id)}
                  onChange={() => p.onToggle(i.id)}
                />
              </td>
              <td>
                <strong>{i.displayName}</strong>
                <div className="org-sub">{i.contactEmail ?? 'no email typed'}</div>
              </td>
              <td>
                <code className="org-code org-code--inline">{i.keyCode === null ? '' : spacedCode(i.keyCode)}</code>
              </td>
              <td>
                {p.editing === i.id ? (
                  <EditAccess row={r} folders={p.folders} organisationName={p.organisationName} onSave={(e) => p.onEditSave(i.id, e)} onCancel={() => p.onEditOpen(null)} />
                ) : (
                  <>
                    {accessWords(r.capability, r.scopeId, r.scopeLabel)}
                    {r.changed && (
                      <div className="org-sub">
                        changed from {accessWords(i.capabilityAsked, i.scopeId, i.scopeLabel)}
                      </div>
                    )}
                  </>
                )}
              </td>
              <td>
                {i.issuedByName}
                <div className="org-sub">{i.joinedAtUnix === null ? '' : whenLabel(i.joinedAtUnix, p.nowMs)}</div>
              </td>
              <td>
                <div className="org-table__actions">
                {p.refusing === i.id ? (
                  <>
                    <button type="button" className="org-btn org-btn--primary" disabled={p.busy} onClick={() => p.onRefuse(i.id)}>
                      Refuse {i.displayName}
                    </button>
                    <button type="button" className="org-btn" onClick={() => p.onRefuseAsk(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="org-btn" disabled={p.busy} onClick={() => p.onEditOpen(i.id)}>
                      Change
                    </button>
                    <button type="button" className="org-btn" disabled={p.busy} onClick={() => p.onRefuseAsk(i.id)}>
                      Refuse
                    </button>
                  </>
                )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EditAccess({
  row,
  folders,
  organisationName,
  onSave,
  onCancel,
}: {
  row: WaitingRow;
  folders: readonly Scope[];
  organisationName: string;
  onSave: (edit: RowEdit) => void;
  onCancel: () => void;
}) {
  const [capability, setCapability] = useState<Asked>(row.capability);
  const [scope, setScope] = useState<string>(row.scopeId ?? '');
  const label = (id: string) => folders.find((f) => f.scopeId === id)?.displayName ?? row.scopeLabel;
  return (
    <span className="org-edit">
      <select aria-label="What they can do" className="org-input" value={capability} onChange={(e) => setCapability(e.target.value as Asked)}>
        {CAPS.map((c) => (
          <option key={c} value={c}>
            {CAPABILITY_WORD[c]}
          </option>
        ))}
      </select>
      <select aria-label="Where" className="org-input" value={scope} onChange={(e) => setScope(e.target.value)}>
        {row.scopeId !== null && !folders.some((f) => f.scopeId === row.scopeId) && <option value={row.scopeId}>{row.scopeLabel}</option>}
        {folders.map((f) => (
          <option key={f.scopeId} value={f.scopeId}>
            {f.displayName}
          </option>
        ))}
        <option value="">Whole organisation ({organisationName})</option>
      </select>
      <button
        type="button"
        className="org-btn org-btn--primary"
        onClick={() => onSave({ capability, scopeId: scope === '' ? null : scope, scopeLabel: scope === '' ? organisationName : label(scope) })}
      >
        Use this
      </button>
      <button type="button" className="org-btn" onClick={onCancel}>
        Cancel
      </button>
    </span>
  );
}

// ---- Everything that will be signed, shown before it is --------------

export interface ReviewProps {
  checked: CheckedProposal;
  names: Readonly<Record<string, string>>;
  labels: Readonly<Record<string, string>>;
  busy: boolean;
  /** For one steward request: the key-code tick, the expiry and what it needs. */
  steward: { acknowledged: boolean; onAcknowledge: (on: boolean) => void } | null;
  onSign: () => void;
  onBack: () => void;
}

/** The full list, before the signature. */
export function ReviewList({ checked, names, labels, busy, steward, onSign, onBack }: ReviewProps) {
  const n = checked.items.length;
  const first = checked.items[0]?.item;
  return (
    <section className="org-box" data-testid="waiting-review">
      <div className="home__label">
        {steward ? 'Check this Steward request' : `You are about to sign ${n} ${n === 1 ? 'person' : 'people'}`}
      </div>
      <ul className="org-review">
        {checked.items.map(({ item }) => (
          <li key={item.invitation}>
            <strong>{names[item.invitation] ?? item.subject}</strong> · {accessWords(item.capability, item.scopeId, labels[item.invitation] ?? '')} ·
            code <code className="org-code org-code--inline">{spacedCode(item.keyCode)}</code>
            {item.capability === 'steward' ? ` · ends ${dateLabel(item.expiresAtUnix)}` : ''}
          </li>
        ))}
      </ul>
      {steward && first && (
        <>
          <p className="org-note">{stewardNeeds(first.soleSteward)}</p>
          <label className="org-radio">
            <input type="checkbox" checked={steward.acknowledged} onChange={(e) => steward.onAcknowledge(e.target.checked)} />
            <span>I compared this code with the one on their screen, and they match.</span>
          </label>
        </>
      )}
      <p className="org-note">
        {n === 1
          ? 'One signature, in your browser, naming that person\u2019s own key.'
          : `${n} signatures, made together, in your browser, each naming that person\u2019s own key. All of them are recorded or none are.`}
        {n > 50 ? ' This many can take a minute or more. Keep this page open.' : ''}
      </p>
      <div className="org-actions">
        <button type="button" className="org-btn org-btn--primary" disabled={busy || (steward !== null && !steward.acknowledged)} onClick={onSign}>
          {busy ? 'Signing…' : `Sign and confirm ${n} ${n === 1 ? 'person' : 'people'}`}
        </button>
        <button type="button" className="org-btn" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </section>
  );
}

// ---- Steward requests: one at a time -----------------------------------

export interface StewardCardsProps {
  rows: readonly WaitingRow[];
  nowMs: number;
  busy: boolean;
  days: number;
  onDays: (days: number) => void;
  onReview: (row: WaitingRow) => void;
  onRefuse: (id: string) => void;
}

export function StewardCards({ rows, nowMs, busy, days, onDays, onReview, onRefuse }: StewardCardsProps) {
  if (rows.length === 0) return null;
  return (
    <section className="org-box" data-testid="steward-requests">
      <div className="home__label">Steward requests, one at a time</div>
      <p className="org-note">
        A Steward can invite and confirm people and remove their access. Each request is confirmed on its own, with an end date.
      </p>
      <ul className="org-review">
        {rows.map((r) => (
          <li key={r.invitation.id}>
            <strong>{r.invitation.displayName}</strong> asked to be a Steward of {r.scopeId === null ? 'the whole organisation' : r.scopeLabel}. Code{' '}
            <code className="org-code org-code--inline">{spacedCode(r.invitation.keyCode ?? '')}</code>. Joined{' '}
            {r.invitation.joinedAtUnix === null ? '' : whenLabel(r.invitation.joinedAtUnix, nowMs)}.
            <div className="org-actions">
              <label className="org-field__inline">
                Ends in
                <input
                  className="org-input org-input--narrow"
                  type="number"
                  min={2}
                  max={365}
                  value={days}
                  onChange={(e) => onDays(Number(e.target.value))}
                  aria-label="Days until the appointment ends"
                />
                days
              </label>
              <button type="button" className="org-btn org-btn--primary" disabled={busy || expiryFromDays(days, 0) === null} onClick={() => onReview(r)}>
                Review as Steward
              </button>
              <button type="button" className="org-btn" disabled={busy} onClick={() => onRefuse(r.invitation.id)}>
                Refuse
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Second steward ------------------------------------------------------

export interface SecondingListProps {
  items: readonly SecondingItem[];
  busy: boolean;
  nowMs: number;
  onApprove: (item: SecondingItem) => void;
}

export function SecondingList({ items, busy, nowMs, onApprove }: SecondingListProps) {
  if (items.length === 0) return null;
  return (
    <section className="org-box" data-testid="needs-second-steward">
      <div className="home__label">Needs a second steward</div>
      <p className="org-note">
        These Steward appointments need another steward to agree before they take effect. Approving is your own signature.
      </p>
      <ul className="org-review">
        {items.map((s) => (
          <li key={s.grant}>
            {s.granterName ?? 'A steward'} asked to make <strong>{s.subjectName}</strong> a Steward of {s.scopeId === null ? 'the whole organisation' : s.scopeLabel}. Code{' '}
            <code className="org-code org-code--inline">{spacedCode(s.keyCode)}</code>. Ends {dateLabel(s.expiresAtUnix)}
            {nowMs > s.expiresAtUnix * 1000 ? ' (already past)' : ''}.
            <div className="org-actions">
              <button type="button" className="org-btn org-btn--primary" disabled={busy} onClick={() => onApprove(s)}>
                Approve
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- The screen ------------------------------------------------------------

export interface WaitingPanelProps {
  waiting: Waiting;
  folders: readonly Scope[];
  organisationName: string;
  /** Checks a proposal for the rows; writes nothing. */
  onPropose: (rows: ReturnType<typeof confirmRowOf>[], expiresAtUnix: number | null) => Promise<CheckedProposal>;
  onSign: (checked: CheckedProposal) => Promise<ConfirmResult>;
  onRefuse: (ids: string[]) => Promise<void>;
  onApprove: (item: SecondingItem) => Promise<void>;
  /** Called after anything changed on the server. */
  onChanged: () => void;
  describeError: (error: unknown) => string;
}

type Review = { checked: CheckedProposal; steward: boolean };

export function WaitingPanel(props: WaitingPanelProps) {
  const { waiting, folders, organisationName } = props;
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const rows = useMemo(() => applyEdits(waiting.invitations, edits), [waiting, edits]);
  const split = useMemo(() => splitRows(rows), [rows]);
  const [ticks, setTicks] = useState<Set<string>>(() => initialTicks(split.batch));
  const [editing, setEditing] = useState<string | null>(null);
  const [refusing, setRefusing] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [days, setDays] = useState(365);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const nowMs = Date.now();

  // New arrivals come in ticked; what the steward unticked stays unticked.
  const batchKey = split.batch.map((r) => r.invitation.id).join(',');
  useEffect(() => {
    setTicks((current) => {
      const known = new Set(split.batch.map((r) => r.invitation.id));
      const next = new Set([...current].filter((id) => known.has(id)));
      for (const id of initialTicks(split.batch)) if (!current.has(id) && next.size < BATCH_CAP) next.add(id);
      return next;
    });
  }, [batchKey]);

  const names: Record<string, string> = {};
  const labels: Record<string, string> = {};
  for (const r of rows) {
    names[r.invitation.id] = r.invitation.displayName;
    labels[r.invitation.id] = r.scopeLabel;
  }

  const chosen = ticked(split.batch, ticks);
  const button = confirmButton(chosen.length);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await work();
    } catch (e) {
      setError(props.describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const startReview = (list: WaitingRow[], steward: boolean, expiry: number | null) =>
    act(async () => {
      const checked = await props.onPropose(list.map(confirmRowOf), expiry);
      setAcknowledged(false);
      setReview({ checked, steward });
    });

  const refuse = (ids: string[]) =>
    act(async () => {
      await props.onRefuse(ids);
      setRefusing(null);
      setDone(ids.length === 1 ? 'Refused. They get no access.' : `Refused ${ids.length} people. They get no access.`);
      props.onChanged();
    });

  const sign = () =>
    act(async () => {
      if (!review) return;
      const result = await props.onSign(review.checked);
      setReview(null);
      const second = result.confirmed.filter((c) => c.needsSecond).length;
      const n = result.confirmed.length;
      setDone(
        `Confirmed ${n} ${n === 1 ? 'person' : 'people'}.` +
          (second > 0 ? ' A Steward appointment waits for a second steward before it takes effect.' : ''),
      );
      props.onChanged();
    });

  const nothing = rows.length === 0 && waiting.seconding.length === 0;

  return (
    <section className="org-page">
      <div className="org-page__title">Waiting for you</div>
      <p className="home__muted">
        These people joined from your invitations. Ask each to read you the code on their screen: if it is not the one
        here, someone else may have used their link. Refuse that row.
      </p>
      <p className="org-note">{TYPED_BY_STEWARD}</p>
      {error && (
        <p className="home__error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="org-note" role="status">
          {done}
        </p>
      )}
      {nothing && <p className="home__muted">Nobody is waiting.</p>}

      {review ? (
        <ReviewList
          checked={review.checked}
          names={names}
          labels={labels}
          busy={busy}
          steward={review.steward ? { acknowledged, onAcknowledge: setAcknowledged } : null}
          onSign={() => void sign()}
          onBack={() => setReview(null)}
        />
      ) : (
        <>
          {split.batch.length > 0 && (
            <>
              <WaitingTable
                rows={split.batch}
                ticks={ticks}
                nowMs={nowMs}
                folders={folders}
                organisationName={organisationName}
                editing={editing}
                refusing={refusing}
                busy={busy}
                onToggle={(id) =>
                  setTicks((cur) => {
                    const next = new Set(cur);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onToggleAll={(on) => setTicks(on ? initialTicks(split.batch) : new Set())}
                onEditOpen={setEditing}
                onEditSave={(id, edit) => {
                  setEdits((cur) => ({ ...cur, [id]: edit }));
                  setEditing(null);
                }}
                onRefuseAsk={setRefusing}
                onRefuse={(id) => void refuse([id])}
              />
              <div className="org-actions">
                <button
                  type="button"
                  className="org-btn org-btn--primary"
                  disabled={busy || button.disabled}
                  onClick={() => void startReview(chosen, false, null)}
                >
                  {busy ? 'Checking…' : button.label}
                </button>
                <button
                  type="button"
                  className="org-btn"
                  disabled={busy || chosen.length === 0}
                  onClick={() => void refuse(chosen.map((r) => r.invitation.id))}
                >
                  Refuse ticked
                </button>
                <span className="org-sub">
                  {button.note ?? `Signed once, in your browser. Up to ${BATCH_CAP} at a time. You see the full list before you sign.`}
                </span>
              </div>
            </>
          )}

          <StewardCards
            rows={split.stewards}
            nowMs={nowMs}
            busy={busy}
            days={days}
            onDays={setDays}
            onReview={(r) => {
              const expiry = expiryFromDays(days, Math.floor(Date.now() / 1000));
              if (expiry !== null) void startReview([r], true, expiry);
            }}
            onRefuse={(id) => void refuse([id])}
          />

          {split.blocked.length > 0 && (
            <section className="org-box">
              <div className="home__label">Cannot be confirmed</div>
              <ul className="org-review">
                {split.blocked.map((r) => (
                  <li key={r.invitation.id}>
                    <strong>{r.invitation.displayName}</strong>:{' '}
                    {r.invitation.unverifiable
                      ? 'this invitation could not be verified.'
                      : 'joined more than 14 days ago, so they can no longer be confirmed. Invite them again if they should still join.'}
                    <div className="org-actions">
                      <button type="button" className="org-btn" disabled={busy} onClick={() => void refuse([r.invitation.id])}>
                        Refuse
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <SecondingList
            items={waiting.seconding}
            busy={busy}
            nowMs={nowMs}
            onApprove={(item) =>
              void act(async () => {
                await props.onApprove(item);
                setDone(`Approved. Your signature is recorded for ${item.subjectName}\u2019s Steward appointment.`);
                props.onChanged();
              })
            }
          />
        </>
      )}
    </section>
  );
}
