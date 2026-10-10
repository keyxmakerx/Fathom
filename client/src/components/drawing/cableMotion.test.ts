import { beforeEach, describe, expect, it } from 'vitest';
import { FRESH_WINDOW_MS, isFreshCable, liveSagPath, liveSagPx, LIVE_SAG_MAX_PX, markCablePlayed, markFreshCable, resetFreshCables } from './cableMotion';

beforeEach(resetFreshCables);

describe('live lead slack', () => {
  it('grows with length and stops at the cap', () => {
    expect(liveSagPx(0)).toBe(0);
    expect(liveSagPx(100)).toBeGreaterThan(liveSagPx(50));
    expect(liveSagPx(10_000)).toBe(LIVE_SAG_MAX_PX);
  });
  it('is the same path for the same inputs', () => {
    expect(liveSagPath(0, 0, 100, 0)).toBe(liveSagPath(0, 0, 100, 0));
    expect(liveSagPath(0, 0, 100, 0)).toMatch(/^M 0 0 C /);
  });
});

describe('fresh cables', () => {
  it('only matches a cable between the two ports just connected', () => {
    markFreshCable('p1', 'p2', 1000);
    expect(isFreshCable('c1', ['p2', 'p1'], 1500)).toBe(true);
    expect(isFreshCable('c2', ['p1', 'p9'], 1500)).toBe(false);
  });
  it('expires, and never plays twice', () => {
    markFreshCable('p1', 'p2', 1000);
    expect(isFreshCable('c1', ['p1', 'p2'], 1000 + FRESH_WINDOW_MS + 1)).toBe(false);
    markCablePlayed('c1');
    expect(isFreshCable('c1', ['p1', 'p2'], 1500)).toBe(false);
  });
  it('ignores cables nobody here just made', () => {
    expect(isFreshCable('c1', ['p1', 'p2'])).toBe(false);
  });
});
