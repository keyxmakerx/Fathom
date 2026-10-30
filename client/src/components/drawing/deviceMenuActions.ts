// Sign-off r58: the device actions every place offers the same way (the canvas, its panel's ⋯, Ctrl K and
// Inventory's rows). Pure: the place says how it shows a panel form, a sentence and a label sheet.

import { deviceFirmware, deviceOfChassis, targetOfDevice } from '../../document/firmware';
import type { Document } from '../../document/model';
import { deviceRows } from '../inventory/kinds';
import { deviceChassis } from '../jot/jotLayout';
import { scanLink } from '../phone/scan';
import { labelItems, type LabelItem } from '../../print/labels';
import type { ClosetView } from './contract';
import { ADD_PORT_EVENT, SHOW_TERMIX_EVENT, SWAP_MODEL_EVENT } from './Editor';
import { DUPLICATE_NEEDS_RACK, PORTS_FROM_MODEL, TERMIX_NEEDS_ADDRESS, type MenuActions } from './contextMenuItems';

export interface DeviceMenuPlace {
  doc: Document | null;
  view: ClosetView;
  designId: string | null;
  canDraw: boolean;
  /** The operator's Termix, when there is one and it is on for this person. */
  termixUrl: string | null;
  /** Opens the device's panel and asks it for one of its forms (`SWAP_MODEL_EVENT` and the like). */
  showInPanel: (chassisId: string, event: string) => void;
  /** A sentence that something went well, and one that it did not. */
  done: (sentence: string) => void;
  failed: (sentence: string) => void;
  printLabels: (items: LabelItem[]) => void;
  /** Where the page is served from, for the link; the browser's own when absent. */
  origin?: string;
}

export const LINK_COPIED = 'Link copied. It opens this device after sign-in.';

export function deviceMenuActions(place: DeviceMenuPlace): Partial<MenuActions> {
  const { doc, view, designId, canDraw, termixUrl, showInPanel, done, failed, printLabels } = place;
  const origin = () => place.origin ?? window.location.origin;
  const model = (id: string) => deviceChassis(view, id)?.model ?? '';
  return {
    hasModel: (id) => model(id) !== '',
    firmwareNeedsVersion: (id) => firmwareNeedsVersion(doc, id),
    onSwapModel: canDraw ? (id) => showInPanel(id, SWAP_MODEL_EVENT) : undefined,
    onAddPort: canDraw ? (id) => showInPanel(id, ADD_PORT_EVENT) : undefined,
    addPortRefusal: (id) => (model(id) !== '' ? PORTS_FROM_MODEL : null),
    onOpenInTermix: termixUrl != null ? (id) => showInPanel(id, SHOW_TERMIX_EVENT) : undefined,
    termixRefusal: (id) => ((deviceChassis(view, id)?.managementAddress ?? '').trim() === '' ? TERMIX_NEEDS_ADDRESS : null),
    duplicateRefusal: (id) => (view.racks.some((r) => r.chassis.some((c) => c.id === id)) ? null : DUPLICATE_NEEDS_RACK),
    onCopyLink:
      designId != null
        ? (id) => {
            // The link its printed label holds: it opens the device's page after sign-in.
            const link = scanLink(origin(), { designId, nodeId: id });
            const copying = navigator.clipboard?.writeText(link) ?? Promise.reject(new Error('no clipboard'));
            copying.then(
              () => done(LINK_COPIED),
              () => failed('The link could not be copied. The browser did not allow it.'),
            );
          }
        : undefined,
    onPrintLabel:
      doc != null && designId != null
        ? (id) => {
            const rows = deviceRows(doc, view).filter((row) => row.ids.chassisId === id);
            const items = labelItems('devices', rows, origin(), designId);
            if (items.length > 0) printLabels(items);
            else failed('This device has no label to print.');
          }
        : undefined,
  };
}

/** True until the device's model has a chosen firmware version, so a firmware plan has nothing to aim at. */
export function firmwareNeedsVersion(doc: Document | null, chassisId: string): boolean {
  const dev = doc ? deviceOfChassis(doc, chassisId) : null;
  const d = doc && dev ? deviceFirmware(doc, dev) : null;
  return d === null || doc === null || targetOfDevice(doc, d) === null;
}
