// A plan's approval (sign-off r102-plan-approval, migration 0072). Where the design's folder asks
// for plans to be approved before they start, the plan panel shows where this plan stands, who
// approved or sent it back, and the buttons this person may use: ask, approve, send back, or start
// in an emergency with a reason. An emergency start stays flagged until someone approves it after.
// Every approval is signed in this browser over the plan as this screen holds it.
import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';

import { approvalWords, askApproval, fetchApprovals, planDigest, signApproval, type ApprovalKind, type DesignApprovals, type PlanApproval } from '../../api/planApprovals';
import { toHex } from '../../crypto/bytes';
import { parseNodeId } from '../../document/model';
import type { Plan } from '../../document/plans';
import { WorkPlaceContext } from '../work/WorkFields';

export interface PlanApprovalState {
  /** The folder asks; false until the server has answered. */
  required: boolean;
  /** This plan as the server holds it, once saved. */
  entry: PlanApproval | undefined;
  names: Readonly<Record<string, string>>;
  /** The plan on this screen is the one the server judged (no save in flight). */
  inStep: boolean;
  /** Start is held back: the folder asks and this version of the plan is not approved. */
  startHeld: boolean;
  busy: boolean;
  error: string | null;
  sign(kind: ApprovalKind, reason?: string): Promise<boolean>;
  ask(kind: 'ask' | 'send_back', note: string): Promise<boolean>;
}

