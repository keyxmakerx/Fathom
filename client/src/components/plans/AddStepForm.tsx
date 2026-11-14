// The add-step form: pick the kind, then the things from the design itself (never a typed id).
import { useContext, useEffect, useId, useMemo, useRef, useState, type ClipboardEventHandler, type RefObject } from 'react';

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
import { FirmwareContext, type FirmwareApi } from '../firmware/context';
import { chosenFor, deviceFirmware } from '../../document/firmware';
import { STATE_LABEL, itemTitle, sparesFor } from '../../document/stock';
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

/** Where the form is: asking what kind of change, writing a step of that kind, or planning a firmware upgrade. */
type Stage = 'ask' | 'form' | 'firmware';

/** One line under each choice on "What kind of change?". */
const KIND_HINT: Record<StepKind, string> = {
  address: "A device's management address",
  route: 'A route, written before and after',
  cable: 'Connect two ports, or remove a cable',
  move: 'A device to another rack or unit',
  lag: 'Bundle ports into a LAG',
  swap: 'A card, power supply or optic',
  other: 'Anything else, in words',
};

/** The firmware choice's own part of the form: the device, the version it goes to, and the button that
 * adds the upgrade's steps and checks to this plan (the same ones the device's Firmware section writes). */
export function FirmwareStep({
  api,
  device,
  devices,
  onDevice,
  onAdd,
  refEl,
}: {
  api: FirmwareApi;
  device: string;
  devices: readonly Choice[];
  onDevice: (v: string) => void;
  onAdd: () => void;
  refEl: RefObject<HTMLSelectElement | null>;
}) {
  const fw = device !== '' ? deviceFirmware(api.doc, device) : null;
  const chosen = fw ? chosenFor(api.doc, fw) : null;
  const model = fw?.models[0] ?? null;
  return (
    <>
      <Pick refEl={refEl} label="Device" value={device} onChange={onDevice} choices={devices} />
      {fw === null ? null : chosen === null ? (
        <p className="plans-members__none" data-testid="plans-firmware-none">
          No version is chosen for {model ?? 'this device'} yet. {model !== null ? 'Choose one on its Firmware page, then come back.' : "Choose one in the device's Firmware section, then come back."}
        </p>
      ) : (
        <p className="plans-firmware__to" data-testid="plans-firmware-to">
          {fw.osVersion !== '' ? `${fw.osVersion} to ${chosen.version}` : `To ${chosen.version}`}
          {chosen.target ? `, the version chosen for ${chosen.target.model}` : ', the version chosen for this device'}. Adds the upgrade&apos;s steps and its three checks, as the Firmware section
          does.
          {fw.hold !== null ? ` Held: ${fw.hold}` : ''}
        </p>
      )}
      {fw !== null && chosen === null && model !== null ? (
        <button type="button" className="plans-btn" onClick={() => api.openModel(model)}>
          Open {model}&apos;s Firmware page
        </button>
      ) : null}
      <button type="button" className="plans-btn btn-main" disabled={chosen === null} onClick={onAdd}>
        Add firmware upgrade
      </button>
    </>
  );
}

