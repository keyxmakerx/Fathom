// The starter order types and the shared field sets they use, read from `corpus/orders/` as
// files (ADR-0084 decision 12): a Steward copies one and makes it their own. Nothing here is a
// live type until a Steward saves it.

import { setIdOf } from './orderModel';

const typeFiles = import.meta.glob('../../../../corpus/orders/*.yaml', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const setFiles = import.meta.glob('../../../../corpus/orders/field-sets/*.yaml', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

export interface Starter {
  id: string;
  name: string;
  /** Written from general practice and not yet checked against a real order (decision 12). */
  draft: boolean;
  source: string;
}

const line = (source: string, key: string): string | null => new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(source)?.[1] ?? null;

/** DIA first, then by name. */
export const STARTERS: readonly Starter[] = Object.values(typeFiles)
  .map((source) => ({
    id: line(source, 'id') ?? 'order-type',
    name: line(source, 'name') ?? 'Order type',
    draft: /^#.*\bDRAFT\b/m.test(source),
    source,
  }))
  .sort((a, b) => (a.id === 'dia' ? -1 : b.id === 'dia' ? 1 : a.name.localeCompare(b.name)));

/** Shared field sets that ship, by id. */
export const STARTER_SETS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(setFiles)
    .map((source) => [setIdOf(source), source] as const)
    .filter((e): e is readonly [string, string] => e[0] !== null),
);

/** A blank order type: one stage, one job, every key a Steward needs to see once. */
export const BLANK = `fathom: order-definition/1
id: my-order
name: My order type
number: ORD

fields:
  - { key: customer, label: Customer, kind: text, required: true }

stages:
  - id: first
    name: First stage
    jobs:
      - id: first-job
        name: The first job
        team: my-team
        steps: [Something to tick off]
`;
