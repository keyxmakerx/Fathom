// A check step's paste box (ADR-0080 decision 5). The person pastes what the device answered; Fathom
// compares what it can and says Matches, Differs or Can't tell. It never marks the step. What is kept
// is the paste after the redaction gate, and the comparison. Decision 9's Fetch from Termix sits here
// too, when a steward has turned it on; without it, this box is the way.

import { useId, useState } from 'react';

import { deviceFirmware } from '../../document/firmware';
import type { Plan, PlanStep } from '../../document/plans';
import { useImageHash } from '../firmware/PlanExtras';
import { FetchFromTermix } from '../termix/FetchFromTermix';
import type { ReachableDevice } from '../termix/planDevices';
import { VERDICT_WORD, compareSeen, expectationOf, isCheckStep } from './checkSeen';
import type { PlansController } from './usePlansController';

/** The verdict kept with the step, and the gated paste folded under it. */
export function SeenKept({ step }: { step: PlanStep }) {
  if (step.seen === '' && step.compared === null) return null;
  return (
    <div className="plans-seen" data-testid="plans-seen">
      {step.compared ? (
        <p className="plans-seen__verdict" data-verdict={step.compared.verdict}>
          <strong>{VERDICT_WORD[step.compared.verdict]}.</strong> {step.compared.why} <span className="plans-note">Fathom’s comparison.</span>
        </p>
      ) : null}
      {step.seen !== '' ? (
        <details className="plans-seen__kept">
          <summary>What the device said, as kept</summary>
          <pre className="plans-mono plans-seen__pre">{step.seen}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** On the current step: the box, then what was kept. */
export function SeenBox({ controller, plan, step, devices }: { controller: PlansController; plan: Plan; step: PlanStep; devices: readonly ReachableDevice[] }) {
  const fullHash = useImageHash(plan, step);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  if (!isCheckStep(plan, step)) return null;
  const expect = expectationOf(step, fullHash);
  const doc = controller.doc;
  const commands = step.after
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const withPlatform = devices.map((d) => ({ ...d, platform: (doc && deviceFirmware(doc, d.id)?.platform) || '' }));
  const keep = () => {
    if (text.trim() === '') return;
    setBusy(true);
    void controller.saveSeen(step.id, text, (raw) => compareSeen(expect, raw)).then((ok) => {
      setBusy(false);
      if (ok) setText('');
    });
  };
  return (
    <div className="plans-seen-box" data-testid="plans-seen-box">
      <label className="plans-label" htmlFor={id}>
        What the device answered
      </label>
      <textarea
        id={id}
        className="plans-input plans-input--area plans-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste the output of the step’s command"
        disabled={!controller.canEdit}
        spellCheck={false}
      />
      <p className="plans-note">
        The redaction gate runs on it in your browser before it is kept. Fathom compares what it can and says Matches, Differs or Can’t tell; you still mark the
        step.
      </p>
      {controller.canEdit && <FetchFromTermix commands={commands} devices={withPlatform} onFetched={setText} />}
      <p className="plans-step__actions">
        <button type="button" className="plans-btn" disabled={busy || text.trim() === '' || !controller.canEdit} onClick={keep}>
          {step.seen === '' ? 'Keep and compare' : 'Replace and compare'}
        </button>
      </p>
      <SeenKept step={step} />
    </div>
  );
}
