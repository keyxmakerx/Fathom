// The whole shipped catalogue for the sample tests, read from corpus/catalogue/ the way the server lists it.
import type { CatalogueFaceplate, CatalogueModel, CataloguePort } from '../api/catalogue';

// The whole shipped catalogue, read from corpus/catalogue/ the way the server lists it: every model, with its port
// groups expanded to ports. Only what the sample builder reads is filled in; the Rust loader (fathom-corpus) is the
// one that checks these files, so a file it would refuse never reaches the server either.
export const catalogueFiles = import.meta.glob('../../../corpus/catalogue/*/*.yaml', { eager: true, query: '?raw', import: 'default' }) as Record<
  string,
  string
>;

function readModel(text: string): CatalogueModel {
  const field = (name: string): string => {
    const m = new RegExp(`^${name}: *(.+)$`, 'm').exec(text);
    if (!m) throw new Error(`catalogue file without ${name}`);
    return m[1].trim().replace(/^"(.*)"$/, '$1');
  };
  const faceplates: CatalogueFaceplate[] = [];
  for (const line of text.split('\n')) {
    const face = /^ {2}- face: (front|rear)/.exec(line);
    if (face) faceplates.push({ face: face[1] as 'front' | 'rear', portCount: 0, ports: [] });
    const group = /^ +- \{ *kind: "([^"]+)".*\}/.exec(line);
    if (!group || faceplates.length === 0) continue;
    const plate = faceplates[faceplates.length - 1];
    const port = (number: number | null, name: string | null): CataloguePort => ({
      kind: group[1],
      number,
      name,
      uplink: false,
      row: 'single',
      column: plate.ports.length,
      groupGapBefore: false,
    });
    const counted = /count: (\d+), start_number: (\d+)/.exec(line);
    const named = /names: \[([^\]]*)\]/.exec(line);
    if (counted) for (let i = 0; i < Number(counted[1]); i++) plate.ports.push(port(Number(counted[2]) + i, null));
    else if (named) for (const n of named[1].split(',')) plate.ports.push(port(null, n.trim().replace(/^"(.*)"$/, '$1')));
    else throw new Error(`a port group the test cannot read: ${line}`);
    plate.portCount = plate.ports.length;
  }
  return {
    vendor: field('vendor'),
    model: field('model'),
    rackUnits: Number(field('rack_units')),
    reviewedBy: field('reviewed_by'),
    source: { cite: '', readOn: '' },
    psuSlots: [],
    faceplates,
  };
}

export const CATALOGUE: CatalogueModel[] = Object.values(catalogueFiles).map(readModel);

