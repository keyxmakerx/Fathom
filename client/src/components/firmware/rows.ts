// The Models list: one row per catalogue model that has a device or a chosen version, opening that
// model's page. Pure. The same `InvRow` the other kinds use, so the table, sorting and filter line
// are the ones Inventory already has.

import type { FwModelRow } from '../../document/firmware';
import type { InvRow } from '../inventory/kinds';

export const MODEL_KEY = 'fw:';

export const modelKey = (model: string): string => `${MODEL_KEY}${model}`;
export const modelOfKey = (key: string): string | null => (key.startsWith(MODEL_KEY) ? key.slice(MODEL_KEY.length) : null);

export function modelTableRows(models: readonly FwModelRow[]): InvRow[] {
  return models.map((m) => {
    const t = m.target;
    const devices = m.devices.length;
    return {
      key: modelKey(m.model),
      selection: null,
      ownerId: null,
      cells: {
        model: m.model,
        platform: t?.platform || m.devices[0]?.device.platform || '',
        version: t?.version ?? '',
        devices: String(devices),
        behind: String(m.behind),
        held: String(m.held),
      },
      tags: [],
      ids: {},
      title: m.model,
      sort: { devices, behind: m.behind, held: m.held },
      nums: { devices, behind: m.behind, held: m.held },
    };
  });
}
