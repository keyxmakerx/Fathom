import { describe, expect, it } from 'vitest';

import { portKindFor } from './portGlyph';

describe('portKindFor', () => {
  it('maps the catalogue spellings actually seen in the corpus', () => {
    expect(portKindFor('rj45')).toBe('rj45');
    expect(portKindFor('SFP+')).toBe('sfp-plus');
    expect(portKindFor('QSFP+')).toBe('qsfp-plus');
    expect(portKindFor('LC')).toBe('lc');
    expect(portKindFor('C14')).toBe('c14');
  });

  it('is tolerant of surrounding whitespace and case', () => {
    expect(portKindFor('  Rj45 ')).toBe('rj45');
  });

  it('reads the schema\'s own connector spellings (schema.yaml\'s PhysicalPort.connector enum)', () => {
    expect(portKindFor('sfp_plus')).toBe('sfp-plus');
    expect(portKindFor('sfp28')).toBe('sfp-plus');
    expect(portKindFor('qsfp28')).toBe('qsfp-plus');
    expect(portKindFor('c13')).toBe('c14');
  });

  it('reads both the catalogue and schema spellings of the NEMA 5-15 pair (ADR-0051 §1)', () => {
    expect(portKindFor('nema_5_15r')).toBe('c14');
    expect(portKindFor('nema_5_15p')).toBe('c14');
    expect(portKindFor('nema515r')).toBe('c14');
    expect(portKindFor('nema515p')).toBe('c14');
  });

  it('draws nothing for a connector it does not recognise, rather than guessing', () => {
    expect(portKindFor('rs232')).toBeNull();
    expect(portKindFor('')).toBeNull();
  });

  it('draws SC with the LC glyph (docs/UI-SPEC.md "Owed to the boards")', () => {
    expect(portKindFor('sc')).toBe('lc');
  });

  it('every other schema.yaml PhysicalPort.connector value draws something, never vanishes', () => {
    expect(portKindFor('mpo')).toBe('generic');
    expect(portKindFor('f')).toBe('generic');
    expect(portKindFor('bnc')).toBe('generic');
    expect(portKindFor('other')).toBe('generic');
  });
});
