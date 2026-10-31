import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_RESUME, loadResume, parseResume, patchResume, resumeKey, viewShowsAny } from './resume';

describe('parseResume', () => {
  it('keeps what is valid', () => {
    const r = parseResume({ camera: { x: -10, y: 20, zoom: 1.5 }, place: 'inventory', tab: 'trail', equipmentOpen: true, equipmentClosedOnce: true, selection: { kind: 'chassis', id: 'n1' } });
    expect(r).toEqual({ camera: { x: -10, y: 20, zoom: 1.5 }, place: 'inventory', tab: 'trail', equipmentOpen: true, equipmentClosedOnce: true, selection: { kind: 'chassis', id: 'n1' } });
  });

  it('drops damaged parts one by one', () => {
    const r = parseResume({ camera: { x: 'a', y: 0, zoom: 1 }, place: 'sheet', tab: 'history', equipmentOpen: 'yes', equipmentClosedOnce: 'yes', selection: { kind: 'port', id: 'p' } });
    expect(r).toEqual(EMPTY_RESUME);
    expect(parseResume(null)).toEqual(EMPTY_RESUME);
    expect(parseResume({ camera: { x: 0, y: 0, zoom: 0 } }).camera).toBeNull();
  });
});

describe('resumeKey', () => {
  it('is per account and design, like the layers key', () => {
    expect(resumeKey('a1', 'd1')).toBe('fathom.resume.a1.d1');
    expect(resumeKey(null, undefined)).toBe('fathom.resume.anon.unsaved');
  });
});

describe('viewShowsAny', () => {
  const pane = { width: 800, height: 600 };
  it('is true when some rack is in view', () => {
    expect(viewShowsAny({ x: 0, y: 0, zoom: 1 }, pane, [{ x: 100, y: 100, width: 50, height: 50 }])).toBe(true);
  });
  it('is false when the camera looks at empty canvas', () => {
    expect(viewShowsAny({ x: -5000, y: 0, zoom: 1 }, pane, [{ x: 100, y: 100, width: 50, height: 50 }])).toBe(false);
  });
  it('allows a design with nothing drawn', () => {
    expect(viewShowsAny({ x: 0, y: 0, zoom: 1 }, pane, [])).toBe(true);
  });
});

describe('closing Equipment once, kept per design', () => {
  afterEach(() => vi.unstubAllGlobals());
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it('is remembered for that design only', () => {
    vi.stubGlobal('localStorage', memory());
    expect(loadResume('a', 'd1').equipmentClosedOnce).toBe(false);
    patchResume('a', 'd1', { equipmentClosedOnce: true });
    expect(loadResume('a', 'd1').equipmentClosedOnce).toBe(true);
    expect(loadResume('a', 'd2').equipmentClosedOnce).toBe(false);
    expect(loadResume('b', 'd1').equipmentClosedOnce).toBe(false);
  });
  it('behaves as before when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    vi.stubGlobal('localStorage', broken);
    expect(() => patchResume('a', 'd1', { equipmentClosedOnce: true })).not.toThrow();
    expect(loadResume('a', 'd1')).toEqual(EMPTY_RESUME);
  });
});