/** Collapsed behind a button; open from the start when the plan has no steps, and when a right-click fills it. */
/** `branch`: the form adds to that main-line step's If path (sign-off r73) instead of the main line. */
export function AddStepForm({ controller, stepCount, branch }: { controller: PlansController; stepCount: number; branch?: { stepId: string; label: string } }) {
  const { doc, canon } = controller;
  // A right-click fills the main line's form, never an If path's.
  const prefill = branch ? null : controller.prefill;
  const words = branch ? `Add a step to step ${branch.label}'s If path` : 'Add a step';
  const [form, setForm] = useState<StepForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  // Any paste into any text field of this form sends the whole form through the redaction gate.
  const paste = usePasteMark();
  const first = useRef<HTMLSelectElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(stepCount === 0);
  // The first step asks what kind of change it is (sign-off r120); a port, cable or part right-click skips it.
  const [stage, setStage] = useState<Stage>('ask');
  const firstKind = useRef<HTMLButtonElement>(null);
  // Moves focus again when the stage is asked for twice (a second right-click while the form is open).
  const [focusTick, setFocusTick] = useState(0);
  const firmwareApi = useContext(FirmwareContext);
  // Firmware goes on the main line only: an upgrade writes its own steps and checks.
  const firmware = !branch && firmwareApi !== null && firmwareApi.canEdit ? firmwareApi : null;
  // Focus follows the form opening (the first control) or closing (the button that opens it).
  const moveFocus = useRef<'in' | 'out' | null>(null);
  useEffect(() => {
    if (moveFocus.current === 'in') (stage === 'ask' ? firstKind.current : first.current)?.focus();
    else if (moveFocus.current === 'out') opener.current?.focus();
    moveFocus.current = null;
  }, [open, stage, focusTick]);
  const goTo = (next: Stage) => {
    moveFocus.current = 'in';
    setStage(next);
    setFocusTick((t) => t + 1);
  };
  const set = <K extends keyof StepForm>(k: K, v: StepForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  // A right-click on a thing starts the form with that thing in it.
  const seen = useRef(0);
  useEffect(() => {
    if (prefill != null && prefill.token !== seen.current) {
      seen.current = prefill.token;
      setForm(prefill.form);
      goTo(prefill.ask ? 'ask' : 'form');
      setOpen(true);
    }
  }, [prefill]);

  const devices = useMemo(() => (doc ? devicesOf(doc, canon) : []), [doc, canon]);
  const racks = useMemo(() => (doc ? racksOf(doc, canon) : []), [doc, canon]);
  const cables = useMemo(() => (doc && form.kind === 'cable' && form.cableMode === 'cut' ? cablesOf(doc, canon) : []), [doc, canon, form.kind, form.cableMode]);
  const portsA = useMemo(() => (doc && form.device !== '' ? portsOfDevice(doc, canon, form.device) : []), [doc, canon, form.device]);
  const portsB = useMemo(() => (doc && form.deviceB !== '' ? portsOfDevice(doc, canon, form.deviceB) : []), [doc, canon, form.deviceB]);
  const members = useMemo(() => (doc && form.kind === 'lag' && form.device !== '' ? lagMembers(doc, form.device) : []), [doc, form.kind, form.device]);
  const parts = useMemo(() => (doc && form.kind === 'swap' && form.device !== '' ? partsOfDevice(doc, canon, form.device) : []), [doc, canon, form.kind, form.device]);
  const spares = useMemo(
    () =>
      doc && form.kind === 'swap' && form.part !== ''
        ? sparesFor(doc, form.part).map((i) => ({
            id: i.id,
            name: [itemTitle(i), i.serial ? `serial ${i.serial}` : '', i.state === 'spare' ? '' : STATE_LABEL[i.state].toLowerCase()].filter(Boolean).join(' · '),
            item: i,
          }))
        : [],
    [doc, form.kind, form.part],
  );
  const lagDefault = useMemo(() => (doc && form.kind === 'lag' && form.device !== '' ? nextLagName(doc, form.device) : ''), [doc, form.kind, form.device]);
  const kindChoices: readonly (StepKind | 'firmware')[] = firmware ? [...STEP_KINDS.filter((k) => k !== 'other'), 'firmware', 'other'] : STEP_KINDS;
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
          {words}
        </button>
      </p>
    );
  }

  return (
    <form
      className="plans-form"
      aria-label={words}
      data-testid="plans-add-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || stage !== 'form') return;
        setBusy(true);
        void (branch ? controller.addIfStep(branch.stepId, form, paste.pasted) : controller.addStep(form, paste.pasted)).then((ok) => {
          setBusy(false);
          if (ok) {
            setForm({ ...EMPTY_FORM, kind: form.kind });
            paste.reset();
          }
        });
      }}
    >
      <h3 className="plans-label">{words}</h3>
      {stage === 'ask' ? (
        <fieldset className="plans-kinds" data-testid="plans-kinds">
          <legend id={kindId}>What kind of change?</legend>
          {form.device !== '' && <p className="plans-kinds__for">For {devices.find((d) => d.id === form.device)?.name ?? 'this device'}</p>}
          <ul className="plans-kinds__list">
            {kindChoices.map((k, i) => (
              <li key={k}>
                <button
                  ref={i === 0 ? firstKind : undefined}
                  type="button"
                  className="plans-kinds__choice"
                  data-kind={k}
                  onClick={() => {
                    if (k === 'firmware') goTo('firmware');
                    else {
                      set('kind', k);
                      goTo('form');
                    }
                  }}
                >
                  <span className="plans-kinds__word">{k === 'firmware' ? 'Firmware upgrade' : KIND_WORD[k]}</span>
                  <span className="plans-kinds__hint">{k === 'firmware' ? 'To the version chosen for its model' : KIND_HINT[k]}</span>
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : (
        <p className="plans-kinds__picked" data-testid="plans-kind-picked">
          <span>
            Kind: <strong>{stage === 'firmware' ? 'Firmware upgrade' : KIND_WORD[form.kind]}</strong>
          </span>{' '}
          <button type="button" className="plans-link" onClick={() => goTo('ask')}>
            Change
          </button>
        </p>
      )}

      {stage === 'firmware' && firmware && (
        <FirmwareStep
          api={firmware}
          refEl={first}
          device={form.device}
          devices={devices}
          onDevice={(v) => set('device', v)}
          onAdd={() => {
            if (form.device === '') return;
            firmware.planUpgrade([form.device], controller.plan ? { intoPlan: controller.plan.id } : {});
            setForm(EMPTY_FORM);
            goTo('ask');
          }}
        />
      )}

      {stage === 'form' && (
        <>
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
                <Pick label="Part" value={form.part} onChange={(v) => setForm((f) => ({ ...f, part: v, spare: '' }))} choices={parts} />
              )}
              {spares.length > 0 ? (
                <Pick
                  label="From stock"
                  value={form.spare}
                  empty="Not from stock"
                  choices={spares}
                  onChange={(v) => {
                    const pick = spares.find((s) => s.id === v)?.item;
                    setForm((f) => ({ ...f, spare: v, value: pick?.serial ?? f.value, partModel: pick?.model ?? f.partModel }));
                  }}
                />
              ) : form.part !== '' ? (
                <p className="plans-members__none">No spare of this sort in stock. Add one on the Inventory, Parts, On hand.</p>
              ) : null}
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
          <button type="submit" className="plans-btn btn-main" disabled={busy || !controller.canEdit}>
            Add step
          </button>
        </>
      )}
      {/* Said on every stage: the form's text fields store what is typed as typed. */}
      <TypedSentence />
      <button
        type="button"
        className="plans-btn"
        onClick={() => {
          moveFocus.current = 'out';
          setOpen(false);
          setStage('ask');
        }}
      >
        Close
      </button>
    </form>
  );
}
