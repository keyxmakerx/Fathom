// Pieces the panel and the list page share: what a plan touches, and the Why card.
import { useState, type ClipboardEventHandler, type FormEventHandler } from 'react';

import type { Plan } from '../../document/plans';
import { SEVERITY } from '../checks/checksModel';
import { WhyCard } from '../checks/ChecksPanel';
import { touchedDevices, type Choice } from './plansModel';
import { ThingName } from '../shell/ThingName';
import type { PlansController } from './usePlansController';

/** ADR-0053 section 6, as Editor's notes say it: typed text is stored as typed, pasted text meets the gate. */
export const PLAN_TYPED_SENTENCE = 'Stored as typed. Fathom does not redact what you type, only what you paste.';

/** A real `onPaste` on a field marks its form; sticky until the form is sent (Editor's `hadPaste`). */
export function usePasteMark(): { pasted: boolean; onPaste: ClipboardEventHandler; onInput: FormEventHandler; reset(): void } {
  const [pasted, setPasted] = useState(false);
  return {
    pasted,
    onPaste: () => setPasted(true),
    // Dropped text arrives as an input event, not a paste.
    onInput: (e) => {
      if (isPasteInput(e.nativeEvent as { inputType?: string })) setPasted(true);
    },
    reset: () => setPasted(false),
  };
}

/** An input event made by a paste or a drop: either way the text did not come from the keys. */
export function isPasteInput(e: { inputType?: string } | null | undefined): boolean {
  return e?.inputType === 'insertFromPaste' || e?.inputType === 'insertFromDrop';
}

export function TypedSentence() {
  return (
    <p className="plans-note plans-typed" data-testid="plans-typed">
      {PLAN_TYPED_SENTENCE}
    </p>
  );
}

export function WhySlot({ controller }: { controller: PlansController }) {
  return controller.why != null ? <WhyCard key={controller.whyToken} finding={controller.why} onClose={controller.closeWhy} /> : null;
}

/** "What it touches": the engine's reading of the design, one sentence each, and what the steps would break.
 * `stepId` narrows it to one step. Never a cause: only what is touched. */
export function Touches({ controller, plan, stepId }: { controller: PlansController; plan: Plan; stepId?: string }) {
  const { preview, unavailable } = controller;
  // A recorded plan is not read against the design again: what it touched is what it says, as recorded.
  if (plan.stage === 'recorded') {
    const devices = controller.doc ? touchedDevices(controller.doc, controller.canon, plan) : [];
    return (
      <p className="plans-note" data-testid="plans-touches-recorded">
        As recorded{devices.length > 0 ? <>: <DeviceNames devices={devices} /></> : '.'}
      </p>
    );
  }
  const rows = (preview ?? []).filter((r) => stepId === undefined || r.step === stepId);
  const label = (r: { step: string; ordinal: number }): string => plan.steps.find((s) => s.id === r.step)?.label ?? String(r.ordinal + 1);
  const shown = rows.filter((r) => r.impact.length > 0 || r.findings.length > 0 || r.error !== '');
  if (unavailable) return <p className="plans-note">Checks are not running, so what this touches is not shown.</p>;
  if (preview == null) return plan.steps.length > 0 ? <p className="plans-note">Reading the design…</p> : null;
  if (shown.length === 0) return <p className="plans-note">Nothing else in the design is touched.</p>;
  return (
    <ul className="plans-touches" data-testid="plans-touches">
      {shown.flatMap((r) => [
        ...r.impact.map((s) => (
          <li key={`${r.step}|i|${s}`} className="plans-touches__item">
            {s}
          </li>
        )),
        ...(r.error !== ''
          ? [
              <li key={`${r.step}|e`} className="plans-touches__item">
                Step {label(r)} cannot be tried against the design: {r.error}
              </li>,
            ]
          : []),
        ...r.findings.map((f) => {
          const sev = SEVERITY[f.severity];
          return (
            <li key={`${r.step}|f|${f.rule}|${f.elements.map((e) => e.id).join(',')}`} className={`plans-touches__item plans-touches__item--${f.severity}`} data-testid="plans-finding">
              <span className="plans-touches__sev">
                <span aria-hidden="true">{sev.glyph}</span> {sev.word}
              </span>{' '}
              After step {label(r)}: {f.title}
              {f.elements[0] != null && f.elements[0].name !== '' ? (
                <>
                  {' · on '}
                  <ThingName ids={[f.elements[0].id]}>{f.elements[0].name}</ThingName>
                </>
              ) : null}{' '}
              <button type="button" className="plans-link" onClick={(e) => controller.openWhy(f, e.currentTarget)}>
                Why?
              </button>
            </li>
          );
        }),
      ])}
    </ul>
  );
}

/** Sign-off r60: the devices a plan touched, each name a link to it on the canvas. */
export function DeviceNames({ devices }: { devices: readonly Choice[] }) {
  return (
    <>
      {devices.map((d, i) => (
        <span key={d.id}>
          {i > 0 ? ', ' : ''}
          <ThingName ids={[d.id]}>{d.name}</ThingName>
        </span>
      ))}
    </>
  );
}
