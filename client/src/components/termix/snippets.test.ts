// ADR-0080 decision 4: step commands become Termix snippets the person runs; Fathom never runs them.
import { describe, expect, it } from 'vitest';

import type { Plan, PlanStep } from '../../document/plans';
import { FETCH_STEP_TITLE, LINK_PLACEHOLDER, recordStepTitle } from '../firmware/upgradePlan';
import { LINK_INPUT, commandSteps, hostIdsFor, sendSnippets, snippetFolder, snippetFor, snippetSummary } from './snippets';

const step = (ordinal: number, change: string, after = ''): PlanStep => ({
  id: `PlanStep:${ordinal}`, ordinal, kind: 'other', change, before: '', after, targets: ['Device:a'], edit: null, state: 'planned', note: '', doneAt: '', seen: '', compared: null, label: String(ordinal + 1), ifWhen: '', branchOf: '', ifTaken: false, issue: '',
});
const plan = (steps: PlanStep[], title = 'Upgrade EX2300 to 23.4R2'): Plan => ({
  id: 'MaintenancePlan:1', title, windowStart: '', windowEnd: '', author: '', stage: 'planned', outcome: null, record: '', steps, ifPaths: {}, checks: [], releaseNotes: '',
});

const firmware = plan([
  step(0, `${FETCH_STEP_TITLE}\nThe device pulls it`, `file copy ${LINK_PLACEHOLDER} /var/tmp/junos.tgz`),
  step(1, 'Install it\nThen reboot', 'request system software add /var/tmp/junos.tgz\nrequest system reboot'),
  step(2, 'Check the version'),
  step(3, recordStepTitle('23.4R2')),
]);

describe('which steps become snippets', () => {
  it('a firmware plan’s steps that carry commands', () => {
    expect(commandSteps(firmware).map((s) => s.ordinal)).toEqual([0, 1]);
  });

  it('none from a plan that is not a firmware plan, whatever its After says', () => {
    expect(commandSteps(plan([step(0, 'Re-address sw2', '10.0.0.9')], 'Re-address'))).toEqual([]);
  });
});

describe('a snippet', () => {
  it('is named <n> · <title>, in Fathom / <plan>, offered on the plan’s Termix hosts', () => {
    const s = snippetFor(firmware, firmware.steps[1]!, ['core-sw1'], [4, 7]);
    expect(s.name).toBe('2 · Install it');
    expect(s.folder).toBe('Fathom / Upgrade EX2300 to 23.4R2');
    expect(s.content).toBe('request system software add /var/tmp/junos.tgz\nrequest system reboot');
    expect(s.hostFilter).toEqual([4, 7]);
    expect(s.description).toContain('For core-sw1.');
  });

  it('asks for the one-time link when it runs, so the link is never stored in Termix', () => {
    const s = snippetFor(firmware, firmware.steps[0]!, [], []);
    expect(s.content).toBe(`file copy ${LINK_INPUT} /var/tmp/junos.tgz`);
    expect(s.content).not.toContain(LINK_PLACEHOLDER);
    expect(s.hostFilter).toBeNull();
  });

  it('a plan title with a slash does not make a deeper folder', () => {
    expect(snippetFolder({ title: 'HQ / core' })).toBe('Fathom / HQ - core');
  });

  it('finds the plan’s hosts by address', () => {
    const hosts = [
      { id: 1, name: 'a', ip: '10.0.0.1', port: 2222 },
      { id: 2, name: 'a', ip: '10.0.0.1', port: 22 },
      { id: 3, name: 'b', ip: '10.0.0.2', port: 22 },
    ];
    expect(hostIdsFor(hosts, ['10.0.0.1/24', '', '10.0.0.9', '10.0.0.1'])).toEqual([2]);
  });
});

describe('sending them', () => {
  it('makes the folder, then each snippet, and leaves one already there alone; never calls /execute', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${init.method} ${path}`);
      if (init.method === 'GET') return new Response(JSON.stringify([{ id: 9, name: '1 · Fetch the image from Fathom', folder: 'Fathom / Upgrade EX2300 to 23.4R2' }]), { status: 200 });
      if (path.endsWith('/folders')) return new Response('{}', { status: 409 });
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    const bodies = commandSteps(firmware).map((s) => snippetFor(firmware, s, [], []));
    const r = await sendSnippets('https://t.example', 'tmx_' + 'a'.repeat(64), bodies, f);
    expect(r).toEqual({ sent: 1, already: 1, folder: 'Fathom / Upgrade EX2300 to 23.4R2' });
    expect(calls).toEqual(['GET /plugin-api/snippets', 'POST /plugin-api/snippets/folders', 'POST /plugin-api/snippets']);
    expect(calls.some((c) => c.includes('execute'))).toBe(false);
    expect(snippetSummary(r)).toBe('Sent 1 step to Termix as snippets, in Fathom / Upgrade EX2300 to 23.4R2; 1 was there already and is left as it is. Run each one yourself, on the terminal you opened.');
  });
});
