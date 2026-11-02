import { describe, expect, it } from 'vitest';

import { createSketchDevice } from './commands';
import { createIssue, TYPED_AS_WRITTEN as ISSUE_TYPED } from './issues';
import { emptyDocument, findNode, type Document } from './model';
import { addNote, notesOf } from './notes';
import { readPlain, writePlain } from './plain';
import { createPlan, TYPED_AS_WRITTEN } from './plans';
import { undo } from './undo';
import { isIsoDate, numberWord, readWork, setWorkField, ticketHref, WorkFieldError, workKindOf } from './work';

const ACCOUNT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: ACCOUNT, now: (now += 1000) });
})();

function planAndIssue(): { doc: Document; plan: string; issue: string } {
  let doc = createSketchDevice(emptyDocument(), { hostname: 'srx1500-lab', ...tick() });
  const device = doc.nodes.find((n) => n.id.startsWith('device:'))!.id;
  const p = createPlan(doc, { title: 'Junos upgrade', gate: TYPED_AS_WRITTEN, ...tick() });
  const i = createIssue(p.doc, { deviceId: device, title: 'ae0 drops', steps: [{ topic: 'link', question: 'Link light?' }], gate: ISSUE_TYPED, ...tick() });
  return { doc: i.doc, plan: p.id, issue: i.id };
}

describe('the Work tab parts on a piece of work (sign-off r74)', () => {
  it('assigns a plan, sets an issue due and gives both an outside ticket, one undo step each', () => {
    const { doc: d0, plan, issue } = planAndIssue();
    let doc = setWorkField(d0, plan, 'assigned_to', ACCOUNT, { gate: TYPED_AS_WRITTEN, ...tick() });
    doc = setWorkField(doc, plan, 'ticket', 'https://jira.example.com/browse/NET-42', { gate: TYPED_AS_WRITTEN, ...tick() });
    doc = setWorkField(doc, issue, 'due', '2026-11-07', { gate: TYPED_AS_WRITTEN, ...tick() });
    expect(readWork(doc, plan)).toEqual({ assignedTo: ACCOUNT, due: '', ticket: 'https://jira.example.com/browse/NET-42' });
    expect(readWork(doc, issue)?.due).toBe('2026-11-07');
    const back = undo(doc, doc.batches[doc.batches.length - 1].id, tick());
    expect(readWork(back, issue)?.due).toBe('');
    // Saved and opened again, the fields are there.
    expect(readWork(readPlain(writePlain(doc)), plan)?.assignedTo).toBe(ACCOUNT);
  });

  it('clears a field when it is emptied', () => {
    const { doc: d0, plan } = planAndIssue();
    const set = setWorkField(d0, plan, 'ticket', 'INC0012345', { gate: TYPED_AS_WRITTEN, ...tick() });
    const cleared = setWorkField(set, plan, 'ticket', '  ', { gate: TYPED_AS_WRITTEN, ...tick() });
    expect(readWork(cleared, plan)?.ticket).toBe('');
  });

  it('passes a pasted outside ticket through the gate', () => {
    const { doc: d0, plan } = planAndIssue();
    const gate = (t: string) => t.replace(/token=\S+/, 'token=<REDACTED>');
    const doc = setWorkField(d0, plan, 'ticket', 'https://helpdesk.example.com/t/9?token=abc123', { gate, ...tick() });
    expect(readWork(doc, plan)?.ticket).toBe('https://helpdesk.example.com/t/9?token=<REDACTED>');
  });

  it('refuses a due date that is not a date, an assignee that is not an account, and a plan due date', () => {
    const { doc, plan, issue } = planAndIssue();
    expect(() => setWorkField(doc, issue, 'due', 'next Friday', { gate: TYPED_AS_WRITTEN })).toThrow(WorkFieldError);
    expect(() => setWorkField(doc, issue, 'assigned_to', 'Key Maker', { gate: TYPED_AS_WRITTEN })).toThrow(WorkFieldError);
    expect(() => setWorkField(doc, plan, 'due', '2026-11-07', { gate: TYPED_AS_WRITTEN })).toThrow(WorkFieldError);
    const device = doc.nodes.find((n) => n.id.startsWith('device:'))!.id;
    expect(() => setWorkField(doc, device, 'ticket', 'x', { gate: TYPED_AS_WRITTEN })).toThrow();
  });

  it('takes comments as notes on the plan, the issue or a spare, who and when from their provenance', () => {
    const { doc: d0, plan, issue } = planAndIssue();
    const at = tick();
    let doc = addNote(d0, plan, { text: 'Change window confirmed with the NOC', how: 'typed', ...at });
    doc = addNote(doc, issue, { text: 'Optic swapped', how: 'typed', ...tick() });
    const [c] = notesOf(doc, plan);
    expect(c.text).toBe('Change window confirmed with the NOC');
    expect(c.who).toBe(ACCOUNT);
    expect(c.when).toBe(at.now);
    expect(notesOf(doc, issue)).toHaveLength(1);
    expect(findNode(readPlain(writePlain(doc)), c.id)).toBeDefined();
  });

  it('knows a piece of work by its id, and writes numbers and links the way the server does', () => {
    const { plan, issue } = planAndIssue();
    expect(workKindOf(plan)).toBe('MaintenancePlan');
    expect(workKindOf(issue)).toBe('Issue');
    expect(workKindOf('device:01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
    expect(workKindOf('nonsense')).toBeNull();
    expect(numberWord(42)).toBe('W-42');
    expect(isIsoDate('2026-11-07')).toBe(true);
    expect(isIsoDate('2026-13-07')).toBe(false);
    expect(ticketHref('https://jira.example.com/browse/NET-42')).toBe('https://jira.example.com/browse/NET-42');
    expect(ticketHref('javascript:alert(1)')).toBeNull();
    expect(ticketHref('INC0012345')).toBeNull();
  });
});
