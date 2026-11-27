import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ReadyQuestion } from '../home/sampleQuestions';
import { PracticeNote, ReadyQuestions } from './ReadyQuestions';

const q = { ask: 'Can a camera reach the NAS?', chassisId: 'a', to: 'b', flow: 'tcp' } as unknown as ReadyQuestion;

describe('Try a question card', () => {
  it('opens in full on the canvas', () => {
    const out = renderToStaticMarkup(createElement(ReadyQuestions, { questions: [q], onAsk: () => {} }));
    expect(out).toContain('Can a camera reach the NAS?');
    expect(out).not.toContain('trace-questions--folded');
  });
  it('is folded to its title row where it would cover the drawing (the Diagram look)', () => {
    const out = renderToStaticMarkup(createElement(ReadyQuestions, { questions: [q], onAsk: () => {}, folded: true }));
    expect(out).toContain('trace-questions--folded');
    expect(out).toContain('ready-questions-show');
    expect(out).not.toContain('Can a camera reach the NAS?');
  });
  it('is off the page while an open device or a trace has the canvas', () => {
    expect(renderToStaticMarkup(createElement(ReadyQuestions, { questions: [q], onAsk: () => {}, away: true }))).toBe('');
  });
});

describe('Practice note', () => {
  it('says how many mistakes are hidden, and is off the page while something else has the canvas', () => {
    expect(renderToStaticMarkup(createElement(PracticeNote, { count: 3, onOpenChecks: () => {} }))).toContain('3 mistakes are');
    expect(renderToStaticMarkup(createElement(PracticeNote, { count: 3, onOpenChecks: () => {}, away: true }))).toBe('');
  });
});
