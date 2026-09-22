import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  authenticatorStepIntro,
  FIRST_RUN_STEPS,
  FirstRun,
  passwordStepIntro,
  progressLine,
  SETUP_TOKEN_REFUSED,
} from './FirstRun';

// Render-to-string smoke tests, per `ConfigDrawer.render.test.ts`'s
// precedent -- no DOM testing library is installed, so this checks the markup
// the flow produces, which is what a render-to-string pass can see. The later
// steps are behind state this pass cannot reach, so their wording is exported
// as plain functions and checked here directly: a sentence nobody can test is
// a sentence nobody can check the wording of. ADR-0056 decisions 2 and 4.
// 2026-09-22.

const html = renderToStaticMarkup(createElement(FirstRun, {}));

describe('the first run, step 1', () => {
  it('opens on the token and asks for nothing else', () => {
    expect(html).toContain('id="firstrun-token"');
    // The address is the server's to name (decision 2 step 1): nothing is
    // typed here, which is the owner's "give an error if the email doesn't
    // match" met by removing the field. Step 2 shows it, read-only.
    expect(html).not.toContain('id="firstrun-address"');
    expect(html).not.toContain('id="firstrun-password"');
  });

  it('says where the token is and how to copy it out', () => {
    expect(html).toMatch(/docker compose cp/);
    expect(html).toMatch(/first-operator-token/);
    expect(html).toMatch(/replaces the old one/i);
  });

  it('leads with the ADR’s own welcome, and counts the steps', () => {
    expect(html).toContain(
      'This server has just been set up. Prove you are the person who installed it.',
    );
    expect(html).toContain('Step 1 of 5');
  });

  it('says the first step spends nothing', () => {
    // `POST /enrolment/operator/setup/check` is a read: no chain entry, no
    // token spent. A person who mistypes the line loses nothing by it.
    expect(html).toMatch(/Nothing is spent by this step/);
  });

  it('offers no other door', () => {
    // ADR-0056 decision 2: while the deployment is pending this is the whole
    // of the client. No sign-in link, no invitation, no reset.
    expect(html).not.toMatch(/sign in/i);
    expect(html).not.toMatch(/invit/i);
    expect(html).not.toMatch(/forgot/i);
  });
});

describe('the steps and the progress line', () => {
  it('is five steps, the last two drawn by the enrolment component', () => {
    expect(FIRST_RUN_STEPS).toEqual([
      'Welcome',
      'Choose a password',
      'Set up your authenticator app',
      'Recovery codes',
      'Done',
    ]);
    expect(progressLine(2)).toBe('Step 2 of 5');
  });
});

describe('step 2, choose a password', () => {
  const intro = passwordStepIntro('owner@example.test');

  it('names the address the server gave and does not ask for it', () => {
    expect(intro).toContain('owner@example.test');
    expect(intro).toMatch(/nothing to type and nothing to get wrong/);
  });
});

describe('step 3, the authenticator app', () => {
  const intro = authenticatorStepIntro('owner@example.test');

  it('says why this account needs a second factor, and what is left', () => {
    expect(intro).toContain('owner@example.test');
    expect(intro).toMatch(/second factor/);
    expect(intro).toMatch(/recovery codes/i);
  });
});

describe('the sentence a refused setup token gets', () => {
  it('is the ADR’s, and names the token file rather than a cause', () => {
    // Wrong, spent, expired and malformed are one answer on purpose.
    expect(SETUP_TOKEN_REFUSED).toBe(
      'Setup token is missing or invalid. Find the current token in the server’s token file.',
    );
  });
});

describe('the words this flow uses', () => {
  it('never says "app code" or "backup code" where a person reads', () => {
    // ADR-0056 decision 4, checked on everything this flow can put in front
    // of a person: the first screen's markup and the later screens' copy.
    for (const text of [
      html,
      passwordStepIntro('owner@example.test'),
      authenticatorStepIntro('owner@example.test'),
      SETUP_TOKEN_REFUSED,
      ...FIRST_RUN_STEPS,
    ]) {
      expect(text).not.toMatch(/app code/i);
      expect(text).not.toMatch(/backup code/i);
    }
  });
});
