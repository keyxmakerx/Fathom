import type { PortKind } from '../ports';

/**
 * `PortView.connector` (the contract, `./contract.ts`) is free text from the
 * catalogue, not the glyph enum `components/ports` draws — this is the one
 * place that turns one into the other. An unrecognised string resolves to
 * `null` rather than guessing a glyph: UI-SPEC "Absent is drawn as absent."
 */
const ALIASES: Record<string, PortKind> = {
  rj45: 'rj45',
  cat5e: 'rj45',
  cat6: 'rj45',
  cat6a: 'rj45',
  sfp: 'sfp-plus',
  'sfp+': 'sfp-plus',
  'sfp-plus': 'sfp-plus',
  sfpplus: 'sfp-plus',
  // `schema/schema.yaml`'s actual `PhysicalPort.connector` spellings
  // (`document/compat.ts`'s own file header) — SFP+, SFP28 and QSFP28 all
  // read as the SFP+/QSFP+ cage glyph: UI-SPEC "Ports" draws five glyphs,
  // never eleven, and ADR-0047 §5 reads every one of these as a DAC this
  // session (no distinct optic glyph yet).
  sfp_plus: 'sfp-plus',
  sfp28: 'sfp-plus',
  qsfp: 'qsfp-plus',
  'qsfp+': 'qsfp-plus',
  'qsfp-plus': 'qsfp-plus',
  qsfpplus: 'qsfp-plus',
  qsfp28: 'qsfp-plus',
  lc: 'lc',
  fibre: 'lc',
  fiber: 'lc',
  c14: 'c14',
  // `C13` is its own `PortKind` in the catalogue (`fathom_corpus::catalogue`
  // — a PDU's outlet, not a device's inlet: the two ends of one cord). The
  // client draws five glyphs, not six (UI-SPEC "Ports"), so a C13 outlet
  // shares the C14 glyph here, mirrored, rather than gaining a sixth shape —
  // a drawing-layer stopgap, not a claim that the two connectors are the
  // same piece of metal.
  c13: 'c14',
  iec: 'c14',
  iec60320: 'c14',
  power: 'c14',
};

export function portKindFor(connector: string): PortKind | null {
  const key = connector.trim().toLowerCase();
  return ALIASES[key] ?? null;
}
