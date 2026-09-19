// Whether a cable can join two `PhysicalPort.connector` tokens
// (`schema/schema.yaml`'s `PhysicalPort.connector` enum: `rj45, sfp,
// sfp_plus, sfp28, qsfp, qsfp28, lc, sc, mpo, f, bnc, c13, c14, nema515r,
// nema515p, other`) — and, when it can, the `Cable.media` a fresh cable
// between them defaults to.
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
//   nema515r <-> nema515p (either order)               power,  power
//   everything else is refused, naming what is missing.
//
// ADR-0051 §1 adds `nema515r`/`nema515p` (schema 0.8) beside `c13`/`c14`: the
// North American receptacle and plug a tower UPS and many PDUs carry (NEMA
// 5-15), paired as power the same way the IEC pair already is. Spelled
// without underscores before the digits — `nema_5_15r` fails
// `fathom-schemagen`'s token rule ("token `nema_5_15r` segment `5` must
// start a-z": every `_`-separated segment of a schema token becomes a
// `CamelCase` fragment, and a fragment cannot start with a digit) — so the
// schema and this file both carry `nema515r`/`nema515p`.

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
/** A connector as the table reads it: the schema token, whatever spelling
 * arrived — a catalogue kind (`"RJ45"`), a token with stray whitespace, or a
 * token in the wrong case. The document stores only schema tokens
 * (`connectorTokenOf` at placement), so this is tolerance at the boundary,
 * not a second vocabulary. */
function normaliseConnector(c: string): string {
  const mapped = connectorTokenOf(c.trim());
  if (mapped !== 'other') return mapped;
  const lower = c.trim().toLowerCase();
  return SCHEMA_CONNECTORS.has(lower) ? lower : connectorTokenOf(c.trim().toUpperCase());
}

/** `PhysicalPort.connector` (`schema/schema.yaml`), verbatim — exported so
 * `commands.ts`'s `addSketchPort` (ADR-0051 §1) validates a typed-by-hand
 * connector against the same one vocabulary this table itself reads. */
export const PORT_CONNECTOR_VALUES = [
  'rj45',
  'sfp',
  'sfp_plus',
  'sfp28',
  'qsfp',
  'qsfp28',
  'lc',
  'sc',
  'mpo',
  'f',
  'bnc',
  'c13',
  'c14',
  'nema515r',
  'nema515p',
  'other',
] as const;
export type PortConnector = (typeof PORT_CONNECTOR_VALUES)[number];

/** `PhysicalPort.service` (`schema/schema.yaml`), verbatim — the same reuse
 * reason `PORT_CONNECTOR_VALUES` above has. */
export const PORT_SERVICE_VALUES = ['ethernet', 'pon', 'rf', 'serial', 'console', 'management', 'power', 'other'] as const;
export type PortService = (typeof PORT_SERVICE_VALUES)[number];

const SCHEMA_CONNECTORS = new Set<string>(PORT_CONNECTOR_VALUES);

export function compatible(fromConnectorRaw: string, toConnectorRaw: string): CompatResult {
  const fromConnector = normaliseConnector(fromConnectorRaw);
  const toConnector = normaliseConnector(toConnectorRaw);
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
    (fromConnector === 'c13' && toConnector === 'c14') ||
    (fromConnector === 'c14' && toConnector === 'c13') ||
    (fromConnector === 'nema515r' && toConnector === 'nema515p') ||
    (fromConnector === 'nema515p' && toConnector === 'nema515r');
  if (isPowerPair) {
    return { ok: true, kind: 'power', media: 'power' };
  }
  return {
    ok: false,
    reason:
      `"${fromConnector}" does not pair with "${toConnector}" — the table has rj45-rj45, ` +
      'lc-lc, a matching pair from sfp/sfp_plus/sfp28/qsfp/qsfp28 (as a DAC), c13-c14, and nema515r-nema515p',
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
    case 'nema_5_15r':
      return 'nema515r';
    case 'nema_5_15p':
      return 'nema515p';
    default:
      return 'other';
  }
}
