// Work that clashes inside one design (sign-off r105, part 1): another open plan or an open It's down issue on a
// device this plan could touch, at a time that overlaps. Pure: no React, no server. Across designs and people is
// part 2 and lives on the server's work index.
import type { Canon } from '../checks/checksModel';
import { edgesOut, findNode, parseNodeId, type Document } from '../../document/model';
import { listIssues } from '../../document/issues';
import { couldTouch, isOver, listPlans, touchedBy, type Plan, type PlanStep } from '../../document/plans';
import { nameOf } from './plansModel';

/** A time span in milliseconds; an open end is infinite. */
export interface Span {
  from: number;
  to: number;
}

const ALWAYS: Span = { from: -Infinity, to: Infinity };

/** A window as typed (an ISO date, or date and time). A bare date's end runs to the end of that day. Anything that
 * does not read as a date leaves that end open, so an unread window clashes rather than hides (r105 "when" A). */
export function windowSpan(start: string, end: string): Span {
  const read = (t: string, endOfDay: boolean): number | null => {
    const s = t.trim();
    if (s === '') return null;
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) return null;
    return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s) ? ms + 86_400_000 - 1 : ms;
  };
  const from = read(start, false);
  const to = read(end, true);
  // A start with no end is that one moment's day, when the start is a bare date; otherwise it runs open.
  const startDayEnd = from !== null && to === null ? read(start, true) : null;
  return {
    from: from ?? -Infinity,
    to: to ?? (startDayEnd !== null && startDayEnd !== from ? startDayEnd : Infinity),
  };
}

export function overlaps(a: Span, b: Span): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** When a plan is busy: its window, or always when it has none. */
export function planSpan(plan: Pick<Plan, 'windowStart' | 'windowEnd'>): Span {
  return plan.windowStart.trim() === '' && plan.windowEnd.trim() === '' ? ALWAYS : windowSpan(plan.windowStart, plan.windowEnd);
}

const kindOf = (id: string): string => {
  try {
    return parseNodeId(id).kind;
  } catch {
    return '';
  }
};

const live = (doc: Document, id: string): boolean => {
  const n = findNode(doc, id);
  return n !== undefined && n.absentSince === undefined;
};

/** The ports a plan could touch: a port named outright, and both ends of a cable it makes or cuts. */
function portsOf(doc: Document, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const kind = kindOf(id);
    if (kind === 'PhysicalPort') out.add(id);
    else if (kind === 'Cable') edgesOut(doc, id, 'Terminates').forEach((e) => out.add(e.to));
  }
  return out;
}

/** The devices a list of ids resolves to: ports and chassis to their device, a cable to the devices it joins. */
function devicesOf(doc: Document, canon: Canon, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  const add = (id: string): void => {
    const dev = canon(id);
    if (kindOf(dev) === 'Device' && live(doc, dev)) out.add(dev);
  };
  for (const id of ids) {
    if (kindOf(id) === 'Cable') edgesOut(doc, id, 'Terminates').forEach((e) => add(e.to));
    else add(id);
  }
  return out;
}

export interface Clash {
  kind: 'plan' | 'issue';
  /** The other plan or issue. */
  id: string;
  title: string;
  /** 'planned' or 'doing' for a plan; 'open' for an issue. */
  stage: string;
  /** The devices both touch, by name, in name order. */
  devices: string[];
  /** The ports both touch, by name ("core-sw1 · Gi1/0/48"): the tighter clash, shown in bold (r105 "what" A). */
  ports: string[];
  /** The other plan's window as typed; '' for an issue or a plan with none. */
  windowStart: string;
  windowEnd: string;
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** Other open work on the devices `plan` could touch, at a time that overlaps its window. Called-off and recorded
 * plans and closed issues are never a clash. Empty for a plan that is itself over. */
export function planClashes(doc: Document, canon: Canon, plan: Plan): Clash[] {
  if (isOver(plan)) return [];
  const mine = couldTouch(plan);
  const myDevices = devicesOf(doc, canon, mine);
  if (myDevices.size === 0) return [];
  const myPorts = portsOf(doc, mine);
  const mySpan = planSpan(plan);
  const names = (ids: Iterable<string>): string[] => [...ids].map((id) => nameOf(doc, canon, id)).sort(byName);
  const out: Clash[] = [];

  for (const other of listPlans(doc)) {
    if (other.id === plan.id || isOver(other)) continue;
    if (!overlaps(mySpan, planSpan(other))) continue;
    const theirs = couldTouch(other);
    const shared = [...devicesOf(doc, canon, theirs)].filter((d) => myDevices.has(d));
    if (shared.length === 0) continue;
    const ports = [...portsOf(doc, theirs)].filter((p) => myPorts.has(p));
    out.push({
      kind: 'plan',
      id: other.id,
      title: other.title,
      stage: other.stage,
      devices: names(shared),
      ports: names(ports),
      windowStart: other.windowStart,
      windowEnd: other.windowEnd,
    });
  }
  // An open issue has no window: it is open now, so it clashes with any window (r105 "when" A).
  for (const issue of listIssues(doc)) {
    if (issue.stage !== 'open') continue;
    const theirs = [issue.deviceId, ...issue.steps.flatMap((s) => s.targets)];
    const shared = [...devicesOf(doc, canon, theirs)].filter((d) => myDevices.has(d));
    if (shared.length === 0) continue;
    const ports = [...portsOf(doc, theirs)].filter((p) => myPorts.has(p));
    out.push({ kind: 'issue', id: issue.id, title: issue.title, stage: issue.stage, devices: names(shared), ports: names(ports), windowStart: '', windowEnd: '' });
  }
  // A plan already under way first, then issues, then plans still being planned.
  const rank = (c: Clash): number => (c.kind === 'plan' && c.stage === 'doing' ? 0 : c.kind === 'issue' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || byName(a.title, b.title));
}

/** One line per clash, for the note Start anyway leaves on the plan: "Started while … was open on …". */
export function clashNote(clashes: readonly Clash[]): string {
  const one = (c: Clash): string => {
    const what = c.kind === 'issue' ? `It's down "${c.title}"` : `plan "${c.title}" (${c.stage === 'doing' ? 'under way' : 'planned'})`;
    const where = c.ports.length > 0 ? `the same port ${c.ports.join(', ')}` : c.devices.join(', ');
    return `${what} on ${where}`;
  };
  return `Started anyway while other work was open on these devices: ${clashes.map(one).join('; ')}.`;
}

/** A plan under way on `deviceId`, for It's down (r105 "trouble" A): the plan, and its finished steps that touched
 * the device, newest first. Only plans in Do; a plan still being planned has changed nothing. */
export interface RunningHere {
  plan: Plan;
  steps: PlanStep[];
}

export function runningOn(doc: Document, canon: Canon, deviceId: string): RunningHere[] {
  const dev = canon(deviceId);
  const out: RunningHere[] = [];
  for (const plan of listPlans(doc)) {
    if (plan.stage !== 'doing') continue;
    if (!devicesOf(doc, canon, touchedBy(plan)).has(dev)) continue;
    const steps = plan.steps
      .filter((s) => s.state !== 'planned' && devicesOf(doc, canon, s.targets).has(dev))
      .sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
    out.push({ plan, steps });
  }
  return out;
}
