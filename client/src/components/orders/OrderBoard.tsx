// The board (ADR-0084 decision 5, r103): an order type drawn as lanes of stages, each stage a
// column of job cards. Lanes run at the same time; stages in a lane run left to right. It is
// drawn from the checked file, so it can never show something the file doesn't say.

import type { Definition, JobDef, TeamNames } from '../../api/orders';
import { durationWords } from './orderModel';

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
}: {
  definition: Definition;
  teams?: TeamNames | null;
  /** Slug to team id while a file is being written; null once installed. */
  matched?: Record<string, string | null> | null;
  /** A card was chosen: its line in the file. */
  onPick?: (line: number) => void;
}) {
  return (
    <div className="order-board" data-testid="order-board">
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
          <div className="order-board__stages" style={{ gridTemplateColumns: `repeat(${Math.max(lane.stages.length, 1)}, minmax(9.5rem, 1fr))` }}>
            {lane.stages.map((stage, i) => (
              <div key={stage.id} className="order-board__stage">
                <div className="order-board__stage-head">
                  <span>
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
                    <button key={job.id} type="button" className="order-board__job" onClick={onPick ? () => onPick(job.line) : undefined} disabled={!onPick} data-testid={`board-job-${job.id}`}>
                      <span className="order-board__job-name">{job.name}</span>
                      <span className="order-board__job-team">{teamLabel(job.team, teams, matched)}</span>
                      {facts.length > 0 ? <span className="order-board__job-facts">{facts.join(' · ')}</span> : null}
                      {waits.length > 0 ? <span className="order-board__job-waits">Waits for {waits.join(', ')}</span> : null}
                      {job.sendBack ? <span className="order-board__job-back">↩ {job.sendBack.label}: back to {stageName(definition, job.sendBack.to)}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      ))}
      <p className="order-board__key">Lanes run at the same time. Stages in a lane run left to right. Jobs in a stage run side by side unless one waits for another.</p>
    </div>
  );
}
