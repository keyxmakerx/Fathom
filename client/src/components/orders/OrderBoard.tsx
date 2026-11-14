// The board (ADR-0084 decision 5, r103): an order type drawn as lanes of stages, each stage a
// column of job cards. Lanes run at the same time; stages in a lane run left to right. It is
// drawn from the checked file, so it can never show something the file doesn't say. With `edit`, jobs
// and stages are dragged (or moved with Alt and the arrow keys) and the file is rewritten to match
// (r142); the board then redraws from the file's check, as it does when the file is typed.

import { useState, type DragEvent, type KeyboardEvent } from 'react';

import type { Definition, JobDef, TeamNames } from '../../api/orders';
import type { Place } from './boardEdit';
import { durationWords } from './orderModel';

/** What the board asks of the page when it is being edited: the page rewrites the file, or says why it can't. */
export interface BoardEdit {
  moveJob(line: number, to: Place): void;
  moveStage(line: number, to: Place): void;
  addJob(stageLine: number): void;
  addStage(laneLine: number): void;
}

type Dragging = { kind: 'job' | 'stage'; line: number } | null;
type Mark = { line: number; side: 'before' | 'after' } | null;

function teamLabel(team: string, teams: TeamNames | null, matched: Record<string, string | null> | null): string {
  if (matched && team in matched) {
    const id = matched[team];
    return id && teams?.[id] ? teams[id].name : `${team} · not matched`;
  }
  return teams?.[team]?.name ?? team;
}

function jobById(def: Definition, id: string): JobDef | undefined {
  for (const l of def.lanes) for (const s of l.stages) for (const j of s.jobs) if (j.id === id) return j;
  return undefined;
}

function stageName(def: Definition, id: string): string {
  for (const l of def.lanes) for (const s of l.stages) if (s.id === id) return s.name;
  return id;
}

