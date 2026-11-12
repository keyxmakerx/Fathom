// A failed read of a plan's approval is said, not passed off as a folder that does not ask (audit
// r110 item E).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PlanApprovalSection, type PlanApprovalState } from './PlanApproval';

const state = (over: Partial<PlanApprovalState>): PlanApprovalState => ({
  required: false,
  entry: undefined,
  names: {},
  inStep: false,
  startHeld: false,
  busy: false,
  error: null,
  loadError: null,
  retry: () => {},
  sign: async () => true,
  ask: async () => true,
  ...over,
});

const render = (s: PlanApprovalState): string => renderToStaticMarkup(createElement(PlanApprovalSection, { state: s, canEdit: true, onEmergencyStarted: () => {} }));

describe('PlanApprovalSection when the approval could not be read', () => {
  it('shows nothing for a folder that does not ask, read without trouble', () => {
    expect(render(state({}))).toBe('');
  });

  it('says the read failed, with a way to ask again, before the server has answered', () => {
    const html = render(state({ loadError: 'Could not get this plan’s approval from the server: offline' }));
    expect(html).toContain('data-testid="plans-approval-unread"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('offline');
    expect(html).toContain('Try again');
  });

  it('says it under the section too when the folder does ask', () => {
    const html = render(state({ required: true, loadError: 'Could not read this plan to check its approval: boom' }));
    expect(html).toContain('This folder asks for plans to be approved');
    expect(html).toContain('boom');
  });
});
