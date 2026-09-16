// The palette's rows, built from the catalogue — never typed. Each item's
// summary is counted off that model's own faceplates, so it changes the
// moment the catalogue entry does, rather than a hand-written description
// drifting out of sync with it.

import type { CatalogueModel } from '../../api/catalogue';
import type { PaletteItem } from '../drawing';

/** Every port across every one of a model's faceplates, totalled by the
 * catalogue's own connector token (`"RJ45"`, `"SFP+"`, ...) and joined in
 * the order those tokens were first seen — deterministic, never sorted
 * into an order the catalogue itself does not carry. */
function summarise(model: CatalogueModel): string {
  const counts = new Map<string, number>();
  for (const faceplate of model.faceplates) {
    for (const port of faceplate.ports) {
      counts.set(port.kind, (counts.get(port.kind) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return 'No ports listed';
  return Array.from(counts.entries())
    .map(([kind, count]) => `${count} ${kind}`)
    .join(' · ');
}

export function paletteFromCatalogue(catalogue: readonly CatalogueModel[]): PaletteItem[] {
  return catalogue.map((model) => ({
    vendor: model.vendor,
    model: model.model,
    rackUnits: model.rackUnits,
    summary: summarise(model),
  }));
}
