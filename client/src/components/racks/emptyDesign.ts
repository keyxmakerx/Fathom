// The one Premises and one Rack an empty design gets, the first time a
// person places something in it — `RacksPlace.tsx`'s `onPlace`, never on
// load. `document/commands.ts` already has `createRack` (a Rack owned by a
// given Premises) but no `createPremises` — nothing in this session's own
// tree (`document/`) is ours to add one to, so this file builds the one
// Premises node the same way `createRack` builds a Rack node: existence via
// `assertHand`, one asserted field, one `Batch` naming the same ops that
// field's `set_field` would produce. `createRack` itself is then reused
// unchanged for the Rack.

import { createRack } from '../../document/commands';
import {
  LOCAL_ACTOR,
  assertHand,
  formatNodeId,
  requireFieldName,
  text,
  withBatch,
  withNode,
  type Batch,
  type Document,
  type Op,
} from '../../document/model';
import { newUlid } from '../../document/ulid';

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

/** A structural placeholder, not an asserted network fact — nobody has
 * named this premises yet, and "Premises" says so plainly rather than
 * guessing a site name. */
const DEFAULT_PREMISES_LABEL = 'Premises';

export interface CreatePremisesResult {
  doc: Document;
  premisesId: string;
}

/** A new, empty `Premises` node — the same shape `createRack`'s own Rack
 * node construction produces, one field and one existence assertion. */
export function createPremises(doc: Document, opts?: Actor): CreatePremisesResult {
  const { actor, now } = resolve(opts);
  const key = requireFieldName('Premises.label');

  const existence = assertHand(doc, { assertedAt: now, assertedBy: actor });
  let working = existence.doc;
  const premisesId = formatNodeId('Premises', newUlid(now));

  const labelProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = labelProv.doc;
  working = withNode(working, {
    id: premisesId,
    existence: existence.id,
    fields: { [key]: { presence: 'set', prov: labelProv.id, value: text(DEFAULT_PREMISES_LABEL) } },
  });

  const ops: Op[] = [
    { type: 'add_node', node: premisesId, prov: existence.id },
    { type: 'set_field', element: premisesId, key, presence: 'set', prov: labelProv.id },
  ];
  const batch: Batch = { id: newUlid(now), label: 'create premises', ops };
  working = withBatch(working, batch);

  return { doc: working, premisesId };
}

export interface EnsuredRack {
  doc: Document;
  premisesId: string;
  rackId: string;
}

/** A structural placeholder rack size/name, not an asserted fact: 42U is
 * the ordinary full rack, and "Rack 1" names the first one nobody has
 * labelled yet — the same spirit as `DEFAULT_PREMISES_LABEL`. */
const DEFAULT_RACK_OPTIONS = { label: 'Rack 1', heightU: 42, unitNumbering: 'ascending' as const };

/**
 * A Rack to place the first thing into, minting whatever this document is
 * missing to hold it: a `Premises` if `premisesId` is `null` (this
 * document has none yet — `document/view.ts`'s `viewOf` returning
 * `premisesId: ''`), then always a fresh `Rack` under it via
 * `document/commands.ts`'s own `createRack`. The new rack's id is read
 * back from the node `createRack` actually added, not guessed from ulid
 * ordering.
 */
export function ensureRackToPlaceInto(doc: Document, premisesId: string | null, opts?: Actor): EnsuredRack {
  let working = doc;
  let resolvedPremisesId = premisesId;
  if (resolvedPremisesId === null) {
    const created = createPremises(working, opts);
    working = created.doc;
    resolvedPremisesId = created.premisesId;
  }

  const beforeIds = new Set(working.nodes.map((n) => n.id));
  const withRack = createRack(working, resolvedPremisesId, { ...DEFAULT_RACK_OPTIONS, ...opts });
  const newRack = withRack.nodes.find((n) => !beforeIds.has(n.id));
  if (!newRack) {
    throw new Error('createRack did not add a node');
  }

  return { doc: withRack, premisesId: resolvedPremisesId, rackId: newRack.id };
}
