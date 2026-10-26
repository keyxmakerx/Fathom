// The add-step form: pick the kind, then the things from the design itself (never a typed id).
import { useEffect, useId, useMemo, useRef, useState, type ClipboardEventHandler, type RefObject } from 'react';

import { STEP_KINDS, lagMembers, nextLagName, type LacpMode, type StepKind } from '../../document/plans';
import {
  EMPTY_FORM,
  KIND_WORD,
  cablesOf,
  devicesOf,
  partsOfDevice,
  portsOfDevice,
  racksOf,
  type Choice,
  type StepForm,
} from './plansModel';
import { TypedSentence, usePasteMark } from './PlanParts';
import type { PlansController } from './usePlansController';

function Pick({
  label,
  value,
  onChange,
  choices,
  empty = 'Choose…',
  refEl,
}: {
  /** Takes focus when the right-click fills the form. */
  refEl?: RefObject<HTMLSelectElement | null>;
  label: string;
  value: string;
  onChange: (v: string) => void;
  choices: readonly Choice[];
  empty?: string;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select id={id} ref={refEl} className="plans-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{empty}</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  onPaste,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Text fields only: a paste marks the form. */
  onPaste?: ClipboardEventHandler;
  placeholder?: string;
  type?: string;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input id={id} className="plans-input" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onPaste={onPaste} />
    </>
  );
}

