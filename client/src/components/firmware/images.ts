// The Firmware list (mockup r14-b1): one row per image. A row says which models the image is for,
// how many devices of those models run its version, how many are behind the chosen version, and how
// many plans are about it. Pure. A version typed into a model's page with no image behind it
// (firmware off, or not uploaded yet) is a row too, so the list never hides a choice.

import type { FirmwareImage } from '../../api/firmware';
import { listPlans, touchedBy } from '../../document/plans';
import { listTargets, modelRows, type FwModelRow, type FwTarget } from '../../document/firmware';
import { versionOlder } from '../../document/firmwareVersion';
import type { Document } from '../../document/model';
import { quoteValue } from '../inventory/query';
import { parseUpgradeTitle } from './upgradePlan';

export type Vendor = 'juniper' | 'cisco' | 'arista';
export const VENDOR_TABS: ReadonlyArray<{ key: Vendor | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'juniper', label: 'Juniper' },
  { key: 'cisco', label: 'Cisco' },
  { key: 'arista', label: 'Arista' },
];

export function vendorOf(platform: string): Vendor | null {
  if (platform.startsWith('junos')) return 'juniper';
  if (platform === 'ios-xe' || platform === 'nx-os') return 'cisco';
  if (platform === 'eos') return 'arista';
  return null;
}

export type Badge = 'chosen' | 'older' | 'staged';
export const BADGE_WORD: Readonly<Record<Badge, string>> = { chosen: 'Chosen', older: 'Older', staged: 'Staged' };

export interface FwImageRow {
  key: string;
  /** Null for a typed version with no image. */
  image: FirmwareImage | null;
  version: string;
  platform: string;
  vendor: Vendor | null;
  models: string[];
  /** The models whose chosen version is this one. */
  chosenModels: string[];
  sha256: string;
  filename: string;
  running: number;
  /** Null when the image is not the chosen one: nothing is behind it. */
  behind: number | null;
  plans: number;
  badge: Badge;
  /** The devices and plans behind each number, for the lists they open. */
  runningDevices: string[];
  behindDevices: string[];
  planIds: string[];
}

export const rowKeyOfImage = (imageId: string): string => `img:${imageId}`;
export const rowKeyOfVersion = (version: string): string => `ver:${version}`;

/** The models an image is for: what the server says; only when it says none, those whose chosen version names it. */
export function modelsOfImage(img: FirmwareImage, targets: readonly FwTarget[]): string[] {
  if (img.models.length > 0) return [...img.models];
  const out: string[] = [];
  for (const t of targets) if (t.image === img.imageId && !out.includes(t.model)) out.push(t.model);
  return out;
}

/** Whether `target` chose this image, by id or by typing its version. */
export function choosesImage(target: FwTarget, img: FirmwareImage, models: readonly string[]): boolean {
  if (target.image !== '') return target.image === img.imageId;
  return models.includes(target.model) && img.version !== null && target.version === img.version;
}

interface Input {
  doc: Document;
  images: readonly FirmwareImage[];
}

