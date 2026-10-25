import { describe, expect, it } from 'vitest';

import { removeChassis } from '../../document/commands';
import { buildSample, sample } from './sampleNetwork';
import { readyQuestions } from './sampleQuestions';

describe('readyQuestions', () => {
  const built = buildSample(sample('home-lab'), new Map());

  it('offers the sample its own questions, starting from the named devices', () => {
    const qs = readyQuestions(built.doc);
    expect(qs.map((q) => q.ask)).toEqual(['Can a camera reach the NAS?', 'Can the desktop reach the NAS?', 'Can the desktop see a camera?']);
    expect(qs[0]).toMatchObject({ to: '192.168.10.10', flow: 'TCP 445' });
  });

  it('drops a question whose starting device is gone', () => {
    const doc = removeChassis(built.doc, readyQuestions(built.doc)[0]!.chassisId);
    expect(readyQuestions(doc).map((q) => q.ask)).not.toContain('Can a camera reach the NAS?');
  });
});
