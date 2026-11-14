// Dragging the board rewrites the file (ADR-0084 decision 5, r142). The lines here are the ones the server's check
// reports for corpus/orders/dia.yaml; the Rust reader's own tests hold that file to them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Definition, JobDef, StageDef } from '../../api/orders';
import { addJob, addStage, moveJob, moveStage, type Edit } from './boardEdit';

const DIA = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../corpus/orders/dia.yaml'), 'utf8');

const job = (id: string, line: number, team: string): JobDef =>
  ({ id, name: id, team, steps: [], asks: [], when: null, dueMinutes: null, overdue: [], optional: false, makesPlan: false, needs: [], sendBack: null, reserves: null, holds: [], line }) as JobDef;
const stage = (id: string, line: number, jobs: JobDef[]): StageDef => ({ id, name: id, approval: null, jobs, line });

const dia: Definition = {
  id: 'dia',
  name: 'Dedicated Internet Access',
  code: 'DIA',
  fields: [],
  lanes: [
    {
      id: 'main',
      name: 'Main',
      startsAfter: null,
      implicit: true,
      line: 17,
      stages: [
        stage('order', 17, [job('check', 20, 'order-desk')]),
        stage('design', 29, [job('addresses', 33, 'ip-design'), job('port', 34, 'network-design')]),
        stage('provision', 42, [job('configure', 45, 'provisioning')]),
        stage('install', 53, [job('handoff', 56, 'field')]),
      ],
    },
  ],
};

const ok = (e: Edit): string => {
  if (!e.ok) throw new Error(e.why);
  return e.source;
};
const ids = (src: string): string[] => [...src.matchAll(/^\s*- (?:\{ )?id: ([\w-]+)/gm)].map((m) => m[1]);

describe('dragging the board', () => {
  it('moves a job into another stage, keeping how it is written and its comment, at the new depth', () => {
    const out = ok(moveJob(DIA, dia, 34, { line: 56, side: 'after' }));
    expect(ids(out)).toEqual(['order', 'check', 'design', 'addresses', 'provision', 'configure', 'install', 'handoff', 'port']);
    expect(out).toContain('        holds: [edge_port]          # the port stays held for this order until it closes');
    // Nothing else changed: the same lines, in another order.
    expect(out.split('\n').sort()).toEqual(DIA.split('\n').sort());
  });

  it('reorders jobs within a stage, either way', () => {
    expect(ids(ok(moveJob(DIA, dia, 34, { line: 33, side: 'before' })))).toEqual(['order', 'check', 'design', 'port', 'addresses', 'provision', 'configure', 'install', 'handoff']);
    expect(ids(ok(moveJob(DIA, dia, 33, { line: 34, side: 'after' })))).toEqual(['order', 'check', 'design', 'port', 'addresses', 'provision', 'configure', 'install', 'handoff']);
  });

  it('moves a stage with all its jobs', () => {
    const out = ok(moveStage(DIA, dia, 53, { line: 29, side: 'before' }));
    expect(ids(out)).toEqual(['order', 'check', 'install', 'handoff', 'design', 'addresses', 'port', 'provision', 'configure']);
    expect(out.split('\n').sort()).toEqual(DIA.split('\n').sort());
    // Dropped on itself: nothing changes.
    expect(ok(moveStage(DIA, dia, 29, { line: 29, side: 'after' }))).toBe(DIA);
  });

  it("refuses to leave a stage with no job, and says what to do", () => {
    const e = moveJob(DIA, dia, 20, { line: 33, side: 'before' });
    expect(e).toEqual({ ok: false, why: 'It is the only job in order, and a stage needs at least one. Add another job there first.' });
  });

  it('refuses a job written inside a one-line stage', () => {
    const src = ['stages:', '  - { id: a, name: A, jobs: [{ id: j, name: J, team: t }] }', '  - id: b', '    name: B', '    jobs:', '      - { id: k, name: K, team: t }', '      - { id: m, name: M, team: t }', ''].join('\n');
    const def: Definition = {
      ...dia,
      lanes: [{ ...dia.lanes[0], line: 2, stages: [stage('a', 2, [job('j', 2, 't')]), stage('b', 3, [job('k', 6, 't'), job('m', 7, 't')])] }],
    };
    expect(moveJob(src, def, 6, { line: 2, side: 'after' })).toMatchObject({ ok: false, why: 'Stage a is written on one line in the file, so it can only be changed there.' });
    // The one-line stage itself still moves whole.
    expect(ids(ok(moveStage(src, def, 2, { line: 3, side: 'after' })))).toEqual(['b', 'k', 'm', 'a']);
  });

  it('adds a job for the same team at the end of a stage, and a stage at the end of the lane, with ids nobody has', () => {
    const one = ok(addJob(DIA, dia, 29));
    expect(one.split('\n')[40]).toBe('      - { id: job-1, name: New job, team: network-design }');
    const two = ok(addStage(DIA, dia, 17));
    expect(two.split('\n').slice(-6)).toEqual(['', '  - id: stage-1', '    name: New stage', '    jobs:', '      - { id: job-1, name: New job, team: field }', '']);
  });
});