export function imageRows({ doc, images }: Input): FwImageRow[] {
  const targets = listTargets(doc);
  const byModel = new Map<string, FwModelRow>(modelRows(doc).map((r) => [r.model, r]));
  const plans = listPlans(doc).filter((p) => p.stage !== 'recorded');
  const staged = images.filter((i) => i.state === 'staged');
  const stagedIds = new Set(staged.map((i) => i.imageId));

  const build = (key: string, image: FirmwareImage | null, version: string, models: string[], chosenBy: FwTarget[], sha256: string, filename: string, platformHint: string): FwImageRow => {
    const lines = models.flatMap((m) => byModel.get(m)?.devices ?? []);
    const unique = <T extends { device: { deviceId: string } }>(xs: T[]): T[] => [...new Map(xs.map((x) => [x.device.deviceId, x])).values()];
    const devices = unique(lines);
    const runningDevices = version === '' ? [] : devices.filter((l) => l.device.osVersion === version).map((l) => l.device.deviceId);
    const chosenModels = new Set(chosenBy.map((t) => t.model));
    const behindDevices = chosenModels.size === 0 ? [] : unique(models.filter((m) => chosenModels.has(m)).flatMap((m) => byModel.get(m)?.devices ?? [])).filter((l) => l.state === 'behind').map((l) => l.device.deviceId);
    const platform = image?.platform || chosenBy[0]?.platform || platformHint || devices[0]?.device.platform || '';
    let badge: Badge = 'staged';
    if (chosenBy.length > 0) badge = 'chosen';
    else if (version !== '' && models.some((m) => {
      const t = targets.find((x) => x.model === m);
      return t !== undefined && versionOlder(platform, version, t.version) === true;
    })) badge = 'older';
    const mine = new Set(devices.map((l) => l.device.deviceId));
    const planIds = version === '' ? [] : plans.filter((p) => parseUpgradeTitle(p.title)?.version === version && touchedBy(p).some((id) => mine.has(id))).map((p) => p.id);
    return {
      key,
      image,
      version,
      platform,
      vendor: vendorOf(platform),
      models,
      chosenModels: [...chosenModels],
      sha256,
      filename,
      running: runningDevices.length,
      behind: chosenBy.length > 0 ? behindDevices.length : null,
      plans: planIds.length,
      badge,
      runningDevices,
      behindDevices,
      planIds,
    };
  };

  const rows: FwImageRow[] = staged.map((img) => {
    const models = modelsOfImage(img, targets);
    const chosenBy = targets.filter((t) => choosesImage(t, img, models));
    const version = img.version ?? chosenBy[0]?.version ?? '';
    return build(rowKeyOfImage(img.imageId), img, version, models, chosenBy, img.sha256 ?? '', img.filename, '');
  });

  // A chosen version with no staged image under it: one row per version typed.
  const typed = targets.filter((t) => !stagedIds.has(t.image) && !rows.some((r) => r.image !== null && r.image.version === t.version && r.models.includes(t.model)));
  const byVersion = new Map<string, FwTarget[]>();
  for (const t of typed) byVersion.set(t.version, [...(byVersion.get(t.version) ?? []), t]);
  for (const [version, ts] of byVersion) {
    rows.push(build(rowKeyOfVersion(version), null, version, ts.map((t) => t.model), ts, ts[0]?.imageSha256 ?? '', '', ts[0]?.platform ?? ''));
  }

  return rows.sort((a, b) => (a.models[0] ?? '~').localeCompare(b.models[0] ?? '~') || Number(b.badge === 'chosen') - Number(a.badge === 'chosen') || b.version.localeCompare(a.version));
}

/** For the footer: each model with devices behind its chosen version. */
export function behindByModel(doc: Document): Array<{ model: string; deviceIds: string[] }> {
  return modelRows(doc)
    .filter((r) => r.behind > 0)
    .map((r) => ({ model: r.model, deviceIds: r.devices.filter((l) => l.state === 'behind').map((l) => l.device.deviceId) }));
}

/** "Juniper · Junos", for a page's sub-title. */
export function platformWords(platform: string): string {
  if (platform.startsWith('junos')) return 'Juniper · Junos';
  if (platform === 'ios-xe') return 'Cisco · IOS XE';
  if (platform === 'nx-os') return 'Cisco · NX-OS';
  if (platform === 'eos') return 'Arista · EOS';
  return '';
}

/** Rows a filter box and a vendor tab leave: the box looks at version, models, file name and hash. */
export function filterImageRows(rows: readonly FwImageRow[], text: string, vendor: Vendor | 'all'): FwImageRow[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (vendor !== 'all' && r.vendor !== vendor) return false;
    const hay = [r.version, r.models.join(' '), r.filename, r.sha256, r.platform, BADGE_WORD[r.badge]].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const modelClause = (models: readonly string[]): string =>
  models.length === 1 ? `model:${quoteValue(models[0]!)}` : `(${models.map((m) => `model:${quoteValue(m)}`).join(' | ')})`;

/** The Devices filter behind a row's Running number. */
export const runningQuery = (r: Pick<FwImageRow, 'models' | 'version'>): string => `${modelClause(r.models)} version:${quoteValue(r.version)}`;

/** The Devices filter behind a row's Behind number. */
export const behindQuery = (r: Pick<FwImageRow, 'chosenModels'>): string => `${modelClause(r.chosenModels)} firmware:Behind`;
