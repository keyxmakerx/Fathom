// Changing an order type by dragging its board (ADR-0084 decision 5, r142): each move rewrites the
// file's own text, so the file stays the one source and the board is redrawn from its check. Only
// the lines that move change: comments, spacing and the way each job is written are kept. A move
// the text can't make without rewriting something else (a stage written on one line, the last job
// of a stage) is refused with words saying why, and the file is left as it was.

import type { Definition } from '../../api/orders';

export type Edit = { ok: true; source: string } | { ok: false; why: string };

/** Where a dragged card or column lands: before or after a sibling, by that sibling's line. */
export interface Place {
  line: number;
  side: 'before' | 'after';
}

const indentOf = (l: string): number => l.length - l.trimStart().length;
const blank = (l: string): boolean => l.trim() === '';

/** The 0-based range [start, end) of the list item that starts on `line` (1-based): its `- ` line and every
 * line deeper than its dash, interior blank lines included, trailing ones left out. */
function block(lines: readonly string[], line: number): { start: number; end: number; dash: number } | null {
  const start = line - 1;
  const first = lines[start];
  if (first == null || !first.trimStart().startsWith('-')) return null;
  const dash = indentOf(first);
  let end = start + 1;
  let i = start + 1;
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (indentOf(l) <= dash) break;
    i += 1;
    end = i;
  }
  return { start, end, dash };
}

function shift(lines: readonly string[], by: number): string[] {
  if (by === 0) return [...lines];
  return lines.map((l) => {
    if (blank(l)) return l;
    if (by > 0) return ' '.repeat(by) + l;
    const cut = Math.min(-by, indentOf(l));
    return l.slice(cut);
  });
}

/** How many lanes (written as lanes), stages and jobs start on `line`. */
function onLine(def: Definition, line: number): { lanes: number; stages: number; jobs: number } {
  const n = { lanes: 0, stages: 0, jobs: 0 };
  for (const lane of def.lanes) {
    if (!lane.implicit && lane.line === line) n.lanes += 1;
    for (const s of lane.stages) {
      if (s.line === line) n.stages += 1;
      for (const j of s.jobs) if (j.line === line) n.jobs += 1;
    }
  }
  return n;
}

const startsItem = (source: string, line: number): boolean => source.split('\n')[line - 1]?.trimStart().startsWith('-') ?? false;

/** A job written on lines of its own, as a list item: it can move alone. */
function jobAlone(source: string, def: Definition, line: number): boolean {
  const n = onLine(def, line);
  return startsItem(source, line) && n.jobs === 1 && n.stages === 0 && n.lanes === 0;
}

/** A stage written as a list item of its own: it moves with its jobs, even when they share its line. */
function stageAlone(source: string, def: Definition, line: number): boolean {
  const n = onLine(def, line);
  return startsItem(source, line) && n.stages === 1 && n.lanes === 0;
}

/** Moves the item on `from` to `to`, at `to`'s depth. Both must be list items written over their own lines. */
function move(source: string, from: number, to: Place): Edit {
  const lines = source.split('\n');
  const src = block(lines, from);
  const dst = block(lines, to.line);
  if (src == null || dst == null) return { ok: false, why: 'The file has changed since the board was drawn. Try again in a moment.' };
  if (to.line >= from && to.line < from + (src.end - src.start)) return { ok: true, source };
  const moved = shift(lines.slice(src.start, src.end), dst.dash - src.dash);
  const at = to.side === 'before' ? dst.start : dst.end;
  const rest = [...lines.slice(0, src.start), ...lines.slice(src.end)];
  const where = at > src.start ? at - (src.end - src.start) : at;
  rest.splice(where, 0, ...moved);
  return { ok: true, source: rest.join('\n') };
}

function stageOfJob(def: Definition, jobLine: number) {
  for (const lane of def.lanes) for (const s of lane.stages) if (s.jobs.some((j) => j.line === jobLine)) return { lane, stage: s };
  return null;
}

function laneOfStage(def: Definition, stageLine: number) {
  return def.lanes.find((l) => l.stages.some((s) => s.line === stageLine)) ?? null;
}

const ONE_LINE = 'is written on one line in the file, so it can only be changed there';

