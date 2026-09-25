import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ClaimOrganisation, RecoveryKeyStage } from './ClaimOrganisation';

// Render-to-string smoke tests (see `SignIn.render.test.ts`'s note and
// `Account.render.test.ts`'s own version of this pair, `RecoveryCodesStage`).

describe('the organisation claim form', () => {
  it('asks for a token and the notice address when neither is given', () => {
    const html = renderToStaticMarkup(
      createElement(ClaimOrganisation, {
        accountAddress: 'founder@example.test',
        accountId: '01JXACCOUNTIDEXAMPLE000001',
        onDone: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toContain('id="claim-token"');
    expect(html).toContain('id="claim-notice-address"');
    expect(html).toContain('founder@example.test');
    // A recovery key only appears once it has actually been generated.
    expect(html).not.toContain('data-testid="recovery-key"');
    expect(html.toLowerCase()).not.toContain('recovery key');
  });

  it('pre-fills and disables the fields "Claim it now" hands over', () => {
    const html = renderToStaticMarkup(
      createElement(ClaimOrganisation, {
        accountAddress: 'founder@example.test',
        accountId: '01JXACCOUNTIDEXAMPLE000001',
        initialToken: new Uint8Array([1, 2, 3, 4]),
        initialNoticeAddress: 'owner@example.test',
        onDone: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toMatch(/id="claim-token"[^>]*disabled/);
    expect(html).toMatch(/id="claim-notice-address"[^>]*disabled/);
    expect(html).toContain('value="owner@example.test"');
  });
});

describe('the recovery-key stage, rendered', () => {
  const KEY_TEXT = 'AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4IB-CEQT-CQKR-MFYY-DENB-WHA5-DYPQ-MMG4';
  const render = (saved: boolean, busy = false, notice: string | null = null, locked = false) =>
    renderToStaticMarkup(
      createElement(RecoveryKeyStage, {
        recoveryKeyText: KEY_TEXT,
        saved,
        onSavedChange: () => {},
        busy,
        notice,
        locked,
        onContinue: () => {},
      }),
    );

  it('shows the key exactly once', () => {
    const html = render(false);
    const occurrences = html.split(KEY_TEXT).length - 1;
    expect(occurrences).toBe(1);
  });

  it('says what the key is for, truthfully, without the forbidden sentences', () => {
    const html = render(false);
    // Nothing in Fathom can use the root key today -- the sentence says so.
    expect(html).toMatch(/root key/i);
    expect(html).toMatch(/cannot use it for anything yet/i);
    expect(html).toMatch(/cannot be shown again/i);
    expect(html).toMatch(/plain text/i);
    const lower = html.toLowerCase();
    // ADR-0040 §6's four forbidden sentences, checked for their absence.
    expect(lower).not.toContain('zero-knowledge');
    expect(lower).not.toContain('end-to-end');
    expect(lower).not.toContain('we cannot read your data');
    expect(lower).not.toContain('only you hold the key');
  });

  it('offers Download and Print', () => {
    const html = render(false);
    expect(html).toMatch(/Download/);
    expect(html).toMatch(/Print/);
  });

  it('keeps Continue disabled until "I have saved this" is checked', () => {
    const unsaved = render(false);
    expect(unsaved).toContain('I have saved this.');
    expect(unsaved).toContain('aria-checked="false"');
    expect(unsaved).toMatch(/<button[^>]*disabled[^>]*>Continue<\/button>/);

    const saved = render(true);
    expect(saved).toContain('aria-checked="true"');
    expect(saved).toMatch(/<button[^>]*>Continue<\/button>/);
    expect(saved).not.toMatch(/<button[^>]*disabled[^>]*>Continue<\/button>/);
  });

  it('disables Continue again while the claim it confirms is being sent', () => {
    const html = render(true, true);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Claiming…<\/button>/);
  });

  it('keeps the key on screen, disables Continue and says to reload after a lost answer', () => {
    const html = render(true, false, 'There was no answer. Reload this page to check.', true);
    const occurrences = html.split(KEY_TEXT).length - 1;
    expect(occurrences).toBe(1);
    expect(html).toContain('There was no answer. Reload this page to check.');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Continue<\/button>/);
  });
});
