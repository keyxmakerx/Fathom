// Orders on screen (ADR-0084 pieces 4 and 5): the pure part. What a field asks, whether an answer
// fits, where an order stands, and what the person looking may do. The engine on the server
// decides every act; these only spare a person a refusal by not offering what it would refuse.

import type { AnswerValue, Condition, Definition, JobDef, JobState, JobStatus, LaneState, Order, OrderField, OverdueRule, StageState, StageStatus, TeamNames } from '../../api/orders';

// ---------------------------------------------------------------------------
// Conditions and fields
// ---------------------------------------------------------------------------

const isEmpty = (v: AnswerValue | undefined | null): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Pure: whether `c` holds for these answers, as the engine reads it (decision 2). */
export function conditionHolds(c: Condition | null, answers: Record<string, AnswerValue>): boolean {
  if (c === null) return true;
  if ('all' in c) return c.all.every((x) => conditionHolds(x, answers));
  if ('any' in c) return c.any.some((x) => conditionHolds(x, answers));
  const v = answers[c.field];
  switch (c.op) {
    case 'set':
      return !isEmpty(v);
    case 'not_set':
      return isEmpty(v);
    case 'is':
      return !isEmpty(v) && v === c.value;
    case 'is_not':
      return isEmpty(v) || v !== c.value;
    case 'in':
      return !isEmpty(v) && (Array.isArray(v) ? v.some((x) => c.value.includes(x)) : c.value.includes(v as string | number | boolean));
    case 'at_least':
      return typeof v === 'number' && v >= c.value;
    case 'at_most':
      return typeof v === 'number' && v <= c.value;
  }
}

/** Pure: the fields asked when the order opens (no job asks for them), in order, each only while
 * its `when` holds for the answers so far. */
export function fieldsAtOpen(def: Definition, answers: Record<string, AnswerValue>): OrderField[] {
  const asked = new Set(def.lanes.flatMap((l) => l.stages.flatMap((s) => s.jobs.flatMap((j) => j.asks))));
  return def.fields.filter((f) => !asked.has(f.key) && conditionHolds(f.when, answers));
}

/** Pure: an answer from what was typed or picked, or null for nothing. A number that isn't a
 * whole number is a problem the form says, not something sent. */
export function answerFrom(field: OrderField, raw: string): AnswerValue | null | { problem: string } {
  const t = raw.trim();
  if (t === '') return null;
  if (field.kind === 'number') {
    if (!/^-?\d+$/.test(t)) return { problem: `${field.label} is a whole number.` };
    const n = Number(t);
    if (field.min !== null && n < field.min) return { problem: `${field.label} is at least ${field.min}.` };
    if (field.max !== null && n > field.max) return { problem: `${field.label} is at most ${field.max}.` };
    return n;
  }
  if (field.kind === 'yes_no') return t === 'yes';
  return t;
}

/** Pure: the first required field asked at open that has no answer, or null. */
export function missingAtOpen(def: Definition, answers: Record<string, AnswerValue>): OrderField | null {
  return fieldsAtOpen(def, answers).find((f) => f.required && isEmpty(answers[f.key])) ?? null;
}

/** Pure: the answers to send, keeping only fields still asked. */
export function answersToSend(def: Definition, answers: Record<string, AnswerValue>): Record<string, AnswerValue> {
  const out: Record<string, AnswerValue> = {};
  for (const f of fieldsAtOpen(def, answers)) if (!isEmpty(answers[f.key])) out[f.key] = answers[f.key];
  return out;
}

export const KIND_WORDS: Record<OrderField['kind'], string> = {
  text: 'Text',
  long_text: 'Longer text',
  number: 'Number',
  yes_no: 'Yes or no',
  date: 'Date',
  choice: 'One of a list',
  choices: 'Any of a list',
  site: 'Site',
  device: 'Device',
  port: 'Port',
  team: 'Team',
  person: 'Person',
  prefix: 'Address block',
};

