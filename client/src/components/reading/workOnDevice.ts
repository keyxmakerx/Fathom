// Other work on the device a reading is about (sign-off r106). Pure: the open design and a device,
// in; the plans and It's down issues that name it, and the fields a plan sets on it, out.
//
// A read is never stopped by them: reading changes nothing on the device. They are said, so a
// person reading in the middle of a plan knows what they see may be half way through it, and so
// Accept does not quietly undo what a plan is about to set.

import { edgesOut, findNode, type Document } from '../../document/model';
import { couldTouch, isOver, listPlans, type Plan } from '../../document/plans';
import { listIssues, type Issue } from '../../document/issues';
import { upgradeGroups } from '../firmware/upgradePlan';

/** A field a plan sets on the device: the plan, and the value it sets. */
export interface PlannedValue {
  planId: string;
  title: string;
  value: string;
  /** The plan is under way (stage `doing`), not only planned. */
  running: boolean;
}

export interface WorkOnDevice {
  /** Plans under way that could touch the device, its chassis or its ports. */
  running: Plan[];
  /** Plans not started yet that could touch it. */
  planned: Plan[];
  /** Open It's down issues on the device, or with a step that names it. */
  issues: Issue[];
  /** By a difference's field (`hostname`, `serial`, `os_version`): the plan that sets it. A plan under way wins. */
  sets: Partial<Record<'hostname' | 'serial' | 'os_version', PlannedValue>>;
}

export const NO_WORK: WorkOnDevice = { running: [], planned: [], issues: [], sets: {} };

const live = (doc: Document, id: string): boolean => findNode(doc, id)?.absentSince === undefined;

/** The device, its chassis and the chassis's ports, cards and supplies: what a plan names when it works on this device. */
function idsOf(doc: Document, deviceId: string): Set<string> {
  const ids = new Set([deviceId]);
  for (const c of edgesOut(doc, deviceId, 'HasChassis')) {
    if (!live(doc, c.to)) continue;
    ids.add(c.to);
    for (const kind of ['HasPort', 'HasCard', 'FittedIn'] as const) {
      for (const e of edgesOut(doc, c.to, kind)) if (live(doc, e.to)) ids.add(e.to);
    }
    // A card's own ports.
    for (const card of edgesOut(doc, c.to, 'HasCard')) {
      for (const e of edgesOut(doc, card.to, 'HasPort')) if (live(doc, e.to)) ids.add(e.to);
    }
  }
  return ids;
}

const FIELD_OF: Record<string, 'hostname' | 'serial'> = { 'Device.hostname': 'hostname', 'Chassis.serial': 'serial' };

export function workOnDevice(doc: Document, deviceId: string): WorkOnDevice {
  if (!live(doc, deviceId)) return NO_WORK;
  const ids = idsOf(doc, deviceId);
  const out: WorkOnDevice = { running: [], planned: [], issues: [], sets: {} };
  const set = (field: 'hostname' | 'serial' | 'os_version', plan: Plan, value: string) => {
    const running = plan.stage === 'doing';
    const had = out.sets[field];
    if (had && (had.running || !running)) return;
    out.sets[field] = { planId: plan.id, title: plan.title, value, running };
  };
  for (const plan of listPlans(doc)) {
    if (isOver(plan) || !couldTouch(plan).some((t) => ids.has(t))) continue;
    (plan.stage === 'doing' ? out.running : out.planned).push(plan);
    const steps = plan.steps.flatMap((s) => [s, ...(plan.ifPaths[s.id] ?? [])]);
    for (const s of steps) {
      const e = s.edit;
      if (e?.t === 'field' && ids.has(e.id) && FIELD_OF[e.key]) set(FIELD_OF[e.key]!, plan, e.value);
    }
    for (const g of upgradeGroups(plan)) if (g.deviceIds.includes(deviceId)) set('os_version', plan, g.version);
  }
  out.issues = listIssues(doc).filter(
    (i) => i.stage === 'open' && (ids.has(i.deviceId) || i.steps.some((s) => s.targets.some((t) => ids.has(t)))),
  );
  return out;
}

/** "The plan “Core swap”, under way now, sets this to sw-core-2." */
export function plannedWords(p: PlannedValue): string {
  return `The plan “${p.title || 'Untitled'}”${p.running ? ', under way now,' : ''} sets this to ${p.value}.`;
}
