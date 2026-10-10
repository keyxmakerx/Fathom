import { describe, expect, it } from 'vitest';

import { deviceFirmware, setTarget, targetOfDevice } from '../../document/firmware';
import { NOW, estate } from '../../document/firmwareFixture';
import { TYPED_AS_WRITTEN, addStep, createPlan, listPlans, planSteps, touchedBy } from '../../document/plans';
import { firstLine, secondLine, stepHead } from '../plans/plansModel';
import { imageRows } from './images';
import { buildUpgradePlan } from './upgradePlan';

// What `usePlansController.planFirmware` writes: a plan, then one step per template step, all aimed at
// the template's devices. Done here with the same document functions.
describe('an upgrade plan in the design', () => {
  const { doc, ids } = estate();
  const chosen = setTarget(doc, 'ex4300-48t', { version: '23.4R2', platform: 'junos-ex' }, { now: NOW + 1 });
  const devices = [ids.sw1!, ids.sw2!].flatMap((id) => deviceFirmware(chosen, id) ?? []);
  const target = targetOfDevice(chosen, devices[0]!)!;
  const t = buildUpgradePlan({ devices, model: 'ex4300-48t', target, image: null });

  const made = createPlan(chosen, { title: t.title, gate: TYPED_AS_WRITTEN, now: NOW + 2 });
  let next = made.doc;
  for (const s of t.steps) next = addStep(next, made.id, { kind: s.kind, change: s.change, ...(s.after !== undefined ? { after: s.after } : {}), targets: t.deviceIds, gate: TYPED_AS_WRITTEN, now: NOW + 3 }).doc;

  it('is one plan, six steps in order, all on the devices', () => {
    expect(listPlans(next)).toHaveLength(1);
    const steps = planSteps(next, made.id);
    expect(steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(steps.every((s) => s.kind === 'other' && s.state === 'planned')).toBe(true);
    expect(touchedBy(listPlans(next)[0]!).sort()).toEqual([ids.sw1, ids.sw2].sort());
  });

  it('keeps each step title and its muted line apart', () => {
    const s = planSteps(next, made.id)[0]!;
    expect(firstLine(s.change)).toBe('Back up the running config');
    expect(secondLine(s.change)).toBe('Paste it into Fathom; the redaction gate runs first.');
    expect(stepHead(s).text).toBe('Back up the running config');
  });

  it('puts the plan on the list as an upgrade for that version, and the image list counts it', () => {
    expect(listPlans(next)[0]!.title).toBe('Upgrade ex4300-48t to 23.4R2');
    const row = imageRows({ doc: next, images: [] }).find((r) => r.version === '23.4R2')!;
    expect(row.plans).toBe(1);
  });
});
