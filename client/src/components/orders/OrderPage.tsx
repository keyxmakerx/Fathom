// One order (ADR-0084 piece 4, the r103 sketch "An order being worked"): where it's at, lane by
// lane; the jobs, with their steps, questions and results; sign-offs; what it holds; and its
// history. Every button is an act the engine checks again; a refusal is shown beside it and
// changes nothing.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { openElsewhere } from '../../api/estate';
import { actOnOrder, fetchOrder, refusalWords, type AnswerValue, type JobState, type Order, type OrderAct, type OrderField } from '../../api/orders';
import { fetchWork, type WorkRow } from '../../api/work';
import { FieldInput } from './FieldInput';
import {
  JOB_WORDS,
  answerFrom,
  answerWords,
  asksOf,
  dueAt,
  durationWords,
  finishBlocker,
  historyWords,
  isOverdue,
  jobDef,
  jobName,
  mayCancelJob,
  mayCancelOrder,
  mayPickUp,
  mayWork,
  orderNumber,
  personWords,
  signOff,
  stageOf,
  teamWords,
  whenWords,
} from './orderModel';
import { isRef, useRefNames, type Ref } from './RefPicker';

/** How often an order in view asks again: the work moves while it is open. */
export const ORDER_REFRESH_MS = 5000;

