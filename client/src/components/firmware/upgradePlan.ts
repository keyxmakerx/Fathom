// "Upgrade as a plan": the maintenance plan for one or more devices of a model, six steps in plain
// words (mockup r14-b3), or for a device with its own chosen version (schema 0.31), the written steps
// for its vendor (kits.ts). Every upgrade ends on "Record <version> as running", which is how a plan
// is known as a firmware plan whatever it is called, and how one plan holds several upgrades. Each step is a title and, after a line break, a muted second line; the
// vendor's exact commands come from the server's commands for the image and sit in the step's detail
// (`after`), not as extra steps. Pure. The one-time link is never in the plan: it lasts 15 minutes,
// so the fetch step shows a placeholder and the plan panel issues the link on the day.

import { shortHash, type FirmwareCommands, type FirmwareImage } from '../../api/firmware';
import type { FwDevice, FwTarget } from '../../document/firmware';
import { FIRMWARE_PLATFORMS } from '../../document/firmwareVersion';
import type { Plan, PlanStep } from '../../document/plans';
import { KITS, kitFor, type KitId } from './kits';

export interface UpgradeStep {
  kind: 'other';
  /** Title, then (after a line break) the muted line. */
  change: string;
  /** The vendor commands for this step, one per line, or undefined. */
  after?: string;
}

export interface UpgradeTemplate {
  deviceIds: string[];
  title: string;
  steps: UpgradeStep[];
  /** Add the steps to this plan, still being planned, instead of making a new one. */
  intoPlan?: string;
}

export const LINK_PLACEHOLDER = '<one-time link>';

/** The step whose command takes the link. */
export const FETCH_STEP_TITLE = 'Fetch the image from Fathom';

/** `Upgrade EX2300 to 23.4R2`: how a new firmware plan is named. A person may rename it. */
export const upgradeTitle = (label: string, version: string): string => `Upgrade ${label} to ${version}`;
/** Plans made before the record step named the version were known by their title alone. */
export function parseUpgradeTitle(title: string): { model: string; version: string } | null {
  const m = /^Upgrade (.+) to (\S+)$/.exec(title);
  return m ? { model: m[1]!, version: m[2]! } : null;
}

/** The last step of every upgrade. */
export const recordStepTitle = (version: string): string => `Record ${version} as running`;

/** A step's title without the `label · ` an added upgrade carries. */
export function stepTitle(change: string): string {
  const first = change.split('\n')[0] ?? '';
  const i = first.indexOf(' · ');
  return i < 0 ? first : first.slice(i + 3);
}

/** The steps of an upgrade added to a plan that already has steps start with what they are for. */
export function labelled(template: UpgradeTemplate, label: string): UpgradeTemplate {
  return { ...template, steps: template.steps.map((s) => ({ ...s, change: `${label} · ${s.change}` })) };
}

export interface UpgradeGroup {
  version: string;
  deviceIds: string[];
  /** The step the one-time link is for, when the image comes from Fathom. */
  fetchStep: PlanStep | null;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** The upgrades a plan holds, one per record step; an older plan is known by its title. Empty for any other plan. */
export function upgradeGroups(plan: Plan): UpgradeGroup[] {
  const fetches = plan.steps.filter((s) => stepTitle(s.change) === FETCH_STEP_TITLE);
  const groups: UpgradeGroup[] = [];
  for (const s of plan.steps) {
    const m = /^Record (\S+) as running$/.exec(stepTitle(s.change));
    if (m) groups.push({ version: m[1]!, deviceIds: s.targets, fetchStep: fetches.find((f) => sameSet(f.targets, s.targets)) ?? null });
  }
  if (groups.length > 0) return groups;
  const old = parseUpgradeTitle(plan.title);
  if (old === null) return [];
  return [{ version: old.version, deviceIds: [...new Set(plan.steps.flatMap((s) => s.targets))], fetchStep: fetches[0] ?? null }];
}

/**
 * Whether the server's commands are for this device's platform. The server writes them per platform
 * (junos, ios-xe, nx-os, eos); an image with no platform is Junos there too. Nothing is made up here
 * for a platform the server has no steps for.
 */
export function commandsFit(image: FirmwareImage | null, platform: string): boolean {
  if (image === null || image.commands === null || image.commands.steps.length === 0) return false;
  return image.platform !== null ? image.platform === platform : platform.startsWith('junos');
}

type Bucket = 1 | 2 | 3 | 4 | 5 | 6;
const NONE: Record<Bucket, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

/** Which of the six steps a server command belongs under, by the server's own step titles. */
function bucketOf(step: string, command: string): Bucket {
  const s = `${step} ${command}`.toLowerCase();
  if (s.includes('fetch url') || /\bfile copy\b/.test(s) || /pull/.test(s)) return 3;
  // By title only: "make room" on IOS XE runs `install remove inactive`, which is not the install.
  if (/second snapshot|install|point the switch|reload/.test(step.toLowerCase()) || /software add/.test(command)) return 5;
  if (/check after it comes back/.test(step.toLowerCase())) return 6;
  if (/checksum|validate|prove|signed it|against this switch|compare with the hash/.test(s)) return 4;
  if (/snapshot|rescue|save the configuration/.test(s)) return 1;
  if (/storage|space|room|cleanup/.test(s)) return 2;
  return 5;
}

/** "sha512" as "SHA-512". */
const algorithmWords = (a: string): string => a.replace(/^sha(\d+)$/i, 'SHA-$1').toUpperCase();

/** Whose download page publishes the hash a device's non-SHA-256 output is compared with. */
const publisher = (family: string): string => (family === 'ios-xe' || family === 'nx-os' ? "Cisco's" : family === 'eos' ? "Arista's" : "the vendor's");

/** The commands under each step, with the link left as a placeholder. */
export function detailsFrom(c: FirmwareCommands | null): Record<Bucket, string[]> {
  const out: Record<Bucket, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const s of c?.steps ?? []) {
    const command = s.command.replace(/<the fetch URL[^>]*>/, LINK_PLACEHOLDER);
    out[bucketOf(s.step, s.command)].push(command);
  }
  return out;
}

