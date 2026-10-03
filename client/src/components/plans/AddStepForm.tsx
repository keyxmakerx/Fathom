// The add-step form: pick the kind, then the things from the design itself (never a typed id).
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';

import { STEP_KINDS, type StepKind } from '../../document/plans';
import {
  EMPTY_FORM,
  KIND_WORD,
  cablesOf,
  devicesOf,
  portsOfDevice,
  racksOf,
  type Choice,
  type StepForm,
} from './plansModel';
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

function Field({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input id={id} className="plans-input" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

/** Collapsed behind a button; open from the start when the plan has no steps, and when a right-click fills it. */
export function AddStepForm({ controller, stepCount }: { controller: PlansController; stepCount: number }) {
  const { doc, canon, prefill } = controller;
  const [form, setForm] = useState<StepForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
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
  const kindId = useId();
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
        void controller.addStep(form).then((ok) => {
          setBusy(false);
          if (ok) setForm({ ...EMPTY_FORM, kind: form.kind });
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

      {form.kind === 'address' && <Field label="New management address" value={form.value} onChange={(v) => set('value', v)} placeholder="10.0.1.1" />}

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

      {(form.kind === 'route' || form.kind === 'other') && (
        <>
          <Pick refEl={first} label="About (optional)" value={form.device} onChange={(v) => set('device', v)} choices={devices} empty="No device" />
          <Field label="Before" value={form.before} onChange={(v) => set('before', v)} />
          <Field label="After" value={form.after} onChange={(v) => set('after', v)} />
        </>
      )}

      <Field label={form.kind === 'route' || form.kind === 'other' ? 'What changes' : 'What changes (optional)'} value={form.change} onChange={(v) => set('change', v)} />
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
