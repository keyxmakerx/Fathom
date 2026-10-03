// The Where bar, above everything: site, then row, then rack. Counts, lists and search all follow it.

import { hasWhere, type Where, type WhereOptions } from './placeIndex';

export interface WhereBarProps {
  where: Where;
  options: WhereOptions;
  onChange: (w: Where) => void;
}

export function WhereBar({ where, options, onChange }: WhereBarProps) {
  const set = (patch: Partial<Where>) => onChange({ ...where, ...patch });
  return (
    <div className="inv-where" role="group" aria-label="Where">
      <span className="inv-where__label">Where</span>
      <select aria-label="Site" value={where.site} onChange={(e) => onChange({ site: e.currentTarget.value, room: '', rack: '' })}>
        <option value="">All sites</option>
        {options.sites.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {where.site !== '' ? (
        <>
          <span className="inv-where__sep" aria-hidden="true">
            ›
          </span>
          <select aria-label="Row" value={where.room} onChange={(e) => set({ room: e.currentTarget.value, rack: '' })}>
            <option value="">All rows</option>
            {options.rooms.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span className="inv-where__sep" aria-hidden="true">
            ›
          </span>
          <select aria-label="Rack" value={where.rack} onChange={(e) => set({ rack: e.currentTarget.value })}>
            <option value="">All racks</option>
            {options.racks.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {hasWhere(where) ? (
        <button type="button" className="inv-where__clear" onClick={() => onChange({ site: '', room: '', rack: '' })}>
          Clear ✕
        </button>
      ) : null}
      <span className="inv-where__grow" />
      <span className="inv-where__note">Counts, lists and search all follow this.</span>
    </div>
  );
}
