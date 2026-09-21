// What the placement form says, and the arithmetic under it.
//
// The words are tested because they are the control: ADR-0055 decision 11
// makes the warning part of the guard (*"the page has warned, before the
// save, what happens next and how long there is"*), so a warning that
// stopped naming the new host, the window or the revert would be a
// regression in a safety property and not in a string.

import { describe, expect, it } from 'vitest';

import {
  countdownSentence,
  DEFAULT_WINDOW_MINUTES,
  describeWindow,
  formatCountdown,
  MAX_WINDOW_MINUTES,
  MIN_WINDOW_MINUTES,
  placementProblem,
  placementWarning,
  secondsLeft,
} from './placementCopy';

const draft = { hosts: 'console.example.net', sources: '', windowMinutes: 5 };

describe('placementWarning', () => {
  it('names the new host, the old host, the window and what happens if nobody signs in', () => {
    const lines = placementWarning(draft, 'fathom.example.net');
    const all = lines.join(' ');
    expect(all).toContain('console.example.net');
    expect(all).toContain('fathom.example.net');
    expect(all).toContain('5 minutes');
    expect(all).toContain('reverts');
    expect(all).toContain('404');
  });

  it('says in so many words what an empty source list is stored as', () => {
    expect(placementWarning(draft, 'here').join(' ')).toContain('0.0.0.0/0,::/0');
  });

  it('names the sources instead when they were given, and warns they apply to the operator too', () => {
    const lines = placementWarning({ ...draft, sources: '10.0.0.0/8' }, 'here').join(' ');
    expect(lines).toContain('10.0.0.0/8');
    expect(lines).not.toContain('0.0.0.0/0,::/0');
    expect(lines).toContain('including yours');
  });

  it('says "one minute" rather than "1 minutes" at the floor', () => {
    expect(describeWindow(1)).toBe('one minute');
    expect(describeWindow(60)).toBe('60 minutes');
    expect(placementWarning({ ...draft, windowMinutes: 1 }, 'here').join(' ')).toContain('one minute');
  });
});

describe('placementProblem', () => {
  it('passes a plain host, a list, an IPv6 literal and a host with a port stripped by the server', () => {
    expect(placementProblem(draft)).toBeNull();
    expect(placementProblem({ ...draft, hosts: 'a.example.net, b.example.net' })).toBeNull();
    expect(placementProblem({ ...draft, hosts: '[::1]' })).toBeNull();
    expect(placementProblem({ ...draft, hosts: 'localhost:18102' })).toBeNull();
  });

  it('refuses no host at all, which would confine the console to nowhere', () => {
    expect(placementProblem({ ...draft, hosts: '   ' })).toMatch(/at least one host/);
  });

  it('refuses a scheme, a path or a space inside a host', () => {
    expect(placementProblem({ ...draft, hosts: 'https://console.example.net' })).toMatch(/not a host name/);
    expect(placementProblem({ ...draft, hosts: 'console.example.net/admin' })).toMatch(/not a host name/);
    expect(placementProblem({ ...draft, hosts: 'console example net' })).toMatch(/not a host name/);
  });

  it('holds the window to one to sixty minutes and refuses to let it be turned off', () => {
    expect(MIN_WINDOW_MINUTES).toBe(1);
    expect(MAX_WINDOW_MINUTES).toBe(60);
    expect(DEFAULT_WINDOW_MINUTES).toBe(5);
    expect(placementProblem({ ...draft, windowMinutes: 0 })).toMatch(/cannot be turned off/);
    expect(placementProblem({ ...draft, windowMinutes: 61 })).toMatch(/cannot be turned off/);
    expect(placementProblem({ ...draft, windowMinutes: 1 })).toBeNull();
    expect(placementProblem({ ...draft, windowMinutes: 60 })).toBeNull();
    expect(placementProblem({ ...draft, windowMinutes: Number.NaN })).toMatch(/whole number/);
  });
});

describe('the countdown', () => {
  it('counts in whole seconds from the deadline the server sent, and floors at zero', () => {
    expect(secondsLeft(1_790_000_300, 1_790_000_000)).toBe(300);
    expect(secondsLeft(1_790_000_000, 1_790_000_300)).toBe(0);
  });

  it('reads as m:ss', () => {
    expect(formatCountdown(300)).toBe('5:00');
    expect(formatCountdown(59)).toBe('0:59');
    expect(formatCountdown(61)).toBe('1:01');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('changes what it says once the window has run out', () => {
    expect(countdownSentence('console.example.net', 90)).toBe(
      '1:30 left to sign in as an operator on console.example.net, or this placement reverts.',
    );
    expect(countdownSentence('console.example.net', 0)).toMatch(/window has run out/);
  });
});
