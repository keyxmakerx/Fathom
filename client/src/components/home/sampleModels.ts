import { fetchCatalogue, fetchModel, type CatalogueModel } from '../../api/catalogue';
import { modelKey } from './sampleNetwork';

/** The sample Home offers (r15-start); its file is `corpus/samples/home-lab.json`. */
export const HOME_SAMPLE = 'home-lab';

/** The catalogue models a sample names, each fetched once; one the catalogue does not hold is left out, and the
 * sample draws that device as a sketch. Never a refusal: the sample opens whatever the catalogue answers. */
export async function modelsFor(names: readonly { vendor: string; model: string }[]): Promise<Map<string, CatalogueModel>> {
  const list = await fetchCatalogue().catch(() => []);
  const held = list.filter((e) => names.some((n) => modelKey(n.vendor, n.model) === modelKey(e.vendor, e.model)));
  const models = await Promise.all(held.map((e) => fetchModel(e.vendor, e.model).catch(() => null)));
  return new Map(models.filter((m): m is CatalogueModel => m !== null).map((m) => [modelKey(m.vendor, m.model), m]));
}
