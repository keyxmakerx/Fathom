// Work that lands on the same devices (sign-off r105). The engine decides what clashes and what time is free
// (`fathom_inventory::work`, asked through `OP_WORK_CLASHES`); this file only words it for the page and turns the
// engine's ids back into the plans the page already reads. Nothing here decides a clash.
import type { HeldThing, PlanClashes, RunningHere as EngineRunning, WindowText, WorkClash } from '../../engine/engine';
import type { OrderHold } from '../../api/orders';
import type { Document } from '../../document/model';
import { readPlan, type Plan, type PlanStep } from '../../document/plans';

export type { HeldThing, PlanClashes, WindowText, WorkClash };

export const NO_CLASHES: PlanClashes = { mineFree: null, clashes: [] };

/** What open orders hold on this design, as the engine is asked it (ADR-0084 decision 18). */
export function heldOn(holds: readonly OrderHold[], designId: string): { holds: OrderHold[]; things: HeldThing[] } {
  const here = holds.filter((h) => h.design === designId);
  return { holds: here, things: here.map((h) => ({ device: h.device, port: h.port })) };
}

/** The engine's order rows as the orders they are: it names a hold by its index in what it was asked, and the page
 * already has the order's number, type and job. Several holds of one job on the same devices read as one line. */
export function withOrders(reply: PlanClashes, holds: readonly OrderHold[]): PlanClashes {
  const seen = new Map<string, WorkClash>();
  const out: WorkClash[] = [];
  for (const c of reply.clashes) {
    if (c.kind !== 'order') {
      out.push(c);
      continue;
    }
    const h = holds[Number(c.id)];
    if (h == null) continue;
    const id = `${h.order}/${h.job}`;
    const had = seen.get(id);
    if (had) {
      const add = <T extends { id: string }>(a: T[], b: T[]) => [...a, ...b.filter((x) => !a.some((y) => y.id === x.id))];
      had.devices = add(had.devices, c.devices);
      had.ports = add(had.ports, c.ports);
      continue;
    }
    const clash: WorkClash = {
      ...c,
      id,
      title: `${h.code ? `W-${h.number} · ${h.code}` : `W-${h.number}`} ${h.name}: ${h.jobName}`,
      team: h.team,
      order: { id: h.order, number: h.number, code: h.code, name: h.name, job: h.job, jobName: h.jobName },
    };
    seen.set(id, clash);
    out.push(clash);
  }
  return { ...reply, clashes: out };
}

/** A plan under way on a device, for It's down: the plan, and its finished steps there, newest first. */
export interface RunningHere {
  plan: Plan;
  steps: PlanStep[];
}

/** The engine's answer as the page's own plans. A plan the document no longer holds is left out. */
export function runningFrom(doc: Document, rows: readonly EngineRunning[]): RunningHere[] {
  const out: RunningHere[] = [];
  for (const r of rows) {
    let plan: Plan;
    try {
      plan = readPlan(doc, r.plan);
    } catch {
      continue;
    }
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    out.push({ plan, steps: r.steps.flatMap((id) => byId.get(id) ?? []) });
  }
  return out;
}

/** "Sat 8 Nov 02:00–04:00", or the dates alone for whole days; the window as typed when it does not read. */
export function windowWords(w: WindowText): string {
  const read = (t: string): { date: Date; bare: boolean } | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(t.trim());
    if (!m) return null;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
    return Number.isNaN(date.getTime()) ? null : { date, bare: m[4] === undefined };
  };
  const day = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const a = read(w.start);
  const b = read(w.end);
  if (a == null) return [w.start, w.end].filter((t) => t !== '').join(' to ');
  if (a.bare) return b == null || !b.bare || b.date.getTime() === a.date.getTime() ? day(a.date) : `${day(a.date)} to ${day(b.date)}`;
  if (b == null) return `${day(a.date)} ${time(a.date)}`;
  const sameDay = a.date.toDateString() === b.date.toDateString();
  return `${day(a.date)} ${time(a.date)}–${sameDay ? '' : `${day(b.date)} `}${time(b.date)}`;
}

const where = (c: WorkClash): string =>
  c.ports.length > 0 ? `the same port ${c.ports.map((p) => p.name).join(', ')}` : c.devices.map((d) => d.name).join(', ');

/** The note Start anyway leaves on the plan: one line naming each clash. */
export function clashNote(clashes: readonly WorkClash[]): string {
  const one = (c: WorkClash): string => {
    const what =
      c.kind === 'issue' ? `It's down "${c.title}"` : c.kind === 'order' ? `order ${c.title}` : `plan "${c.title}" (${c.stage === 'doing' ? 'under way' : 'planned'})`;
    return `${what} on ${where(c)}`;
  };
  return `Started anyway while other work was open on these devices: ${clashes.map(one).join('; ')}.`;
}

/** The note offered to whoever has the other work (sign-off r105, from the owner's note): what clashes, and a time
 * for their plan after this one when the engine found one. It changes nothing of theirs; they decide. */
export function offerNote(mine: { title: string; window: WindowText }, c: WorkClash): string {
  const when = mine.window.start === '' && mine.window.end === '' ? 'with no window set' : windowWords(mine.window);
  const head = `Plan "${mine.title}" (${when}) also works on ${where(c)}.`;
  if (c.kind === 'issue') return `${head} It will check this issue's notes before it starts.`;
  return c.theirsAfterMine == null
    ? `${head} Could the two be done at different times?`
    : `${head} This plan could run after it, at ${windowWords(c.theirsAfterMine)}, if that suits.`;
}
