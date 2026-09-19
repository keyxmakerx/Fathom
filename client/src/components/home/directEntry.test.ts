import { describe, expect, it } from 'vitest';

import type { DesignSummary } from '../../api/designs';
import type { Organisation } from '../../api/organisations';
import { pickDirectEntry } from './directEntry';

const ORG_A: Organisation = { organisationId: 'org-a', displayName: 'Northwind Logistics' };
const ORG_B: Organisation = { organisationId: 'org-b', displayName: 'Acme Dental' };

const DESIGN_1: DesignSummary = {
  designId: 'design-1',
  scopeId: 'scope-1',
  createdAtUnix: 1,
  createdBy: 'acct',
  capability: 'steward',
  latestVersion: 1,
};

const DESIGN_2: DesignSummary = {
  designId: 'design-2',
  scopeId: 'scope-2',
  createdAtUnix: 2,
  createdBy: 'acct',
  capability: 'read',
  latestVersion: 1,
};

describe('pickDirectEntry', () => {
  it('lands directly when there is exactly one organisation and exactly one design in it', () => {
    expect(pickDirectEntry([ORG_A], [DESIGN_1])).toEqual({ organisation: ORG_A, design: DESIGN_1 });
  });

  it('does not land directly with more than one organisation, even if each has one design', () => {
    expect(pickDirectEntry([ORG_A, ORG_B], [DESIGN_1])).toBeNull();
  });

  it('does not land directly with zero organisations', () => {
    expect(pickDirectEntry([], null)).toBeNull();
  });

  it('does not land directly when the sole organisation has zero designs', () => {
    expect(pickDirectEntry([ORG_A], [])).toBeNull();
  });

  it('does not land directly when the sole organisation has more than one design', () => {
    expect(pickDirectEntry([ORG_A], [DESIGN_1, DESIGN_2])).toBeNull();
  });

  it('does not land directly while the sole organisation\'s designs have not loaded yet', () => {
    expect(pickDirectEntry([ORG_A], null)).toBeNull();
  });
});
