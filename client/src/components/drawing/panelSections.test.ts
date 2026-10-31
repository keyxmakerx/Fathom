import { describe, expect, it } from 'vitest';

import { DEFAULT_SECTIONS, moveSection, parseSectionPrefs, toggleSection } from './panelSections';

describe('device panel sections (sign-off r60)', () => {
  it('reads nothing or rubbish as the default order, all shown', () => {
    expect(parseSectionPrefs(null)).toEqual(DEFAULT_SECTIONS);
    expect(parseSectionPrefs('photo')).toEqual(DEFAULT_SECTIONS);
    expect(parseSectionPrefs({ order: 3, hidden: 'x' })).toEqual(DEFAULT_SECTIONS);
  });

  it('keeps a stored order, drops unknown ids and adds sections it did not know of at the end', () => {
    const p = parseSectionPrefs({ order: ['photo', 'nonsense', 'about', 'photo'], hidden: ['about', 'nope'] });
    expect(p.order).toEqual(['photo', 'about', 'connections', 'management', 'firmware']);
    expect(p.hidden).toEqual(['about']);
  });

  it('never hides Management, which the menus open by themselves', () => {
    expect(parseSectionPrefs({ order: [], hidden: ['management'] }).hidden).toEqual([]);
    expect(toggleSection(DEFAULT_SECTIONS, 'management')).toBe(DEFAULT_SECTIONS);
  });

  it('hides and shows again', () => {
    const hidden = toggleSection(DEFAULT_SECTIONS, 'photo');
    expect(hidden.hidden).toEqual(['photo']);
    expect(toggleSection(hidden, 'photo').hidden).toEqual([]);
  });

  it('moves one place, and not past either end', () => {
    expect(moveSection(DEFAULT_SECTIONS, 'firmware', -1).order).toEqual(['connections', 'firmware', 'management', 'about', 'photo']);
    expect(moveSection(DEFAULT_SECTIONS, 'connections', -1)).toBe(DEFAULT_SECTIONS);
    expect(moveSection(DEFAULT_SECTIONS, 'photo', 1)).toBe(DEFAULT_SECTIONS);
  });
});