export interface UpgradeInput {
  /** The devices to take to the chosen version: all of one model, or the one device. */
  devices: readonly FwDevice[];
  /** What the plan names: the model, or the device for its own chosen version. */
  label: string;
  version: string;
  /** The model's target; null for a device's own chosen version. */
  target: FwTarget | null;
  /** The image the target names, when the server lists it. */
  image: FirmwareImage | null;
  /** Written steps to use when Fathom has no image; left out, the platform suggests them. */
  kit?: KitId;
}

const isImagePlatform = (p: string): boolean => FIRMWARE_PLATFORMS.some((x) => x.id === p);

export function buildUpgradePlan({ devices, label, version, target, image, kit }: UpgradeInput): UpgradeTemplate {
  const platform = devices[0]?.platform || target?.platform || '';
  const staged = image !== null && image.state === 'staged' && image.sha256 !== null;
  const deviceIds = devices.map((x) => x.deviceId);
  const title = upgradeTitle(label, version);
  const record = (muted: string): UpgradeStep => ({ kind: 'other', change: `${recordStepTitle(version)}\n${muted}` });

  // No image from Fathom: the vendor's own update, as written steps.
  const useKit = !staged && (kit !== undefined || !isImagePlatform(platform));
  if (useKit) {
    const k = KITS[kit ?? kitFor(platform)];
    return {
      deviceIds,
      title,
      steps: [
        ...k.steps.map((s): UpgradeStep => ({ kind: 'other', change: `${s.title}\n${s.muted}`, ...(s.after !== undefined ? { after: s.after } : {}) })),
        record('Type it as Running on the device page, or paste the config. "Behind" clears on its own.'),
      ],
    };
  }

  const hash = staged ? (image.sha256 ?? '') : (target?.imageSha256 ?? '');
  const fits = staged && commandsFit(image, platform);
  const commands = fits ? (image?.commands ?? null) : null;
  const d = commands ? detailsFrom(commands) : NONE;
  const lines = (b: Bucket): string | undefined => (d[b].length > 0 ? d[b].join('\n') : undefined);
  const step = (title: string, muted: string, b: Bucket): UpgradeStep => {
    const after = lines(b);
    return { kind: 'other', change: `${title}\n${muted}`, ...(after !== undefined ? { after } : {}) };
  };
  // Step 4 follows what the device can compute: Fathom's SHA-256 is only comparable with a SHA-256.
  const algorithm = commands?.deviceHash.algorithm ?? 'sha256';
  const hashStep =
    commands && algorithm !== 'sha256'
      ? step(`Check the ${algorithmWords(algorithm)} on the device`, `Compare with the ${algorithmWords(algorithm)} on ${publisher(commands.family)} download page.`, 4)
      : step('Check the SHA-256 on the device', hash ? `Compare with ${shortHash(hash)}.` : "Compare with the vendor's published value.", 4);
  const noSteps = staged && image.commands !== null && image.commands.steps.length === 0;
  const fetchMuted = !staged
    ? 'Stage the image in Fathom first (Inventory, Firmware, Upload image).'
    : noSteps
      ? 'No steps are written for this platform yet.'
      : 'The device pulls it with the one-time link below.';
  const last = lines(6);
  return {
    deviceIds,
    title,
    steps: [
      step('Back up the running config', 'Paste it into Fathom; the redaction gate runs first.', 1),
      step('Check free space on the device', 'Clear old images if it is short.', 2),
      step(FETCH_STEP_TITLE, fetchMuted, 3),
      hashStep,
      step('Install and reboot', 'Inside the window.', 5),
      { ...record('Paste the config back; Checks clears "behind" on its own.'), ...(last !== undefined ? { after: last } : {}) },
    ],
  };
}

/** The command a step's Copy button copies: its detail, with the link put in where the placeholder is. */
export function commandWithLink(detail: string, url: string): string {
  return detail.split(LINK_PLACEHOLDER).join(url);
}

/** A link with everything after the path hidden: `https://host/fw/fetch/••••••••`. */
export function maskedLink(url: string): string {
  const i = url.lastIndexOf('/');
  return i < 0 ? '••••••••' : `${url.slice(0, i + 1)}••••••••••••`;
}
