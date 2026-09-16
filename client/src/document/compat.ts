// Whether a cable can join two `PhysicalPort.connector` tokens
// (`schema/schema.yaml`'s `PhysicalPort.connector` enum: `rj45, sfp,
// sfp_plus, sfp28, qsfp, qsfp28, lc, sc, mpo, f, bnc, c13, c14, other`) — and,
// when it can, the `Cable.media` a fresh cable between them defaults to.
//
// This file did not exist when this session started (`cables.ts`'s brief:
// "`compat.ts` may or may not exist yet — the drawing builder owns it").
// Declared here with the signature and table the brief names, for the lead
// to reconcile against whatever the drawing side settles on.
//
// The table (brief, verbatim):
//   rj45  <-> rj45                                    copper, cat6
//   lc    <-> lc                                      fibre,  mmf
//   sfp/sfp_plus/sfp28/qsfp/qsfp28 <-> the SAME token  copper, twinax (a DAC)
//   c13   <-> c14 (either order)                       power,  power
//   everything else is refused, naming what is missing.

export type CableKind = 'copper' | 'fibre' | 'power';

/** `Cable.media`'s enum tokens (`schema/schema.yaml`), verbatim. */
export type CableMedia =
  | 'cat5e'
  | 'cat6'
  | 'cat6a'
  | 'twinax'
  | 'smf'
  | 'mmf'
  | 'coax'
  | 'power'
  | 'virtual'
  | 'other';

export type CompatResult =
  | { ok: true; kind: CableKind; media: CableMedia }
  | { ok: false; reason: string };

const DAC_CONNECTORS = new Set(['sfp', 'sfp_plus', 'sfp28', 'qsfp', 'qsfp28']);

/** `fromConnector`/`toConnector` are `PhysicalPort.connector` tokens — the
 * schema's own spelling (lower_snake_case), not a catalogue's raw `"RJ45"` /
 * `"SFP+"` (`commands.ts`'s doc on `token()` explains why those differ). */
export function compatible(fromConnector: string, toConnector: string): CompatResult {
  if (fromConnector === 'rj45' && toConnector === 'rj45') {
    return { ok: true, kind: 'copper', media: 'cat6' };
  }
  if (fromConnector === 'lc' && toConnector === 'lc') {
    return { ok: true, kind: 'fibre', media: 'mmf' };
  }
  if (fromConnector === toConnector && DAC_CONNECTORS.has(fromConnector)) {
    return { ok: true, kind: 'copper', media: 'twinax' };
  }
  const isPowerPair =
    (fromConnector === 'c13' && toConnector === 'c14') || (fromConnector === 'c14' && toConnector === 'c13');
  if (isPowerPair) {
    return { ok: true, kind: 'power', media: 'power' };
  }
  return {
    ok: false,
    reason:
      `"${fromConnector}" does not pair with "${toConnector}" — the table has rj45-rj45, ` +
      'lc-lc, a matching pair from sfp/sfp_plus/sfp28/qsfp/qsfp28 (as a DAC), and c13-c14',
  };
}

/**
 * The catalogue's port kinds (`crates/fathom-corpus/src/catalogue.rs`'s
 * `PortKind`: `"RJ45"`, `"SFP+"`, `"QSFP+"`, `"LC"`, `"C14"`) mapped onto the
 * schema's `PhysicalPort.connector` enum. `CLAUDE.md` rule 3: a value not in
 * the schema does not exist, so `"RJ45"` may never be written to a port —
 * `rj45` is the token. QSFP+ is the 40G generation, which the schema spells
 * `qsfp` (`qsfp28` is 100G); a kind this table does not know becomes `other`
 * rather than a spelling the schema would refuse. Found on 2026-09-16 when the
 * cable compatibility table, which speaks the schema's tokens, could not
 * match a single catalogue-sourced port.
 */
const SCHEMA_CONNECTORS = new Set(['rj45', 'sfp', 'sfp_plus', 'sfp28', 'qsfp', 'qsfp28', 'lc', 'sc', 'mpo', 'f', 'bnc', 'c13', 'c14', 'other']);

export function connectorTokenOf(catalogueKind: string): string {
  // Idempotent: a value already in the schema's spelling is itself, so the
  // view can map a stored token through this function without harm.
  if (SCHEMA_CONNECTORS.has(catalogueKind)) {
    return catalogueKind;
  }
  switch (catalogueKind) {
    case 'RJ45':
      return 'rj45';
    case 'SFP':
      return 'sfp';
    case 'SFP+':
      return 'sfp_plus';
    case 'SFP28':
      return 'sfp28';
    case 'QSFP+':
      return 'qsfp';
    case 'QSFP28':
      return 'qsfp28';
    case 'LC':
      return 'lc';
    case 'C13':
      return 'c13';
    case 'C14':
      return 'c14';
    default:
      return 'other';
  }
}
