// What looks wrong about sending this image to these devices, said before the one-time link is
// given (sign-off r62, "unusual pushes: warnings, never blocks"). Each warning names the device and
// what it found, and the person can still get the link: going ahead is sent to the server with the
// codes of the warnings passed, and sealed with the link's own history entry.

import type { FirmwareImage } from '../../api/firmware';
import { chosenFor, listTargets, type FwDevice } from '../../document/firmware';
import { versionOlder } from '../../document/firmwareVersion';
import type { Document } from '../../document/model';
import { modelsOfImage } from './images';

/** The codes the server records. Never free text: the words are the client's, the codes are the fact. */
export type LinkWarningCode = 'wrong_model' | 'downgrade' | 'not_chosen';

export interface LinkWarning {
  code: LinkWarningCode;
  deviceId: string;
  words: string;
}

const named = (d: FwDevice): string => d.hostname || 'This device';

/**
 * Warnings for sending `image` to `devices`. Says nothing it cannot back: an image with no models
 * listed is not "the wrong model", and a version the numbering cannot order is not a downgrade.
 */
export function linkWarnings(doc: Document, image: FirmwareImage, devices: readonly FwDevice[]): LinkWarning[] {
  const out: LinkWarning[] = [];
  const models = modelsOfImage(image, listTargets(doc)).map((m) => m.toLowerCase());
  for (const d of devices) {
    const own = d.models.map((m) => m.toLowerCase());
    if (models.length > 0 && own.length > 0 && !own.some((m) => models.includes(m))) {
      out.push({
        code: 'wrong_model',
        deviceId: d.deviceId,
        words: `This image is for ${modelsOfImage(image, listTargets(doc)).join(', ')}. ${named(d)} is ${d.models.join(', ')}.`,
      });
    }
    if (image.version !== null && d.osVersion !== '') {
      const older = versionOlder(d.platform || image.platform || '', image.version, d.osVersion);
      if (older === true) {
        out.push({ code: 'downgrade', deviceId: d.deviceId, words: `${image.version} is older than ${d.osVersion}, which ${named(d)} runs now.` });
      }
    }
    const chosen = chosenFor(doc, d);
    if (image.version !== null && chosen !== null && chosen.version !== '' && chosen.version !== image.version) {
      out.push({ code: 'not_chosen', deviceId: d.deviceId, words: `${named(d)} has ${chosen.version} chosen, not ${image.version}.` });
    }
  }
  return out;
}

/** The distinct codes, sorted, as the server takes them. */
export const warningCodes = (warnings: readonly LinkWarning[]): LinkWarningCode[] => [...new Set(warnings.map((w) => w.code))].sort();
