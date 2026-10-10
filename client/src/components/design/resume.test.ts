import { describe, expect, it } from 'vitest';

import { EMPTY_RESUME, parseResume, resumeKey, viewShowsAny } from './resume';

describe('parseResume', () => {
  it('keeps what is valid', () => {
    const r = parseResume({ camera: { x: -10, y: 20, zoom: 1.5 }, tab: 'trail', equipmentOpen: true, selection: { kind: 'chassis', id: 'n1' } });
    expect(r).toEqual({ camera: { x: -10, y: 20, zoom: 1.5 }, tab: 'trail', equipmentOpen: true, selection: { kind: 'chassis', id: 'n1' } });
  });

  it('drops damaged parts one by one', () => {
    const r = parseResume({ camera: { x: 'a', y: 0, zoom: 1 }, tab: 'history', equipmentOpen: 'yes', selection: { kind: 'port', id: 'p' } });
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
