// Which catalogue model a box typed by hand probably is. The guess reads what is already in the design: the device's
// notes and platform, its ports' names and notes, and the labels of the cables on them. A model named in that text
// wins; otherwise a vendor named there, or the vendor's own port naming (`Et49` is Arista's), with every typed port
// fitting the model. Nothing is written: the guess only opens the swap preview, and the person confirms the swap.

import type { CatalogueModel } from '../api/catalogue';
import { edgesIn, edgesOut, fieldValue, findNode, readChassisFields, readPhysicalPortFields, asString, type Document } from './model';
import { notesOf } from './notes';
import { planModelSwap, type SwapPlan } from './swapModel';

export interface ModelGuess {
  vendor: string;
  /** The vendor as people write it: `Arista`, not the catalogue's `arista`. */
  vendorName: string;
  model: string;
  /** Why, in plain words, strongest first. */
  why: string[];
  plan: SwapPlan;
}

/** Port names each vendor's own software gives, matched against the typed labels. */
const PORT_STYLES: { vendor: string; name: string; pattern: RegExp }[] = [
  { vendor: 'arista', name: 'Arista', pattern: /^(et|ethernet)\s?\d+(\/\d+)?$/i },
  { vendor: 'juniper', name: 'Juniper', pattern: /^(ge|xe|et|mge)-\d+\/\d+\/\d+$/i },
  { vendor: 'mikrotik', name: 'MikroTik', pattern: /^(ether|sfp-sfpplus|sfp|qsfpplus)\d+(-\d+)?$/i },
];

const nameOfVendor = (vendor: string): string =>
  PORT_STYLES.find((s) => s.vendor === vendor)?.name ?? vendor.replace(/^./, (c) => c.toUpperCase());

const compact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9+]/g, '');

/** A model's name as written, and without a vendor's order-code prefix (`DCS-`, `CCS-`). */
function namesOf(model: string): string[] {
  const full = compact(model);
  const bare = compact(model.replace(/^(DCS|CCS|WS|EX|SRX)-(?=\d)/i, ''));
  return [...new Set([full, bare].filter((n) => n.length >= 4))];
}

function textAbout(doc: Document, chassisId: string): { words: Set<string>; text: string; labels: string[] } {
  const parts: string[] = [];
  const deviceId = edgesIn(doc, chassisId, 'HasChassis')[0]?.from;
  if (deviceId !== undefined) {
    const device = findNode(doc, deviceId);
    if (device) parts.push(asString(fieldValue(device.fields, 'Device.platform')) ?? '');
    for (const note of notesOf(doc, deviceId)) parts.push(note.text);
  }
  const labels: string[] = [];
  for (const e of edgesOut(doc, chassisId, 'HasPort')) {
    const node = findNode(doc, e.to);
    if (!node || node.absentSince !== undefined) continue;
    const f = readPhysicalPortFields(node);
    if (f.label) labels.push(f.label);
    parts.push(asString(fieldValue(node.fields, 'PhysicalPort.notes')) ?? '');
    for (const t of edgesIn(doc, e.to, 'Terminates')) {
      const cable = findNode(doc, t.from);
      if (cable && cable.absentSince === undefined) parts.push(asString(fieldValue(cable.fields, 'Cable.label')) ?? '');
    }
  }
  const text = parts.join('\n');
  return { words: new Set(text.split(/[\s,;:()[\]"'/]+/).map(compact).filter(Boolean)), text, labels };
}

/**
 * The most likely catalogue model for the hand-typed chassis `chassisId`, or null when it already has one or nothing
 * points clearly at one model. A model named in the device's own text is enough; a vendor hint alone needs every
 * typed port to carry over and one model to fit better than the rest.
 */
export function guessModel(doc: Document, chassisId: string, catalogue: readonly CatalogueModel[]): ModelGuess | null {
  const node = findNode(doc, chassisId);
  if (!node || node.absentSince !== undefined || readChassisFields(node).model !== undefined) return null;
  const { words, text, labels } = textAbout(doc, chassisId);
  if (labels.length === 0 && words.size === 0) return null;

  const styled = PORT_STYLES.filter((s) => labels.length > 0 && labels.filter((l) => s.pattern.test(l.trim())).length * 2 >= labels.length);
  const scored = catalogue.flatMap((m) => {
    let plan: SwapPlan;
    try {
      plan = planModelSwap(doc, chassisId, m, catalogue);
    } catch {
      return [];
    }
    const named = namesOf(m.model).some((n) => words.has(n));
    const vendorWord = new RegExp(`\\b${m.vendor}\\b`, 'i').test(text);
    const style = styled.find((s) => s.vendor === m.vendor);
    const cabledLost = plan.dropped.filter((d) => d.cableId !== null).length;
    const ports = plan.kept.length + plan.dropped.length;
    const why: string[] = [];
    if (named) why.push(`Its notes name the ${m.model}.`);
    if (!named && vendorWord) why.push(`Its notes or cable labels say ${nameOfVendor(m.vendor)}.`);
    if (style) why.push(`Port names like ${labels.find((l) => style.pattern.test(l.trim()))} are how ${style.name} names its ports.`);
    if (ports > 0) why.push(plan.dropped.length === 0 ? `All ${ports} typed ports carry over, with their cables.` : `${plan.kept.length} of ${ports} typed ports carry over.`);
    const score = (named ? 100 : 0) + (vendorWord ? 20 : 0) + (style ? 20 : 0) + (ports > 0 ? (10 * plan.kept.length) / ports : 0) - 30 * cabledLost;
    return [{ guess: { vendor: m.vendor, vendorName: nameOfVendor(m.vendor), model: m.model, why, plan }, named, hinted: vendorWord || style !== undefined, whole: plan.dropped.length === 0, score }];
  });
  scored.sort((a, z) => z.score - a.score);
  const [best, next] = scored;
  if (!best) return null;
  if (best.named) return next?.named && next.score === best.score ? null : best.guess;
  if (!best.hinted || !best.whole || (next && next.score === best.score)) return null;
  return best.guess;
}
