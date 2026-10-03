// The cable schedule: one row per cable, both ends, label, type and colour as words.
import type { Document } from '../document/model';
import { tagsOf } from '../document/tags';
import type { CableEnd, CableView, ClosetView } from '../document/view';
import { buildLookup } from './cutSheet';
import type { CutSheetBodyRow, CutSheetTableRow } from './cutSheetTable';

const ABSENT = '—';

export const CABLE_SCHEDULE_COLUMNS = ['Label', 'Type', 'Colour', 'Length', 'From', 'To', 'Tags'] as const;
export const CABLE_SCHEDULE_WIDTHS = [14, 16, 10, 8, 20, 20, 12];

export function cableScheduleHeaderRow(): CutSheetTableRow {
  return { cells: [...CABLE_SCHEDULE_COLUMNS], bold: true };
}

function typeWords(c: CableView): string {
  const kind = c.kind === 'fibre' ? 'Fibre' : c.kind === 'power' ? 'Power' : 'Copper';
  return c.media ? `${kind} · ${c.media}` : kind;
}

/** Every live cable in `view`, by label (unlabelled last) then id so a reprint reads the same. */
export function buildCableScheduleRows(doc: Document, view: ClosetView): CutSheetBodyRow[] {
  const { owners, ports } = buildLookup(view);
  function endText(end: CableEnd | undefined): string {
    if (end == null) return ABSENT;
    if ('outside' in end) return end.label ? `outside · ${end.label}` : 'outside';
    const owner = owners.get(end.chassisId);
    const port = ports.get(end.portId);
    return owner && port ? `${owner.name} ${port.label}` : ABSENT;
  }
  const sorted = [...view.cables].sort((a, b) => Number(!a.label) - Number(!b.label) || (a.label ?? '').localeCompare(b.label ?? '') || a.id.localeCompare(b.id));
  return sorted.map((c) => ({
    isDeviceHeader: false,
    row: {
      bold: false,
      cells: [
        c.label || ABSENT,
        typeWords(c),
        c.sheath ?? ABSENT,
        c.lengthM != null ? `${c.lengthM} m` : ABSENT,
        endText(c.ends[0]),
        endText(c.ends[1]),
        tagsOf(doc, c.id)
          .map((t) => t.name)
          .join(', '),
      ],
    },
  }));
}
