// ADR-0057 decision 8: a wrong or missing code (403) or an already-gone
// session (404) on the session-ending routes, and any other 403 elsewhere,
// are not "this session died" — only a real 401 is.
import { describe, expect, it } from 'vitest';

import { isSessionDeathStatus, MAX_SIGNED_IN_FLIGHT, RequestGate } from './signedFetch';

describe('isSessionDeathStatus (ADR-0057 decision 8)', () => {
  it('is true for 401 — the one status sessions.rs uses for "not live"', () => {
    expect(isSessionDeathStatus(401)).toBe(true);
  });

  it('is false for 403 — a wrong or missing verification code on a session-ending route', () => {
    expect(isSessionDeathStatus(403)).toBe(false);
  });

  it('is false for 404 — a session-ending route whose target is already gone', () => {
    expect(isSessionDeathStatus(404)).toBe(false);
  });

  it('is false for 403 on a credentials route — a wrong current password or code leaves the tab signed in, it does not sign it out', () => {
    // `/credentials/*` routes answer this same 403 for a refused factor
    // (`api.rs`'s `credential_check_refused`); the predicate does not care
    // which route sent it — true only for 401, on every route.
    expect(isSessionDeathStatus(403)).toBe(false);
  });

  it('is false for every other status this client handles', () => {
    for (const status of [200, 400, 409, 429, 500, 503]) {
      expect(isSessionDeathStatus(status)).toBe(false);
    }
  });
});

describe('RequestGate: a burst cannot spend the session', () => {
  it('stays inside the 32 nonces and the 32-wide counter window sessions.rs allows one session', () => {
    expect(MAX_SIGNED_IN_FLIGHT).toBeGreaterThan(0);
    expect(MAX_SIGNED_IN_FLIGHT).toBeLessThan(32);
  });

  it('never runs more than its limit at once, and runs all 55 of a catalogue-sized burst in order', async () => {
    const gate = new RequestGate(MAX_SIGNED_IN_FLIGHT);
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 55 }, (_, i) =>
        gate.run(async () => {
          started.push(i);
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 1));
          running -= 1;
          return i;
        }),
      ),
    );
    expect(peak).toBe(MAX_SIGNED_IN_FLIGHT);
    expect(results).toEqual(Array.from({ length: 55 }, (_, i) => i));
    expect(started).toEqual(Array.from({ length: 55 }, (_, i) => i));
  });

  it('gives the slot back when a task throws', async () => {
    const gate = new RequestGate(1);
    await expect(gate.run(() => Promise.reject(new Error('refused')))).rejects.toThrow('refused');
    await expect(gate.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });
});
