import { afterEach, describe, expect, it } from 'vitest';

import { forgetSelfMarks, rememberSelfMark, selfMark } from './selfMark';

afterEach(forgetSelfMarks);

describe('selfMark', () => {
  it('has nothing until the canvas has heard the server', () => {
    expect(selfMark('owner@example.test')).toBeNull();
  });
  it('gives Home the letters the canvas shows for the same address', () => {
    rememberSelfMark('owner@example.test', 'OF');
    expect(selfMark('owner@example.test')).toBe('OF');
    expect(selfMark('other@example.test')).toBeNull();
  });
  it('ignores an empty mark', () => {
    rememberSelfMark('owner@example.test', '');
    expect(selfMark('owner@example.test')).toBeNull();
  });
});