/** A job card dropped beside another job, in the same stage or another. */
export function moveJob(source: string, def: Definition, jobLine: number, to: Place): Edit {
  const from = stageOfJob(def, jobLine);
  const into = stageOfJob(def, to.line);
  if (from == null || into == null) return { ok: false, why: 'The file has changed since the board was drawn. Try again in a moment.' };
  if (!jobAlone(source, def, jobLine)) return { ok: false, why: `That job ${ONE_LINE}.` };
  if (!jobAlone(source, def, to.line)) return { ok: false, why: `Stage ${into.stage.name} ${ONE_LINE}.` };
  if (from.stage.line !== into.stage.line && from.stage.jobs.length === 1) {
    return { ok: false, why: `It is the only job in ${from.stage.name}, and a stage needs at least one. Add another job there first.` };
  }
  return move(source, jobLine, to);
}

/** A stage column dropped beside another stage, in the same lane or another. */
export function moveStage(source: string, def: Definition, stageLine: number, to: Place): Edit {
  const from = laneOfStage(def, stageLine);
  const into = laneOfStage(def, to.line);
  if (from == null || into == null) return { ok: false, why: 'The file has changed since the board was drawn. Try again in a moment.' };
  if (!stageAlone(source, def, stageLine)) return { ok: false, why: `That stage ${ONE_LINE}.` };
  if (!stageAlone(source, def, to.line)) return { ok: false, why: `Lane ${into.name} ${ONE_LINE}.` };
  if (from.line !== into.line && from.stages.length === 1) {
    return { ok: false, why: `It is the only stage in lane ${from.name}, and a lane needs at least one.` };
  }
  return move(source, stageLine, to);
}

function freeId(def: Definition, stem: string): string {
  const taken = new Set<string>();
  for (const lane of def.lanes) {
    taken.add(lane.id);
    for (const s of lane.stages) {
      taken.add(s.id);
      for (const j of s.jobs) taken.add(j.id);
    }
  }
  for (let n = 1; ; n += 1) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** A new job at the end of a stage, for the same team as the stage's last job; named in the file to be renamed. */
export function addJob(source: string, def: Definition, stageLine: number): Edit {
  const stage = def.lanes.flatMap((l) => l.stages).find((s) => s.line === stageLine);
  const last = stage?.jobs[stage.jobs.length - 1];
  if (stage == null || last == null) return { ok: false, why: 'The file has changed since the board was drawn. Try again in a moment.' };
  if (!jobAlone(source, def, last.line)) return { ok: false, why: `Stage ${stage.name} ${ONE_LINE}.` };
  const lines = source.split('\n');
  const b = block(lines, last.line);
  if (b == null) return { ok: false, why: 'The file has changed since the board was drawn. Try again in a moment.' };
  const id = freeId(def, 'job');
  lines.splice(b.end, 0, `${' '.repeat(b.dash)}- { id: ${id}, name: New job, team: ${last.team} }`);
  return { ok: true, source: lines.join('\n') };
}

/** A new stage at the end of a lane, with one job for the same team as the lane's last job. */
export function addStage(source: string, def: Definition, laneLine: number): Edit {
  const lane = def.lanes.find((l) => l.line === laneLine);
  const last = lane?.stages[lane.stages.length - 1];
  const team = last?.jobs[last.jobs.length - 1]?.team;
  if (lane == null || last == null || team == null) return { ok: false, why: 'The file has changed since the board was drawn. Try again in a moment.' };
  if (!stageAlone(source, def, last.line)) return { ok: false, why: `Lane ${lane.name} ${ONE_LINE}.` };
  const lines = source.split('\n');
  const b = block(lines, last.line);
  if (b == null) return { ok: false, why: 'The file has changed since the board was drawn. Try again in a moment.' };
  const pad = ' '.repeat(b.dash);
  const id = freeId(def, 'stage');
  const job = freeId(def, 'job');
  const add = ['', `${pad}- id: ${id}`, `${pad}  name: New stage`, `${pad}  jobs:`, `${pad}    - { id: ${job}, name: New job, team: ${team} }`];
  lines.splice(b.end, 0, ...add);
  return { ok: true, source: lines.join('\n') };
}