export function OrderBoard({
  definition,
  teams = null,
  matched = null,
  onPick,
  edit = null,
}: {
  definition: Definition;
  teams?: TeamNames | null;
  /** Slug to team id while a file is being written; null once installed. */
  matched?: Record<string, string | null> | null;
  /** A card was chosen: its line in the file. */
  onPick?: (line: number) => void;
  /** Dragging changes the file. Null: the board is only drawn. */
  edit?: BoardEdit | null;
}) {
  const [dragging, setDragging] = useState<Dragging>(null);
  const [mark, setMark] = useState<Mark>(null);
  const stages = definition.lanes.flatMap((l) => l.stages);
  const start = (kind: 'job' | 'stage', line: number) => (e: DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${kind}:${line}`);
    setDragging({ kind, line });
  };
  const end = () => {
    setDragging(null);
    setMark(null);
  };
  // Over a card or column: which side of it the drop lands, by where the pointer is.
  const over = (kind: 'job' | 'stage', line: number, axis: 'x' | 'y') => (e: DragEvent<HTMLElement>) => {
    if (dragging?.kind !== kind) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const side = (axis === 'y' ? e.clientY - r.top < r.height / 2 : e.clientX - r.left < r.width / 2) ? 'before' : 'after';
    if (mark?.line !== line || mark.side !== side) setMark({ line, side });
  };
  const drop = (kind: 'job' | 'stage') => (e: DragEvent) => {
    if (dragging?.kind !== kind || mark == null || edit == null) return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === 'job') edit.moveJob(dragging.line, mark);
    else edit.moveStage(dragging.line, mark);
    end();
  };
  // A column's empty space takes a job at its end.
  const overColumn = (lastJob: number | undefined) => (e: DragEvent) => {
    if (dragging?.kind !== 'job' || lastJob === undefined) return;
    e.preventDefault();
    if (mark?.line !== lastJob || mark.side !== 'after') setMark({ line: lastJob, side: 'after' });
  };
  const jobKeys = (job: JobDef) => (e: KeyboardEvent) => {
    if (!edit || !e.altKey) return;
    const si = stages.findIndex((st) => st.jobs.some((j) => j.line === job.line));
    const stage = stages[si];
    const ji = stage.jobs.findIndex((j) => j.line === job.line);
    if (e.key === 'ArrowUp' && ji > 0) edit.moveJob(job.line, { line: stage.jobs[ji - 1].line, side: 'before' });
    else if (e.key === 'ArrowDown' && ji < stage.jobs.length - 1) edit.moveJob(job.line, { line: stage.jobs[ji + 1].line, side: 'after' });
    else if ((e.key === 'ArrowLeft' && si > 0) || (e.key === 'ArrowRight' && si < stages.length - 1)) {
      const to = stages[si + (e.key === 'ArrowLeft' ? -1 : 1)];
      edit.moveJob(job.line, { line: to.jobs[to.jobs.length - 1].line, side: 'after' });
    } else return;
    e.preventDefault();
  };
  const stageKeys = (line: number) => (e: KeyboardEvent) => {
    if (!edit || !e.altKey) return;
    const i = stages.findIndex((st) => st.line === line);
    if (e.key === 'ArrowLeft' && i > 0) edit.moveStage(line, { line: stages[i - 1].line, side: 'before' });
    else if (e.key === 'ArrowRight' && i < stages.length - 1) edit.moveStage(line, { line: stages[i + 1].line, side: 'after' });
    else return;
    e.preventDefault();
  };
  const marked = (line: number) => (mark?.line === line ? ` order-board--drop-${mark.side}` : '');

  return (
    <div className={edit ? 'order-board order-board--edit' : 'order-board'} data-testid="order-board" onDragEnd={end}>
      {definition.lanes.map((lane) => (
        <section key={lane.id} className="order-board__lane" aria-label={lane.implicit ? 'Stages' : `Lane ${lane.name}`}>
          {!lane.implicit || definition.lanes.length > 1 ? (
            <div className="order-board__lane-head">
              <span className="order-board__lane-name">Lane · {lane.name}</span>
              <span className="order-board__lane-start">
                {lane.startsAfter ? `Starts after ${stageName(definition, lane.startsAfter)}` : 'Starts when the order opens'}
              </span>
            </div>
          ) : null}
          <div className="order-board__stages" style={{ gridTemplateColumns: `repeat(${Math.max(lane.stages.length, 1) + (edit ? 1 : 0)}, minmax(9.5rem, 1fr))` }}>
            {lane.stages.map((stage, i) => (
              <div
                key={stage.id}
                className={`order-board__stage${dragging?.kind === 'stage' ? marked(stage.line) : ''}`}
                onDragOver={dragging?.kind === 'stage' ? over('stage', stage.line, 'x') : overColumn(stage.jobs[stage.jobs.length - 1]?.line)}
                onDrop={dragging?.kind === 'stage' ? drop('stage') : drop('job')}
                data-testid={`board-stage-${stage.id}`}
              >
                <div
                  className="order-board__stage-head"
                  draggable={edit != null}
                  onDragStart={edit ? start('stage', stage.line) : undefined}
                  tabIndex={edit ? 0 : undefined}
                  onKeyDown={edit ? stageKeys(stage.line) : undefined}
                  aria-label={edit ? `Stage ${stage.name}. Drag, or Alt and an arrow key, to move it.` : undefined}
                  data-testid={`board-stage-head-${stage.id}`}
                >
                  <span>
                    {edit ? <span className="order-board__grip" aria-hidden="true">⋮⋮ </span> : null}
                    {i + 1} · {stage.name}
                  </span>
                  {stage.approval ? <span className="order-board__signoff">Signed off</span> : null}
                </div>
                {stage.jobs.map((job) => {
                  const waits = job.needs.map((n) => jobById(definition, n)?.name ?? n);
                  const facts = [
                    job.steps.length > 0 ? `${job.steps.length} step${job.steps.length === 1 ? '' : 's'}` : null,
                    job.dueMinutes !== null ? `due in ${durationWords(job.dueMinutes)}` : null,
                    job.makesPlan ? 'makes a plan' : null,
                    job.optional ? 'optional' : null,
                    job.when ? 'only for some orders' : null,
                    job.holds.length > 0 ? 'holds what it picks' : null,
                  ].filter(Boolean);
                  return (
                    <button
                      key={job.id}
                      type="button"
                      className={`order-board__job${dragging?.kind === 'job' ? marked(job.line) : ''}${dragging?.line === job.line && dragging.kind === 'job' ? ' order-board__job--lifted' : ''}`}
                      onClick={onPick ? () => onPick(job.line) : undefined}
                      disabled={!onPick && !edit}
                      draggable={edit != null}
                      onDragStart={edit ? start('job', job.line) : undefined}
                      onDragOver={edit ? over('job', job.line, 'y') : undefined}
                      onDrop={edit ? drop('job') : undefined}
                      onKeyDown={edit ? jobKeys(job) : undefined}
                      title={edit ? 'Drag to another place, or Alt and an arrow key. Choose it to see it in the file.' : undefined}
                      data-testid={`board-job-${job.id}`}
                    >
                      <span className="order-board__job-name">{job.name}</span>
                      <span className="order-board__job-team">{teamLabel(job.team, teams, matched)}</span>
                      {facts.length > 0 ? <span className="order-board__job-facts">{facts.join(' · ')}</span> : null}
                      {waits.length > 0 ? <span className="order-board__job-waits">Waits for {waits.join(', ')}</span> : null}
                      {job.sendBack ? <span className="order-board__job-back">↩ {job.sendBack.label}: back to {stageName(definition, job.sendBack.to)}</span> : null}
                    </button>
                  );
                })}
                {edit ? (
                  <button type="button" className="order-board__add" onClick={() => edit.addJob(stage.line)} data-testid={`board-add-job-${stage.id}`}>
                    + Job
                  </button>
                ) : null}
              </div>
            ))}
            {edit ? (
              <button type="button" className="order-board__add order-board__add--stage" onClick={() => edit.addStage(lane.line)} data-testid={`board-add-stage-${lane.id}`}>
                + Stage
              </button>
            ) : null}
          </div>
        </section>
      ))}
      <p className="order-board__key">Lanes run at the same time. Stages in a lane run left to right. Jobs in a stage run side by side unless one waits for another.</p>
    </div>
  );
}