/** The approval state of `plan`, asked again whenever what the plan says, or its stage, changes. */
export function usePlanApproval(plan: Plan): PlanApprovalState | null {
  const place = useContext(WorkPlaceContext);
  const [got, setGot] = useState<DesignApprovals | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const organisation = place?.organisationId;
  const design = place?.designId;
  const doc = place?.doc ?? null;
  const ulid = parseNodeId(plan.id).ulid;

  useEffect(() => {
    if (doc == null) return undefined;
    let cancelled = false;
    planDigest(doc, plan.id)
      .then((d) => !cancelled && setDigest(toHex(d)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, plan.id]);

  const load = useCallback(() => {
    if (organisation == null || design == null) return Promise.resolve();
    return fetchApprovals(organisation, design)
      .then(setGot)
      .catch(() => undefined);
  }, [organisation, design]);

  // Asked again when the plan's words or stage change: the server judges the saved plan, a moment
  // after this screen changed it, so a second ask follows the first.
  useEffect(() => {
    void load();
    const again = window.setTimeout(() => void load(), 1500);
    return () => window.clearTimeout(again);
  }, [load, digest, plan.stage]);

  if (place == null || doc == null) return null;
  const entry = got?.plans.find((p) => p.plan === ulid);
  const required = got?.required ?? false;
  const inStep = entry != null && digest != null && entry.digest === digest;
  const run = async (what: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await what();
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    required,
    entry,
    names: got?.names ?? {},
    inStep,
    startHeld: required && plan.stage === 'planned' && !(inStep && entry?.approved),
    busy,
    error,
    sign: (kind, reason = '') => (organisation && design ? run(() => signApproval(organisation, design, doc, plan.id, kind, reason)) : Promise.resolve(false)),
    ask: (kind, note) => (organisation && design ? run(() => askApproval(organisation, design, plan.id, kind, note)) : Promise.resolve(false)),
  };
}

const when = (at: number): string => new Date(at * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const KIND_WORDS: Record<ApprovalKind, string> = {
  before: 'Approved',
  emergency: 'Started in an emergency',
  after: 'Approved after the emergency',
};

/** The approval section in Plan mode. Nothing when the folder does not ask and nothing is flagged. */
export function PlanApprovalSection({ state, canEdit, onEmergencyStarted }: { state: PlanApprovalState | null; canEdit: boolean; onEmergencyStarted: () => void }) {
  const [form, setForm] = useState<null | 'ask' | 'send_back' | 'emergency'>(null);
  const [text, setText] = useState('');
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (form != null) field.current?.focus();
  }, [form]);
  if (state == null || !state.required) return null;
  const { entry, names } = state;
  const name = (account: string) => names[account] ?? 'Someone';
  const words = approvalWords(true, entry) ?? 'Needs approval';
  const lines = [
    ...(entry?.approvals ?? []).filter((a) => a.current || a.kind !== 'before').map((a) => ({ at: a.at, key: `a${a.at}${a.by}`, text: `${KIND_WORDS[a.kind]} by ${name(a.by)} · ${when(a.at)}`, quote: a.reason })),
    ...(entry?.asks ?? []).filter((a) => a.current).map((a) => ({ at: a.at, key: `k${a.at}${a.by}`, text: `${a.kind === 'ask' ? 'Asked for approval' : 'Sent back'} by ${name(a.by)} · ${when(a.at)}`, quote: a.note })),
  ].sort((x, y) => x.at - y.at);
  const approved = state.inStep && entry?.approved === true;
  const close = () => {
    setForm(null);
    setText('');
  };
  const submit = async () => {
    if (form == null) return;
    const t = text.trim();
    const ok =
      form === 'emergency'
        ? await state.sign('emergency', t)
        : await state.ask(form, t);
    if (ok) {
      if (form === 'emergency') onEmergencyStarted();
      close();
    }
  };
  const need = form === 'send_back' || form === 'emergency';
  return (
    <section className="plans-approval" aria-labelledby={`${id}-h`} data-testid="plans-approval">
      <h3 className="plans-label" id={`${id}-h`}>
        Approval
      </h3>
      <p className={`plans-approval__state${approved ? ' plans-approval__state--ok' : ''}`} data-testid="plans-approval-state">
        {state.inStep || entry == null ? words : 'Saving the latest change…'}
      </p>
      {lines.length > 0 && (
        <ul className="plans-approval__lines">
          {lines.map((l) => (
            <li key={l.key}>
              {l.text}
              {l.quote !== '' && <q className="plans-approval__quote">{l.quote}</q>}
            </li>
          ))}
        </ul>
      )}
      <p className="plans-note">This folder asks for plans to be approved before they start. Any change to the plan after it is approved needs approving again.</p>
      {form == null ? (
        <p className="plans-step__actions">
          {entry?.mayApprove && state.inStep && (
            <button type="button" className="plans-btn btn-main" disabled={state.busy} onClick={() => void state.sign('before')} data-testid="plans-approve">
              Approve
            </button>
          )}
          {entry?.maySendBack && state.inStep && (
            <button type="button" className="plans-btn" disabled={state.busy} onClick={() => setForm('send_back')}>
              Send back…
            </button>
          )}
          {canEdit && !approved && !entry?.mayApprove && (
            <button type="button" className="plans-btn" disabled={state.busy || !state.inStep} onClick={() => setForm('ask')} data-testid="plans-ask">
              Ask for approval
            </button>
          )}
          {entry?.mayEmergency && state.inStep && !approved && (
            <button type="button" className="plans-btn plans-btn--warn" disabled={state.busy} onClick={() => setForm('emergency')} data-testid="plans-emergency">
              Emergency start…
            </button>
          )}
        </p>
      ) : (
        <form
          className="plans-form"
          aria-label={form === 'emergency' ? 'Start in an emergency' : form === 'send_back' ? 'Send the plan back' : 'Ask for approval'}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="plans-label" htmlFor={`${id}-t`}>
            {form === 'emergency' ? 'Why it cannot wait' : form === 'send_back' ? 'What needs changing' : 'A note for the approver (optional)'}
          </label>
          <textarea
            ref={field}
            id={`${id}-t`}
            rows={form === 'emergency' ? 2 : 3}
            maxLength={form === 'emergency' ? 500 : 1000}
            value={text}
            onChange={(e) => setText(form === 'emergency' ? e.currentTarget.value.replace(/[\r\n]+/g, ' ') : e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
            }}
          />
          {form === 'emergency' && (
            <p className="plans-note">The work starts now. The plan stays flagged until a lead, a supervisor or a Steward approves it after.</p>
          )}
          <p className="plans-step__actions">
            <button type="submit" className={`plans-btn${form === 'emergency' ? ' plans-btn--warn' : ' btn-main'}`} disabled={state.busy || (need && text.trim() === '')}>
              {form === 'emergency' ? 'Start now' : form === 'send_back' ? 'Send back' : 'Ask'}
            </button>
            <button type="button" className="plans-btn" onClick={close}>
              Cancel
            </button>
          </p>
        </form>
      )}
      {state.error && (
        <p className="plans-notice" role="alert">
          {state.error}
        </p>
      )}
    </section>
  );
}

/** Under way after an emergency start: who started it and why, until someone approves it after. */
export function EmergencyFlag({ state }: { state: PlanApprovalState | null }) {
  if (state == null || state.entry == null || !state.entry.flagged) return null;
  const start = [...state.entry.approvals].reverse().find((a) => a.kind === 'emergency');
  const who = start ? (state.names[start.by] ?? 'Someone') : 'Someone';
  return (
    <section className="plans-approval plans-approval--flag" role="status" data-testid="plans-emergency-flag">
      <p className="plans-approval__state">Started in an emergency by {who}. Needs approval after.</p>
      {start && start.reason !== '' && <q className="plans-approval__quote">{start.reason}</q>}
      {state.entry.mayApproveAfter && (
        <p className="plans-step__actions">
          <button type="button" className="plans-btn btn-main" disabled={state.busy} onClick={() => void state.sign('after')} data-testid="plans-approve-after">
            Approve after the fact
          </button>
        </p>
      )}
      {state.error && (
        <p className="plans-notice" role="alert">
          {state.error}
        </p>
      )}
    </section>
  );
}
