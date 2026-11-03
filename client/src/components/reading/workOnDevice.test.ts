import { describe, expect, it } from 'vitest';

import { createIssue, closeIssue } from '../../document/issues';
import { emptyDocument, type Document } from '../../document/model';
import { TYPED_AS_WRITTEN, addStep, callOff, createPlan, startPlan } from '../../document/plans';
import { recordStepTitle } from '../firmware/upgradePlan';
import { addBox, eth, tick } from '../troubleshoot/fixtures';
import { acceptAll, acceptable, againstPlan, compare, withWork } from './differences';
import { workOnDevice } from './workOnDevice';

const gate = TYPED_AS_WRITTEN;

function estate() {
  let doc: Document = emptyDocument();
  const a = addBox(doc, 'access-sw3', eth(4));
  doc = a.doc;
  const b = addBox(doc, 'dist-sw2', eth(4));
  doc = b.doc;
  return { doc, sw3: a.box, sw2: b.box };
}

function plan(doc: Document, title: string, steps: Parameters<typeof addStep>[2][]): { doc: Document; id: string } {
  const p = createPlan(doc, { title, gate, ...tick() });
  let next = p.doc;
  for (const s of steps) next = addStep(next, p.id, s).doc;
  return { doc: next, id: p.id };
}

const rename = (id: string, value: string) => ({
  kind: 'other' as const,
  change: `Rename to ${value}`,
  edit: { t: 'field' as const, id, key: 'Device.hostname', value },
  gate,
  ...tick(),
});

const reading = {
  system: { name: 'sw3-new.example.net' },
  inventory: [{ index: 1, class: 3, containedIn: 0, serial: 'JAE1', softwareRev: '17.12.3' }],
};

describe('device reading: other work on the device (r106)', () => {
  it('finds a plan under way on the device and what it sets, and leaves other devices alone', () => {
    let { doc, sw3, sw2 } = estate();
    const p = plan(doc, 'Rename access', [rename(sw3.device, 'sw3-new')]);
    doc = startPlan(p.doc, p.id, tick());
    const w = workOnDevice(doc, sw3.device);
    expect(w.running.map((x) => x.title)).toEqual(['Rename access']);
    expect(w.planned).toEqual([]);
    expect(w.sets.hostname).toMatchObject({ value: 'sw3-new', running: true, title: 'Rename access' });
    expect(workOnDevice(doc, sw2.device)).toMatchObject({ running: [], planned: [], issues: [], sets: {} });
  });

  it('counts a plan that only touches a port, and a step on an If path', () => {
    let { doc, sw3, sw2 } = estate();
    const p = plan(doc, 'Patch', [
      { kind: 'cable', change: 'Patch 1 to 1', edit: { t: 'cable', a: sw3.port('1'), b: sw2.port('1') }, gate, ...tick() },
    ]);
    doc = p.doc;
    expect(workOnDevice(doc, sw3.device).planned.map((x) => x.title)).toEqual(['Patch']);
  });

  it('leaves out plans that are over', () => {
    let { doc, sw3 } = estate();
    const p = plan(doc, 'Not now', [rename(sw3.device, 'x')]);
    doc = callOff(p.doc, p.id, { reason: 'not_needed', note: '', gate, ...tick() });
    expect(workOnDevice(doc, sw3.device)).toMatchObject({ running: [], planned: [], sets: {} });
  });

  it('reads the version a firmware plan records as running', () => {
    let { doc, sw3 } = estate();
    const p = plan(doc, 'Upgrade access to 17.15.1', [{ kind: 'other', change: recordStepTitle('17.15.1'), targets: [sw3.device], gate, ...tick() }]);
    doc = p.doc;
    expect(workOnDevice(doc, sw3.device).sets.os_version).toMatchObject({ value: '17.15.1', running: false });
  });

  it('finds an open It’s down issue and drops it once closed', () => {
    let { doc, sw3 } = estate();
    const i = createIssue(doc, { deviceId: sw3.device, title: 'Port 4 dark', steps: [{ topic: 'link', question: 'Is the light on?' }], gate, ...tick() });
    doc = i.doc;
    expect(workOnDevice(doc, sw3.device).issues.map((x) => x.title)).toEqual(['Port 4 dark']);
    doc = closeIssue(doc, i.id, { text: 'fixed', gate, ...tick() });
    expect(workOnDevice(doc, sw3.device).issues).toEqual([]);
  });

  it('marks the rows a plan sets; Accept all leaves out the one it would undo, keeps the one the device already shows', () => {
    let { doc, sw3 } = estate();
    const p = plan(doc, 'Tidy', [
      rename(sw3.device, 'sw3-other'),
      { kind: 'other', change: recordStepTitle('17.12.3'), targets: [sw3.device], gate, ...tick() },
    ]);
    doc = startPlan(p.doc, p.id, tick());
    const c = withWork(compare(doc, sw3.device, reading, []), workOnDevice(doc, sw3.device));
    const by = Object.fromEntries(c.differs.map((d) => [d.field, d]));
    expect(by.hostname!.planned?.value).toBe('sw3-other');
    expect(againstPlan(by.hostname!)).toBe(true);
    expect(by.os_version!.planned?.value).toBe('17.12.3');
    expect(againstPlan(by.os_version!)).toBe(false);
    expect(by.serial!.planned).toBeUndefined();
    expect(acceptable(c.differs).map((d) => d.field)).toEqual(['serial', 'os_version']);
    const all = acceptAll(c.differs);
    expect(all?.kind === 'all' ? all.changes.length : 0).toBe(2);
  });
});
