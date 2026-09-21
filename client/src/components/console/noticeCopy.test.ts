// `one_operator <live> <weeks>` said in words, with the case a fresh install
// actually produces.
//
// ADR-0055 decision 4's banner is derived from
// `operators::live_independent_operators`, which counts an operator only once
// their own sign-in has stood for the independence window -- so a freshly
// installed deployment answers **zero** while a person is sitting in front of
// the console signed in as its only operator. A banner that read that number
// out as "0 live operators" would be false to the person reading it, which is
// why this sentence is a tested one.

import { describe, expect, it } from 'vitest';

import { countSentence } from './NoticesBanner';

describe('countSentence (operators.rs one_operator)', () => {
  it('does not claim there is no operator when the count is zero', () => {
    const zero = countSentence(0);
    expect(zero).toMatch(/counts as independent yet/);
    expect(zero).not.toMatch(/0 /);
    expect(zero).toMatch(/first operator does not count on their first day/);
  });

  it('says one, and that there should be two', () => {
    expect(countSentence(1)).toBe('There is one independent operator on this install, and there should be two.');
  });

  it('pluralises anything else rather than saying "1 operators"', () => {
    expect(countSentence(3)).toBe('There are 3 independent operators on this install, and there should be two.');
  });
});
