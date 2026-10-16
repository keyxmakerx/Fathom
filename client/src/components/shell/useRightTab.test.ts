import { describe, expect, it } from 'vitest';

import { decideAutoEquipment, rememberedTab, visibleTab } from './useRightTab';

const have = { hasDetails: true, historyOpen: false, trailOpen: false, hasTrail: true };

describe('visibleTab', () => {
  it('shows the chosen tab only when something is behind it', () => {
    expect(visibleTab('details', have)).toBe('details');
    expect(visibleTab('details', { ...have, hasDetails: false })).toBeNull();
    expect(visibleTab('history', have)).toBeNull();
    expect(visibleTab('history', { ...have, historyOpen: true })).toBe('history');
    expect(visibleTab('trail', { ...have, trailOpen: true })).toBe('trail');
    expect(visibleTab('trail', { ...have, trailOpen: true, hasTrail: false })).toBeNull();
    expect(visibleTab(null, have)).toBeNull();
  });
});

describe('the Equipment tab', () => {
  it('is shown when chosen and the list exists, and only then', () => {
    expect(visibleTab('equipment', { ...have, hasEquipment: true })).toBe('equipment');
    expect(visibleTab('equipment', have)).toBeNull();
  });
  it('is a place to return to by the Equipment flag, not by the tab memory', () => {
    expect(rememberedTab('equipment')).toBeNull();
  });
});

describe('rememberedTab', () => {
  it('does not bring History back, since it is a mode', () => {
    expect(rememberedTab('history')).toBeNull();
    expect(rememberedTab('trail')).toBe('trail');
    expect(rememberedTab('details')).toBe('details');
  });
});

describe('Equipment opening by itself on an empty design (ADR-0065 §3)', () => {
  it('waits while the design has not loaded', () => {
    expect(decideAutoEquipment(false, undefined, null)).toEqual({ decided: false, open: false });
  });
  it('opens once, on the first answer, when the design is empty and nothing else is open', () => {
    expect(decideAutoEquipment(false, true, null)).toEqual({ decided: true, open: true });
  });
  it('does not open on a design that has devices, and does not ask again later', () => {
    expect(decideAutoEquipment(false, false, null)).toEqual({ decided: true, open: false });
  });
  it('leaves a person who closed it alone: once decided it never opens again', () => {
    expect(decideAutoEquipment(true, true, null)).toEqual({ decided: true, open: false });
    expect(decideAutoEquipment(true, undefined, null)).toEqual({ decided: true, open: false });
  });
  it('does not displace a panel that is already open', () => {
    expect(decideAutoEquipment(false, true, 'details')).toEqual({ decided: true, open: false });
    expect(decideAutoEquipment(false, true, 'trail')).toEqual({ decided: true, open: false });
  });
  it('shows once chosen, only where the Equipment list exists (a reader has none)', () => {
    expect(visibleTab('equipment', { ...have, hasEquipment: false })).toBeNull();
  });
});