export function OrderPage({ organisationId, orderId, initial, onBack }: { organisationId: string; orderId: string; initial?: Order; onBack: () => void }) {
  const [order, setOrder] = useState<Order | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ where: string; words: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const load = useCallback(() => {
    fetchOrder(organisationId, orderId).then(
      (o) => {
        setOrder(o);
        setError(null);
      },
      (e: unknown) => setError(refusalWords(e)),
    );
  }, [organisationId, orderId]);

  useEffect(() => {
    load();
    const tick = window.setInterval(() => {
      setNow(Date.now() / 1000);
      if (document.visibilityState === 'visible' && !busy) load();
    }, ORDER_REFRESH_MS);
    return () => window.clearInterval(tick);
  }, [load, busy]);

  const act = (where: string, a: OrderAct) => {
    setBusy(true);
    setRefusal(null);
    actOnOrder(organisationId, orderId, a).then(
      (o) => {
        setOrder(o);
        setBusy(false);
      },
      (e: unknown) => {
        setRefusal({ where, words: refusalWords(e) });
        setBusy(false);
      },
    );
  };

  const refs = useMemo(() => {
    const out: Ref[] = [];
    if (order) {
      for (const v of Object.values(order.answers)) if (isRef(v)) out.push(v);
      for (const h of order.holds) out.push({ design: h.design, device: h.device, port: h.port });
    }
    return out;
  }, [order]);
  const names = useRefNames(organisationId, refs);

  if (!order) {
    return (
      <section className="order-page">
        <BackLink onBack={onBack} />
        <p className="work__muted">{error ? `Could not open the order: ${error}` : 'Opening the order…'}</p>
      </section>
    );
  }

  const customer = order.definition.fields.find((f) => f.kind === 'text' && typeof order.answers[f.key] === 'string');
  const title = customer ? `${order.name} · ${String(order.answers[customer.key])}` : order.name;
  const waitingSignOff = order.lanes.flatMap((l) => l.stages).filter((s) => s.status === 'awaiting_sign_off');

  return (
    <section className="order-page" aria-label={orderNumber(order.number, order.code)} data-testid="order-page">
      <BackLink onBack={onBack} />
      <div className="order-page__head">
        <span className="order-page__number">{orderNumber(order.number, order.code)}</span>
        <h2 className="order-page__title">{title}</h2>
        <span className={`order-page__status order-page__status--${order.status}`}>{order.status === 'open' ? 'Open' : order.status === 'done' ? 'Done' : 'Cancelled'}</span>
      </div>
      <p className="org-sub">
        Opened {whenWords(order.openedAt, now)} by {personWords(order.people, order.openedBy)} · version {order.typeVersion} of this order type
      </p>
      {error ? <p className="work__muted">Could not refresh: {error}</p> : null}

      <Track order={order} />

      {waitingSignOff.map((stage) => {
        const so = signOff(order, stage);
        return (
          <div key={stage.id} className="order-signoff" data-testid={`signoff-${stage.id}`}>
            <span>
              <b>{stage.name}</b> is done and waiting for a sign-off.
            </span>
            {so.may ? (
              <button type="button" className="btn-main" disabled={busy} onClick={() => act(`stage:${stage.id}`, { action: 'approve', stage: stage.id })}>
                Sign off {stage.name}
              </button>
            ) : (
              <span className="org-sub">{so.why}</span>
            )}
            {refusal?.where === `stage:${stage.id}` ? <span className="work-fields__error">{refusal.words}</span> : null}
          </div>
        );
      })}

      {order.lanes.map((lane) => (
        <div key={lane.id} className="order-lane">
          {order.lanes.length > 1 ? <div className="work__label">Lane · {lane.name}</div> : null}
          {lane.stages.map((stage) => {
            const shown = stage.jobs.filter((j) => j.status !== 'left_out' || stage.status !== 'not_started');
            return (
              <div key={stage.id} className={`order-stage order-stage--${stage.status}`}>
                <div className="order-stage__head">
                  <span className="order-stage__name">{stage.name}</span>
                  <span className="org-sub">
                    {stage.status === 'done' ? (stage.approvedBy ? `Signed off by ${personWords(order.people, stage.approvedBy)}` : 'Done') : stage.status === 'running' ? 'Under way' : stage.status === 'awaiting_sign_off' ? 'Waiting for a sign-off' : 'Not started'}
                  </span>
                </div>
                {shown.map((job) => (
                  <JobCard key={job.id} organisationId={organisationId} order={order} job={job} now={now} busy={busy} refusal={refusal?.where === `job:${job.id}` ? refusal.words : null} act={(a) => act(`job:${job.id}`, a)} names={names} />
                ))}
              </div>
            );
          })}
        </div>
      ))}

      <Answers organisationId={organisationId} order={order} names={names} busy={busy} refusal={refusal?.where.startsWith('answer:') ? refusal : null} act={act} />

      {order.holds.length > 0 ? (
        <div className="order-holds">
          <div className="work__label">Held for this order</div>
          <ul>
            {order.holds.map((h, i) => (
              <li key={i}>
                {order.definition.fields.find((f) => f.key === h.field)?.label ?? h.field}: {names[`${h.design}/${h.port ?? h.device}`] ?? 'a port in another design'}, from {jobName(order, h.job)} until the order closes
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <History order={order} now={now} />

      {mayCancelOrder(order) ? <CancelOrder busy={busy} refusal={refusal?.where === 'order' ? refusal.words : null} onCancel={(reason) => act('order', { action: 'cancel_order', reason })} /> : null}
    </section>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="order-link order-page__back" onClick={onBack}>
      ‹ All work
    </button>
  );
}

/** "Where it's at": one line per lane, each stage done, now, or later. */
function Track({ order }: { order: Order }) {
  return (
    <div className="order-track" aria-label="Where it’s at" data-testid="order-track">
      {order.lanes.map((lane) => {
        const nowIdx = lane.stages.findIndex((s) => s.status !== 'done');
        return (
          <div key={lane.id} className="order-track__lane">
            {order.lanes.length > 1 ? <b className="order-track__name">{lane.name}</b> : null}
            <div className="order-track__stages">
              {lane.stages.map((s, i) => (
                <span key={s.id} className={s.status === 'done' ? 'order-track__stage order-track__stage--done' : i === nowIdx && s.status !== 'not_started' ? 'order-track__stage order-track__stage--now' : 'order-track__stage'}>
                  {s.name}
                  {s.status === 'done' ? ' ✓' : s.status === 'awaiting_sign_off' ? ' · sign-off' : ''}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function JobCard({
  organisationId,
  order,
  job,
  now,
  busy,
  refusal,
  act,
  names,
}: {
  organisationId: string;
  order: Order;
  job: JobState;
  now: number;
  busy: boolean;
  refusal: string | null;
  act: (a: OrderAct) => void;
  names: Record<string, string>;
}) {
  const def = jobDef(order.definition, job.id);
  const working = mayWork(order, job);
  const [open, setOpen] = useState(working);
  const [reason, setReason] = useState<{ kind: 'send_back' | 'cancel'; text: string } | null>(null);
  const overdue = isOverdue(def, job, now);
  const due = dueAt(def, job);
  const blocker = finishBlocker(order, job);
  const asks = asksOf(order, job);
  const waits = (def?.needs ?? []).map((n) => jobName(order, n));

  const state =
    job.status === 'ready'
      ? job.pickedBy
        ? `Ready · picked up by ${personWords(order.people, job.pickedBy)}`
        : 'Ready · nobody has picked it up'
      : job.status === 'done'
        ? `Done${job.finishedBy ? ` by ${personWords(order.people, job.finishedBy)}` : ''}${job.finishedAt ? `, ${whenWords(job.finishedAt, now)}` : ''}`
        : job.status === 'cancelled'
          ? `Cancelled${job.note ? `: “${job.note}”` : ''}`
          : job.status === 'waiting' && waits.length > 0
            ? `Waiting for ${waits.join(', ')}`
            : JOB_WORDS[job.status];

  return (
    <div className={`order-job order-job--${job.status}${overdue ? ' order-job--overdue' : ''}`} data-testid={`job-${job.id}`}>
      <button type="button" className="order-job__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="order-job__name">{job.name}</span>
        <span className="order-job__team">{teamWords(order.teams, job.team)}</span>
        <span className="order-job__state">
          {state}
          {job.status === 'ready' && job.steps.length > 0 ? ` · ${job.ticks.length} of ${job.steps.length} steps` : ''}
        </span>
        <span className="order-job__due">{overdue ? <b>Overdue</b> : due !== null ? `Due ${whenWords(due, now)}` : ''}</span>
      </button>
      {open ? (
        <div className="order-job__body">
          {overdue && def && def.overdue.length > 0 ? (
            <p className="org-sub">
              Past its due time. This order type says:{' '}
              {def.overdue
                .map((r) =>
                  r.action === 'escalate'
                    ? `after ${durationWords(Math.max(r.afterMinutes, 1))}, show it to the team’s ${r.to === 'overseer' ? 'supervisor' : 'lead'}`
                    : r.action === 'move_on'
                      ? `after ${durationWords(Math.max(r.afterMinutes, 1))}, move on without it`
                      : `after ${durationWords(Math.max(r.afterMinutes, 1))}, hand it ${r.to === 'team' ? 'back to the team' : `to ${teamWords(order.teams, r.to ?? '')}`}`,
                )
                .join('; ')}
              . A lead or Steward does that by hand for now.
            </p>
          ) : null}
          {job.steps.length > 0 ? (
            <ul className="order-job__steps">
              {job.steps.map((step, i) => (
                <li key={i}>
                  <label>
                    <input type="checkbox" checked={job.ticks.includes(i)} disabled={!working || busy} onChange={(e) => act({ action: 'tick', job: job.id, step: i, done: e.currentTarget.checked })} /> {step}
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          {asks.map((f) => (
            <AskRow key={f.key} organisationId={organisationId} order={order} field={f} editable={working} busy={busy} act={act} names={names} />
          ))}
          {def?.makesPlan ? <PlanLink organisationId={organisationId} job={job} working={working} busy={busy} act={act} /> : null}
          {job.status === 'ready' || job.status === 'waiting' ? (
            <div className="order-job__actions">
              {mayPickUp(order, job) ? (
                <button type="button" className="btn-quiet" disabled={busy} onClick={() => act({ action: 'pick_up', job: job.id })}>
                  {job.pickedBy ? 'Take it over' : 'Pick it up'}
                </button>
              ) : null}
              {working && !def?.makesPlan ? (
                <button type="button" className="btn-main" disabled={busy || blocker !== null} title={blocker ?? undefined} onClick={() => act({ action: 'finish', job: job.id })}>
                  Done
                </button>
              ) : null}
              {working && def?.sendBack ? (
                <button type="button" className="btn-quiet" disabled={busy} onClick={() => setReason({ kind: 'send_back', text: '' })}>
                  {def.sendBack.label}: send it back
                </button>
              ) : null}
              {mayCancelJob(order, job, def) ? (
                <button type="button" className="btn-quiet" disabled={busy} onClick={() => setReason({ kind: 'cancel', text: '' })}>
                  Cancel this job
                </button>
              ) : null}
              {working && blocker ? <span className="org-sub">{blocker}</span> : null}
              {!working && job.status === 'ready' ? <span className="org-sub">For someone on {teamWords(order.teams, job.team)}.</span> : null}
            </div>
          ) : null}
          {reason ? (
            <div className="order-job__reason">
              <label className="work-fields__label" htmlFor={`reason-${job.id}`}>
                {reason.kind === 'send_back' ? `Why does it go back to ${stageOf(order, def?.sendBack?.to ?? '')?.stage.name ?? 'the earlier stage'}?` : 'Why is it cancelled?'}
              </label>
              <input id={`reason-${job.id}`} value={reason.text} onChange={(e) => setReason({ ...reason, text: e.currentTarget.value })} />
              <button
                type="button"
                className="btn-main"
                disabled={busy || reason.text.trim() === ''}
                onClick={() => {
                  act(reason.kind === 'send_back' ? { action: 'send_back', job: job.id, reason: reason.text.trim() } : { action: 'cancel', job: job.id, reason: reason.text.trim() });
                  setReason(null);
                }}
              >
                {reason.kind === 'send_back' ? 'Send it back' : 'Cancel the job'}
              </button>
              <button type="button" className="btn-quiet" onClick={() => setReason(null)}>
                Keep it
              </button>
            </div>
          ) : null}
          {refusal ? (
            <p className="work-fields__error" role="alert">
              {refusal}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AskRow({
  organisationId,
  order,
  field,
  editable,
  busy,
  act,
  names,
}: {
  organisationId: string;
  order: Order;
  field: OrderField;
  editable: boolean;
  busy: boolean;
  act: (a: OrderAct) => void;
  names: Record<string, string>;
}) {
  const current = order.answers[field.key];
  const [draft, setDraft] = useState<string | AnswerValue | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const editing = draft !== null;
  const save = () => {
    let value: AnswerValue | null;
    if (typeof draft === 'string') {
      const a = answerFrom(field, draft);
      if (a !== null && typeof a === 'object' && !Array.isArray(a) && 'problem' in a) {
        setProblem(a.problem);
        return;
      }
      value = a as AnswerValue | null;
    } else value = draft;
    setProblem(null);
    act({ action: 'answer', field: field.key, value });
    setDraft(null);
  };
  return (
    <div className="order-ask">
      <span className="work-fields__label">
        {field.label}
        {field.required ? ' · needed' : ''}
      </span>
      {editing ? (
        <span className="order-ask__edit">
          <FieldInput organisationId={organisationId} field={field} id={`ask-${field.key}`} value={draft as AnswerValue} onChange={(v) => setDraft(v ?? '')} />
          <button type="button" className="btn-small" disabled={busy} onClick={save}>
            Save
          </button>
          <button type="button" className="order-link" onClick={() => setDraft(null)}>
            Cancel
          </button>
          {problem ? <span className="work-fields__error">{problem}</span> : null}
        </span>
      ) : (
        <span className="order-ask__value">
          {answerWords(field, current, names)}
          {editable ? (
            <button type="button" className="order-link order-link--quiet" onClick={() => setDraft(current === undefined ? '' : typeof current === 'number' ? String(current) : typeof current === 'boolean' ? (current ? 'yes' : 'no') : current)}>
              {current === undefined ? 'Answer' : 'Change'}
            </button>
          ) : null}
        </span>
      )}
    </div>
  );
}

/** A `makes: plan` job: link the maintenance plan it makes, from the plans this person can see;
 * the job is done when that plan is recorded. */
function PlanLink({ organisationId, job, working, busy, act }: { organisationId: string; job: JobState; working: boolean; busy: boolean; act: (a: OrderAct) => void }) {
  const [plans, setPlans] = useState<WorkRow[] | null>(null);
  const [pick, setPick] = useState('');
  useEffect(() => {
    if (job.plan || !working) return;
    let live = true;
    fetchWork(organisationId).then(
      (a) => live && setPlans(a.rows.filter((r) => r.kind === 'plan')),
      () => live && setPlans([]),
    );
    return () => {
      live = false;
    };
  }, [organisationId, job.plan, working]);
  if (job.plan) {
    const plan = job.plan;
    return (
      <div className="order-ask">
        <span className="work-fields__label">Plan</span>
        <span className="order-ask__value">
          <button type="button" className="order-link" onClick={() => openElsewhere(plan.design, plan.plan)}>
            Open the plan
          </button>
          <span className="org-sub">{job.status === 'done' ? 'Recorded, so this job is done.' : 'This job is done when the plan is recorded.'}</span>
        </span>
      </div>
    );
  }
  if (!working) return <p className="org-sub">This job makes a maintenance plan. It is done when that plan is recorded.</p>;
  return (
    <div className="order-ask">
      <span className="work-fields__label">Plan</span>
      <span className="order-ask__edit">
        {plans === null ? (
          <span className="org-sub">Finding plans…</span>
        ) : plans.length === 0 ? (
          <span className="org-sub">Make the maintenance plan in its design first; it shows here to link.</span>
        ) : (
          <>
            <select aria-label="Plan this job makes" value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
              <option value="">Choose a plan…</option>
              {plans.map((p) => (
                <option key={`${p.design}:${p.element}`} value={`${p.design}\n${p.element}`}>
                  {p.number !== null ? `W-${p.number} · ` : ''}
                  {p.title}
                  {p.designName ? ` (${p.designName})` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-small"
              disabled={busy || pick === ''}
              onClick={() => {
                const [design, plan] = pick.split('\n');
                act({ action: 'link_plan', job: job.id, design, plan });
              }}
            >
              Link it
            </button>
          </>
        )}
      </span>
    </div>
  );
}

function Answers({
  organisationId,
  order,
  names,
  busy,
  refusal,
  act,
}: {
  organisationId: string;
  order: Order;
  names: Record<string, string>;
  busy: boolean;
  refusal: { where: string; words: string } | null;
  act: (where: string, a: OrderAct) => void;
}) {
  const askedByJob = new Set(order.definition.lanes.flatMap((l) => l.stages.flatMap((s) => s.jobs.flatMap((j) => j.asks))));
  const atOpen = order.definition.fields.filter((f) => !askedByJob.has(f.key));
  const [editing, setEditing] = useState<{ key: string; draft: string | AnswerValue; reason: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="order-answers" data-testid="order-answers">
      <div className="work__label">The order</div>
      <dl className="order-answers__list">
        {atOpen.map((f) => (
          <div key={f.key} className="order-answers__row">
            <dt>{f.label}</dt>
            <dd>
              {editing?.key === f.key ? (
                <span className="order-ask__edit">
                  <FieldInput organisationId={organisationId} field={f} id={`answer-${f.key}`} value={editing.draft as AnswerValue} onChange={(v) => setEditing({ ...editing, draft: v ?? '' })} />
                  <input aria-label="Why it changes (needed once its stage is done)" placeholder="Why it changes" value={editing.reason} onChange={(e) => setEditing({ ...editing, reason: e.currentTarget.value })} />
                  <button
                    type="button"
                    className="btn-small"
                    disabled={busy}
                    onClick={() => {
                      let value: AnswerValue | null;
                      if (typeof editing.draft === 'string') {
                        const a = answerFrom(f, editing.draft);
                        if (a !== null && typeof a === 'object' && !Array.isArray(a) && 'problem' in a) {
                          setProblem(a.problem);
                          return;
                        }
                        value = a as AnswerValue | null;
                      } else value = editing.draft;
                      setProblem(null);
                      act(`answer:${f.key}`, { action: 'answer', field: f.key, value, reason: editing.reason.trim() || undefined });
                      setEditing(null);
                    }}
                  >
                    Save
                  </button>
                  <button type="button" className="order-link" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  {problem ? <span className="work-fields__error">{problem}</span> : null}
                </span>
              ) : (
                <>
                  {answerWords(f, order.answers[f.key], names)}
                  {order.status === 'open' ? (
                    <button
                      type="button"
                      className="order-link order-link--quiet order-answers__change"
                      onClick={() => {
                        const c = order.answers[f.key];
                        setEditing({ key: f.key, draft: c === undefined ? '' : typeof c === 'number' ? String(c) : typeof c === 'boolean' ? (c ? 'yes' : 'no') : c, reason: '' });
                      }}
                    >
                      Change
                    </button>
                  ) : null}
                </>
              )}
              {refusal?.where === `answer:${f.key}` ? <div className="work-fields__error">{refusal.words}</div> : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function History({ order, now }: { order: Order; now: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="order-history">
      <button type="button" className="btn-quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide the history' : `Show the history (${order.history.length})`}
      </button>
      {open ? (
        <ol className="order-history__list" data-testid="order-history">
          {order.history.map((h) => (
            <li key={h.seq}>
              <span className="org-sub">{whenWords(h.at, now)}</span> {personWords(order.people, h.by)} {historyWords(order, h.action, h.detail)}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function CancelOrder({ busy, refusal, onCancel }: { busy: boolean; refusal: string | null; onCancel: (reason: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <div className="order-cancel">
      {asking ? (
        <span className="order-job__reason">
          <label className="work-fields__label" htmlFor="cancel-order-reason">
            Why is the whole order cancelled?
          </label>
          <input id="cancel-order-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <button type="button" className="btn-danger" disabled={busy || reason.trim() === ''} onClick={() => onCancel(reason.trim())}>
            Cancel the order
          </button>
          <button type="button" className="btn-quiet" onClick={() => setAsking(false)}>
            Keep it open
          </button>
        </span>
      ) : (
        <button type="button" className="btn-quiet" onClick={() => setAsking(true)}>
          Cancel this order…
        </button>
      )}
      {refusal ? <p className="work-fields__error">{refusal}</p> : null}
    </div>
  );
}
