import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { CorrectionView } from '../../api/corrections';
import { CableCorrections, TYPED_WARNING, WaitingPage, sayCorrection, type CorrectionsApi } from './CableCorrections';

// Render-to-string smoke tests, as the other component tests here do: no DOM library is installed.

const c = (over: Partial<CorrectionView>): CorrectionView => ({
  id: '01JCORRECTION000000000000AA',
  cable: 'cable:1',
  kind: 'label',
  text: 'PP1-04',
  sender: 'ann',
  senderName: 'Ann Floor',
  createdAt: Date.UTC(2026, 9, 3, 9, 0),
  state: 'open',
  decidedBy: null,
  decidedAt: null,
  version: 1,
  ...over,
});

const api = (canDraw: boolean, list: CorrectionView[]): CorrectionsApi => ({
  list,
  canDraw,
  send: async () => undefined,
  accept: async () => undefined,
  dismiss: async () => undefined,
});

const html = (a: CorrectionsApi, cableId = 'cable:1') => renderToStaticMarkup(createElement(CableCorrections, { cableId, api: a, accountId: 'ann' }));

describe('corrections on a cable page', () => {
  it('a reader gets the three buttons and no way to decide', () => {
    const out = html(api(false, []));
    expect(out).toContain('Traced ✓');
    expect(out).toContain('Label wrong');
    expect(out).toContain('Not here');
    expect(out).not.toContain('Accept');
    expect(out).not.toContain('Dismiss');
  });

  it('a reader sees what they sent and how it ended', () => {
    const out = html(api(false, [c({ state: 'dismissed' }), c({ id: 'x', cable: 'cable:2', text: 'ELSEWHERE' })]));
    expect(out).toContain('You said the label should read “PP1-04”');
    expect(out).toContain('dismissed');
    expect(out).not.toContain('ELSEWHERE');
  });

  it('a drawer sees the count, the sender and Accept / Dismiss, and no send buttons', () => {
    const out = html(api(true, [c({}), c({ id: 'y', kind: 'traced', text: '' }), c({ id: 'z', cable: 'cable:2' }), c({ id: 'w', state: 'accepted' })]));
    expect(out).toContain('Corrections waiting (2)');
    expect(out).toContain('Ann Floor says the label should read');
    expect(out).toContain('Accept');
    expect(out).toContain('Dismiss');
    expect(out).not.toContain('Label wrong');
  });

  it('a drawer with nothing waiting sees only the Traced stamp', () => {
    const out = html(api(true, [c({ state: 'accepted' })]));
    expect(out).toContain('Traced');
    expect(out).not.toContain('Label wrong');
    expect(out).not.toContain('Not here');
  });

  it('says each kind in a sentence', () => {
    expect(sayCorrection(c({ kind: 'traced', text: '' }), 'Ann')).toMatch(/^Ann traced this cable on 03 Oct 2026$/);
    expect(sayCorrection(c({ kind: 'not_here', text: 'in B3' }), 'Ann')).toBe('Ann says it is not here: in B3');
  });

  it('says a dismissed correction\'s text is gone, and tells a reader not to type passwords', () => {
    expect(sayCorrection(c({ state: 'dismissed', text: '' }), 'You')).toContain('removed once dismissed');
    expect(TYPED_WARNING).toBe('Fathom does not hide what you type, so do not type passwords.');
  });
});

describe('the waiting page', () => {
  const page = (list: CorrectionView[], cables: Map<string, string | null>) =>
    renderToStaticMarkup(createElement(WaitingPage, { api: api(true, list), cables, onOpenCable: () => undefined }));

  it('lists a correction whose cable is gone with Dismiss only, so it can always be cleared', () => {
    const out = page([c({ id: 'a', cable: 'cable:gone' }), c({ id: 'b', cable: 'cable:1' })], new Map([['cable:1', 'C-1']]));
    expect(out).toContain('Corrections waiting (2)');
    expect(out).toContain('no longer in this design');
    expect((out.match(/>Accept</g) ?? []).length).toBe(1);
    expect((out.match(/>Dismiss</g) ?? []).length).toBe(2);
    expect(out).toContain('C-1');
  });

  it('says so when nothing waits', () => {
    expect(page([], new Map())).toContain('Nothing is waiting');
  });
});