/** Collapsed behind a button; open from the start when the plan has no steps, and when a right-click fills it. */
export function AddStepForm({ controller, stepCount }: { controller: PlansController; stepCount: number }) {
  const { doc, canon, prefill } = controller;
  const [form, setForm] = useState<StepForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  // Any paste into any text field of this form sends the whole form through the redaction gate.
  const paste = usePasteMark();
  const first = useRef<HTMLSelectElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(stepCount === 0);
  // Focus follows the form opening (the first control) or closing (the button that opens it).
  const moveFocus = useRef<'in' | 'out' | null>(null);
  useEffect(() => {
    if (moveFocus.current === 'in') first.current?.focus();
    else if (moveFocus.current === 'out') opener.current?.focus();
    moveFocus.current = null;
  }, [open]);
  const set = <K extends keyof StepForm>(k: K, v: StepForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  // A right-click on a thing starts the form with that thing in it.
  const seen = useRef(0);
  useEffect(() => {
    if (prefill != null && prefill.token !== seen.current) {
      seen.current = prefill.token;
      setForm(prefill.form);
      if (open) first.current?.focus();
      else {
        moveFocus.current = 'in';
        setOpen(true);
      }
    }
  }, [prefill, open]);

  const devices = useMemo(() => (doc ? devicesOf(doc, canon) : []), [doc, canon]);
  const racks = useMemo(() => (doc ? racksOf(doc, canon) : []), [doc, canon]);
  const cables = useMemo(() => (doc && form.kind === 'cable' && form.cableMode === 'cut' ? cablesOf(doc, canon) : []), [doc, canon, form.kind, form.cableMode]);
  const portsA = useMemo(() => (doc && form.device !== '' ? portsOfDevice(doc, canon, form.device) : []), [doc, canon, form.device]);
  const portsB = useMemo(() => (doc && form.deviceB !== '' ? portsOfDevice(doc, canon, form.deviceB) : []), [doc, canon, form.deviceB]);
  const members = useMemo(() => (doc && form.kind === 'lag' && form.device !== '' ? lagMembers(doc, form.device) : []), [doc, form.kind, form.device]);
  const parts = useMemo(() => (doc && form.kind === 'swap' && form.device !== '' ? partsOfDevice(doc, canon, form.device) : []), [doc, canon, form.kind, form.device]);
  const lagDefault = useMemo(() => (doc && form.kind === 'lag' && form.device !== '' ? nextLagName(doc, form.device) : ''), [doc, form.kind, form.device]);
  const kindId = useId();
  const lacpId = useId();
  const modeId = useId();
  const faceId = useId();

  if (!open) {
    return (
      <p>
        <button
          ref={opener}
          type="button"
          className="plans-btn"
          aria-expanded={false}
          onClick={() => {
            moveFocus.current = 'in';
            setOpen(true);
          }}
        >
          Add a step
        </button>
      </p>
    );
  }

  return (
    <form
      className="plans-form"
      aria-label="Add a step"
      data-testid="plans-add-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        void controller.addStep(form, paste.pasted).then((ok) => {
          setBusy(false);
          if (ok) {
            setForm({ ...EMPTY_FORM, kind: form.kind });
            paste.reset();
          }
        });
      }}
    >
      <h3 className="plans-label">Add a step</h3>
      <label htmlFor={kindId}>Kind</label>
      <select id={kindId} className="plans-select" value={form.kind} onChange={(e) => set('kind', e.target.value as StepKind)}>
        {STEP_KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_WORD[k]}
          </option>
        ))}
      </select>

      {(form.kind === 'address' || form.kind === 'move') && <Pick refEl={first} label="Device" value={form.device} onChange={(v) => set('device', v)} choices={devices} />}

      {form.kind === 'address' && <Field label="New management address" value={form.value} onChange={(v) => set('value', v)} onPaste={paste.onPaste} placeholder="10.0.1.1" />}

      {form.kind === 'move' && (
        <>
          <Pick label="To rack" value={form.rack} onChange={(v) => set('rack', v)} choices={racks} />
          <Field label="Rack unit" type="number" value={form.positionU} onChange={(v) => set('positionU', v)} />
          <label htmlFor={faceId}>Face</label>
          <select id={faceId} className="plans-select" value={form.face} onChange={(e) => set('face', e.target.value as 'front' | 'rear')}>
            <option value="front">Front</option>
            <option value="rear">Rear</option>
          </select>
        </>
      )}

      {form.kind === 'cable' && (
        <>
          <label htmlFor={modeId}>Cable</label>
          <select id={modeId} className="plans-select" value={form.cableMode} onChange={(e) => set('cableMode', e.target.value as 'connect' | 'cut')}>
            <option value="connect">Connect two ports</option>
            <option value="cut">Remove a cable</option>
          </select>
          {form.cableMode === 'connect' ? (
            <>
              <Pick refEl={first} label="From device" value={form.device} onChange={(v) => setForm((f) => ({ ...f, device: v, portA: '' }))} choices={devices} />
              <Pick label="From port" value={form.portA} onChange={(v) => set('portA', v)} choices={portsA} />
              <Pick label="To device" value={form.deviceB} onChange={(v) => setForm((f) => ({ ...f, deviceB: v, portB: '' }))} choices={devices} />
              <Pick label="To port" value={form.portB} onChange={(v) => set('portB', v)} choices={portsB} />
            </>
          ) : (
            <Pick refEl={first} label="Which cable" value={form.cable} onChange={(v) => set('cable', v)} choices={cables} />
          )}
        </>
      )}

      {form.kind === 'lag' && (
        <>
          <Pick refEl={first} label="Device" value={form.device} onChange={(v) => setForm((f) => ({ ...f, device: v, members: [] }))} choices={devices} />
          {form.device !== '' && (
            <fieldset className="plans-members" data-testid="plans-lag-members">
              <legend>Members</legend>
              {members.length === 0 ? (
                <p className="plans-members__none">This device has no interfaces yet. Paste its config first, then plan the LAG.</p>
              ) : (
                members.map((m) => (
                  <label key={m.id}>
                    <input
                      type="checkbox"
                      checked={form.members.includes(m.id)}
                      disabled={m.inLag !== null}
                      onChange={(e) => set('members', e.target.checked ? [...form.members, m.id] : form.members.filter((x) => x !== m.id))}
                    />{' '}
                    {m.name}
                    {m.inLag !== null && <span className="plans-members__held"> · in {m.inLag}</span>}
                  </label>
                ))
              )}
            </fieldset>
          )}
          <Field label="LAG name" value={form.lagName} onChange={(v) => set('lagName', v)} placeholder={lagDefault || 'ae0'} />
          <label htmlFor={lacpId}>LACP</label>
          <select id={lacpId} className="plans-select" value={form.lacp} onChange={(e) => set('lacp', e.target.value as LacpMode)}>
            <option value="active">Active</option>
            <option value="passive">Passive</option>
            <option value="off">Off (static bundle)</option>
            <option value="">Not set</option>
          </select>
        </>
      )}

      {form.kind === 'swap' && (
        <>
          <Pick refEl={first} label="Device" value={form.device} onChange={(v) => setForm((f) => ({ ...f, device: v, part: '' }))} choices={devices} />
          {form.device !== '' && parts.length === 0 ? (
            <p className="plans-members__none">This device has no cards, swappable power supplies or optics drawn yet.</p>
          ) : (
            <Pick label="Part" value={form.part} onChange={(v) => set('part', v)} choices={parts} />
          )}
          <Field label="New serial" value={form.value} onChange={(v) => set('value', v)} onPaste={paste.onPaste} />
          <Field label="New model or part no. (if it changes)" value={form.partModel} onChange={(v) => set('partModel', v)} onPaste={paste.onPaste} />
        </>
      )}

      {(form.kind === 'route' || form.kind === 'other') && (
        <>
          <Pick refEl={first} label="About (optional)" value={form.device} onChange={(v) => set('device', v)} choices={devices} empty="No device" />
          <Field label="Before" value={form.before} onChange={(v) => set('before', v)} onPaste={paste.onPaste} />
          <Field label="After" value={form.after} onChange={(v) => set('after', v)} onPaste={paste.onPaste} />
        </>
      )}

      <Field label={form.kind === 'route' || form.kind === 'other' ? 'What changes' : 'What changes (optional)'} value={form.change} onChange={(v) => set('change', v)} onPaste={paste.onPaste} />
      <TypedSentence />
      <button type="submit" className="plans-btn plans-btn--ink" disabled={busy || !controller.canEdit}>
        Add step
      </button>
      <button
        type="button"
        className="plans-btn"
        onClick={() => {
          moveFocus.current = 'out';
          setOpen(false);
        }}
      >
        Close
      </button>
    </form>
  );
}