/** Pure: an answer in words. A device or port says its ids only when nothing better is known. */
export function answerWords(field: OrderField | undefined, v: AnswerValue | undefined, names?: Record<string, string>): string {
  if (isEmpty(v)) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object' && v !== null) {
    const key = `${v.design}/${v.port ?? v.device}`;
    return names?.[key] ?? (field?.kind === 'port' ? 'A port in another design' : 'A device in another design');
  }
  if (field?.kind === 'date' && typeof v === 'string') return dateWords(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Pure: a length of time in words, as a person says it: "1 day", "4 hours", "1 week". */
export function durationWords(minutes: number): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (minutes % (7 * 24 * 60) === 0 && minutes > 0) return plural(minutes / (7 * 24 * 60), 'week');
  if (minutes % (24 * 60) === 0 && minutes > 0) return plural(minutes / (24 * 60), 'day');
  if (minutes % 60 === 0 && minutes > 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Pure: `YYYY-MM-DD` as "8 Nov 2026". */
export function dateWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Pure: unix seconds as "8 Nov, 14:05" in this browser's time. */
export function whenWords(unix: number, now = Date.now() / 1000): string {
  const d = new Date(unix * 1000);
  const sameYear = new Date(now * 1000).getFullYear() === d.getFullYear();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}, ${hm}`;
}

/** Pure: when a ready job is due, in unix seconds, or null when it has no `due` or isn't ready. */
export function dueAt(def: JobDef | undefined, st: JobState): number | null {
  if (st.dueAt !== null && st.dueAt !== undefined) return st.status === 'ready' ? st.dueAt : null;
  if (!def || def.dueMinutes === null || st.readyAt === null || st.status !== 'ready') return null;
  return st.readyAt + def.dueMinutes * 60;
}

/** Pure: a ready job past its due time. Overdue is a mark (decision 4); the rules a type gives
 * it are listed beside it, and only a person moves the job until the clock is built. */
export function isOverdue(def: JobDef | undefined, st: JobState, now: number): boolean {
  const due = dueAt(def, st);
  return due !== null && now > due;
}

// ---------------------------------------------------------------------------
// Where an order stands
// ---------------------------------------------------------------------------

export const JOB_WORDS: Record<JobStatus, string> = {
  not_started: 'Not started',
  left_out: 'Not needed',
  waiting: 'Waiting',
  ready: 'Ready',
  done: 'Done',
  cancelled: 'Cancelled',
  skipped: 'Moved on, overdue',
};

export const STAGE_WORDS: Record<StageStatus, string> = {
  not_started: 'Not started',
  running: 'Under way',
  awaiting_sign_off: 'Waiting for a sign-off',
  done: 'Done',
};

export function jobDef(def: Definition, id: string): JobDef | undefined {
  for (const l of def.lanes) for (const s of l.stages) for (const j of s.jobs) if (j.id === id) return j;
  return undefined;
}

export function stageOf(order: Order, stageId: string): { lane: LaneState; stage: StageState } | null {
  for (const lane of order.lanes) for (const stage of lane.stages) if (stage.id === stageId) return { lane, stage };
  return null;
}

/** Pure: a job's name anywhere in the order, for "waits for". */
export function jobName(order: Order, id: string): string {
  for (const l of order.lanes) for (const s of l.stages) for (const j of s.jobs) if (j.id === id) return j.name;
  return id;
}

export function teamWords(teams: TeamNames, id: string): string {
  return teams[id]?.name ?? 'A team that no longer stands';
}

export function personWords(people: Record<string, string>, id: string | null): string {
  if (!id) return '';
  if (id === 'engine') return 'Fathom';
  return people[id] ?? 'someone no longer here';
}

/** Pure: one line saying where the order is, per lane: the first stage not done, or "Done". */
export function whereItIs(order: Order): string {
  if (order.status === 'done') return 'Done';
  if (order.status === 'cancelled') return 'Cancelled';
  const parts = order.lanes.map((lane) => {
    const now = lane.stages.find((s) => s.status !== 'done');
    const prefix = order.lanes.length > 1 ? `${lane.name}: ` : '';
    if (!now) return `${prefix}done`;
    if (now.status === 'awaiting_sign_off') return `${prefix}${now.name}, waiting for a sign-off`;
    return `${prefix}${now.name}`;
  });
  return parts.join(' · ');
}

/** Pure: the order's number as people say it: "W-1042 · DIA". */
export function orderNumber(number: number, code: string | null): string {
  return code ? `W-${number} · ${code}` : `W-${number}`;
}

// ---------------------------------------------------------------------------
// What the person looking may do (the engine's own rules, said ahead)
// ---------------------------------------------------------------------------

const LEAD = 'lead';

export function onTeam(order: Order, team: string): boolean {
  return order.you.teams[team]?.on === true;
}

export function leadOf(order: Order, team: string): boolean {
  return order.you.teams[team]?.roles.includes(LEAD) === true;
}

/** Pure: may pick the job up: it is ready, on your team, and not already yours. */
export function mayPickUp(order: Order, job: JobState): boolean {
  return order.status === 'open' && job.status === 'ready' && onTeam(order, job.team) && job.pickedBy !== order.you.account;
}

/** Pure: may tick, finish and send back: ready and on your team (the engine's `must_work_on`). */
export function mayWork(order: Order, job: JobState): boolean {
  return order.status === 'open' && job.status === 'ready' && onTeam(order, job.team);
}

/** Pure: may cancel the job: open, and a lead of its team or a Steward, or on its team when it is optional. */
export function mayCancelJob(order: Order, job: JobState, def: JobDef | undefined): boolean {
  if (order.status !== 'open' || (job.status !== 'ready' && job.status !== 'waiting')) return false;
  return leadOf(order, job.team) || order.you.steward || (def?.optional === true && onTeam(order, job.team));
}

/** Pure: whether the person looking may sign the stage off, or why not. */
export function signOff(order: Order, stage: StageState): { may: true } | { may: false; why: string } {
  if (stage.status !== 'awaiting_sign_off' || !stage.approval) return { may: false, why: '' };
  const me = order.you.account;
  if (order.openedBy === me) return { may: false, why: 'You opened this order, so someone else signs its stages off.' };
  if (stage.jobs.some((j) => j.pickedBy === me || j.finishedBy === me)) return { may: false, why: 'You worked on this stage, so someone else signs it off.' };
  const holds = order.you.steward || stage.jobs.some((j) => order.you.teams[j.team]?.powers.includes(stage.approval ?? ''));
  if (!holds) return { may: false, why: 'Someone who signs off plans for one of this stage’s teams, or a Steward, signs it off.' };
  return { may: true };
}

/** Pure: may cancel the whole order: a lead of one of its teams, or a Steward. */
export function mayCancelOrder(order: Order): boolean {
  if (order.status !== 'open') return false;
  return order.you.steward || Object.values(order.you.teams).some((t) => t.roles.includes(LEAD));
}

/** Pure: the jobs that are yours to act on now, for the order list's "for you" line. */
/** Pure: an overdue job an `escalate` rule put in front of a role you hold on its team. */
export function escalatedToYou(order: Order, job: JobState): boolean {
  return order.status === 'open' && job.status === 'ready' && job.escalated !== null && order.you.teams[job.team]?.roles.includes(job.escalated) === true;
}

export function readyForYou(order: Order): JobState[] {
  return order.lanes.flatMap((l) => l.stages.flatMap((s) => s.jobs)).filter((j) => mayWork(order, j) || escalatedToYou(order, j));
}

/** Pure: one overdue rule in words, as the order type says it. */
export function overdueRuleWords(order: Order, rule: OverdueRule): string {
  const when = rule.afterMinutes === 0 ? 'as soon as it is overdue' : `${durationWords(rule.afterMinutes)} after it is due`;
  const what =
    rule.action === 'escalate'
      ? `show it to the team’s ${rule.to === 'overseer' ? 'supervisor' : 'lead'}`
      : rule.action === 'move_on'
        ? 'move on without it'
        : rule.to === 'team' || rule.to === null
          ? 'hand it back to the team'
          : `hand it to ${teamWords(order.teams, rule.to)}`;
  return `${when}, ${what}`;
}

/** Pure: the open fields a job asks for (decision 15: filled in by the job, not at open). */
export function asksOf(order: Order, job: JobState): OrderField[] {
  return job.asks
    .map((k) => order.definition.fields.find((f) => f.key === k))
    .filter((f): f is OrderField => f !== undefined && conditionHolds(f.when, order.answers));
}

/** Pure: why Finish would be refused, said before trying, or null. */
export function finishBlocker(order: Order, job: JobState): string | null {
  const def = jobDef(order.definition, job.id);
  if (def?.makesPlan) return job.plan ? 'Done by itself when its plan is recorded.' : 'Link the plan this job makes; the job is done when the plan is recorded.';
  if (job.ticks.length < job.steps.length) return `${job.steps.length - job.ticks.length} of ${job.steps.length} steps still to tick.`;
  const missing = asksOf(order, job).find((f) => f.required && isEmpty(order.answers[f.key]));
  if (missing) return `${missing.label} needs an answer first.`;
  return null;
}

/** Pure: how an action in the history reads. */
export function historyWords(order: Order, action: string, detail: Record<string, unknown>): string {
  const job = typeof detail.job === 'string' ? jobName(order, detail.job) : '';
  const field = typeof detail.field === 'string' ? (order.definition.fields.find((f) => f.key === detail.field)?.label ?? detail.field) : '';
  const reason = typeof detail.reason === 'string' && detail.reason !== '' ? `: “${detail.reason}”` : '';
  switch (action) {
    case 'open':
      return 'opened the order';
    case 'answer':
      return `answered ${field}${reason}`;
    case 'pick_up':
      return `picked up ${job}`;
    case 'tick':
      return `${detail.done === false ? 'unticked' : 'ticked'} a step of ${job}`;
    case 'link_plan':
      return `linked a plan to ${job}`;
    case 'finish':
      return `finished ${job}`;
    case 'send_back':
      return `sent the order back from ${job}${reason}`;
    case 'cancel':
      return `cancelled ${job}${reason}`;
    case 'approve': {
      const st = typeof detail.stage === 'string' ? stageOf(order, detail.stage)?.stage.name : '';
      return `signed off ${st ?? 'a stage'}`;
    }
    case 'cancel_order':
      return `cancelled the order${reason}`;
    case 'overdue': {
      const id = typeof detail.job === 'string' ? detail.job : '';
      const rule = typeof detail.rule === 'number' ? jobDef(order.definition, id)?.overdue[detail.rule] : undefined;
      if (!rule) return `moved ${job} on, as it was overdue`;
      const what =
        rule.action === 'escalate'
          ? `showed ${job} to the team’s ${rule.to === 'overseer' ? 'supervisor' : 'lead'}`
          : rule.action === 'move_on'
            ? `moved on without ${job}`
            : rule.to === 'team' || rule.to === null
              ? `handed ${job} back to the team`
              : `handed ${job} to ${teamWords(order.teams, rule.to)}`;
      return `${what}, as it was overdue`;
    }
    default:
      return action;
  }
}

// ---------------------------------------------------------------------------
// The Steward's side: team matching
// ---------------------------------------------------------------------------

/** Pure: each slug the file names matched to a team: the Steward's own pick, else the team with
 * that slug, else nothing (which blocks saving, decision 8). */
export function matchTeams(slugs: readonly string[], teams: TeamNames, picked: Record<string, string>): Record<string, string | null> {
  const bySlug = new Map(Object.entries(teams).map(([id, t]) => [t.slug, id]));
  const out: Record<string, string | null> = {};
  for (const slug of slugs) {
    const p = picked[slug];
    out[slug] = p && teams[p] ? p : (bySlug.get(slug) ?? null);
  }
  return out;
}

/** Pure: the shared field sets a file uses (`- { use: <id> }`), so the right ones go with it. */
export function setsUsed(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\buse:\s*([a-z0-9][a-z0-9-]*)/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Pure: the id a field set file declares. */
export function setIdOf(source: string): string | null {
  return /^id:\s*([a-z0-9][a-z0-9-]*)\s*$/m.exec(source)?.[1] ?? null;
}

/** Pure: a file's own name for downloading: its `id`, else "order-type". */
export function fileNameOf(source: string): string {
  const id = /^id:\s*([a-z0-9][a-z0-9-]*)\s*$/m.exec(source)?.[1];
  return `${id ?? 'order-type'}.yaml`;
}
