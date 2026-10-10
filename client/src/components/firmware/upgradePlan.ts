// "Upgrade as a plan": the maintenance plan for one or more devices of a model, six steps in plain
// words (mockup r14-b3). Each step is a title and, after a line break, a muted second line; the
// vendor's exact commands come from the server's commands for the image and sit in the step's detail
// (`after`), not as extra steps. Pure. The one-time link is never in the plan: it lasts 15 minutes,
// so the fetch step shows a placeholder and the plan panel issues the link on the day.

import { shortHash, type FirmwareCommands, type FirmwareImage } from '../../api/firmware';
import type { FwDevice, FwTarget } from '../../document/firmware';

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
}

export const LINK_PLACEHOLDER = '<one-time link>';

/** The step whose command takes the link. */
export const FETCH_STEP_TITLE = 'Fetch the image from Fathom';

/** `Upgrade EX2300 to 23.4R2`: how a firmware plan is named, and how the panel knows one. */
export const upgradeTitle = (model: string, version: string): string => `Upgrade ${model} to ${version}`;
export function parseUpgradeTitle(title: string): { model: string; version: string } | null {
  const m = /^Upgrade (.+) to (\S+)$/.exec(title);
  return m ? { model: m[1]!, version: m[2]! } : null;
}

/** Whether the server's commands are for this platform: the Juniper ones are for Junos only. */
export function commandsFit(image: FirmwareImage | null, platform: string): boolean {
  if (image === null || image.commands === null || image.commands.steps.length === 0) return false;
  return image.platform !== null ? image.platform === platform : platform.startsWith('junos');
}

type Bucket = 1 | 2 | 3 | 4 | 5;

/** Which of the six steps a server command belongs under. */
function bucketOf(step: string, command: string): Bucket {
  const s = `${step} ${command}`.toLowerCase();
  if (s.includes('fetch url') || /\bfile copy\b/.test(s) || /pull/.test(s)) return 3;
  if (/second snapshot|software add|install/.test(s)) return 5;
  if (/checksum|validate|prove/.test(s)) return 4;
  if (/snapshot|rescue/.test(s)) return 1;
  if (/storage|space|room|cleanup/.test(s)) return 2;
  return 5;
}

/** The commands under each step, with the link left as a placeholder. */
export function detailsFrom(c: FirmwareCommands | null): Record<Bucket, string[]> {
  const out: Record<Bucket, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const s of c?.steps ?? []) {
    const command = s.command.replace(/<the fetch URL[^>]*>/, LINK_PLACEHOLDER);
    out[bucketOf(s.step, s.command)].push(command);
  }
  return out;
}

export interface UpgradeInput {
  /** The devices to take to the chosen version, all of one model. */
  devices: readonly FwDevice[];
  model: string;
  target: FwTarget;
  /** The image the target names, when the server lists it. */
  image: FirmwareImage | null;
}

export function buildUpgradePlan({ devices, model, target, image }: UpgradeInput): UpgradeTemplate {
  const platform = devices[0]?.platform || target.platform;
  const staged = image !== null && image.state === 'staged' && image.sha256 !== null;
  const hash = staged ? (image.sha256 ?? '') : target.imageSha256;
  const d = commandsFit(image, platform) && staged ? detailsFrom(image.commands) : { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const lines = (b: Bucket): string | undefined => (d[b].length > 0 ? d[b].join('\n') : undefined);
  const step = (title: string, muted: string, b?: Bucket, extra?: string): UpgradeStep => {
    const after = extra ?? (b === undefined ? undefined : lines(b));
    return { kind: 'other', change: `${title}\n${muted}`, ...(after !== undefined ? { after } : {}) };
  };
  const compare = hash ? `Compare with ${shortHash(hash)}.` : "Compare with the vendor's published value.";
  const fetchMuted = staged ? 'The device pulls it with the one-time link below.' : 'Stage the image in Fathom first (Inventory, Firmware, Upload image).';
  return {
    deviceIds: devices.map((x) => x.deviceId),
    title: upgradeTitle(model, target.version),
    steps: [
      step('Back up the running config', 'Paste it into Fathom; the redaction gate runs first.', 1),
      step('Check free space on the device', 'Clear old images if it is short.', 2),
      step(FETCH_STEP_TITLE, fetchMuted, 3, lines(3) ?? (staged ? `copy the image from ${LINK_PLACEHOLDER}` : undefined)),
      step('Check the SHA-256 on the device', compare, 4),
      step('Install and reboot', 'Inside the window.', 5),
      step('Paste the new version back', 'Checks clears "behind" on its own.'),
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
