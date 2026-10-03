// The ▾ on a column heading: sort it, and filter by what it holds. Values are listed with how many
// rows carry each; a column with more than TOO_MANY different values asks for a typed condition
// instead. Whatever is picked is written into the filter line, the one place a filter lives.

import { useMemo, useState } from 'react';

import { TOO_MANY, distinctOf } from './facets';
import { COLUMN_ASKS, type Column, type InvRow, type Kind } from './kinds';
import { fieldState, setField, setFieldTerm, stripField, quoteValue } from './query';
import { fieldOfColumn, filterRows, type QuerySchema } from './rowQuery';
import type { SortKey } from './listState';

export interface ColumnMenuProps {
  col: Column;
  kind: Kind;
  schema: QuerySchema;
  rows: readonly InvRow[];
  q: string;
  onQ: (q: string) => void;
  sorts: readonly SortKey[];
  onSort: (dir: 'asc' | 'desc' | null, additive: boolean) => void;
  onClose: () => void;
}

const fmt = (n: number): string => n.toLocaleString('en-GB');
const SHOWN = 100;

const OPS: ReadonlyArray<{ op: string; label: string }> = [
  { op: '~', label: 'contains' },
  { op: ':', label: 'is' },
  { op: '^', label: 'starts with' },
  { op: '!=', label: 'is not' },
];
const NUM_OPS: ReadonlyArray<{ op: string; label: string }> = [
  { op: '>=', label: 'at least' },
  { op: '<=', label: 'at most' },
  { op: ':', label: 'is' },
];

export function ColumnMenu({ col, kind, schema, rows, q, onQ, sorts, onSort, onClose }: ColumnMenuProps) {
  const field = fieldOfColumn(schema, col.key);
  const asks = (COLUMN_ASKS[kind]?.[col.key] ?? []).filter((f) => schema.fields.some((x) => x.key === f));
  const mine = sorts.find((s) => s.key === col.key);
  return (
    <div className="inv-cm" role="menu" aria-label={`${col.label} column`}>
      <div className="inv-cm__sec">
        <div className="inv-cm__head">Sort</div>
        <div className="inv-cm__row">
          <button type="button" role="menuitem" aria-pressed={mine?.dir === 'asc' && sorts.length === 1} onClick={() => onSort('asc', false)}>
            A → Z
          </button>
          <button type="button" role="menuitem" aria-pressed={mine?.dir === 'desc' && sorts.length === 1} onClick={() => onSort('desc', false)}>
            Z → A
          </button>
          <button type="button" role="menuitem" disabled={sorts.length === 0} onClick={() => onSort(null, false)}>
            No sort
          </button>
        </div>
        {sorts.length > 0 && !(sorts.length === 1 && mine) ? (
          <div className="inv-cm__row">
            <span className="inv-cm__note">Then by this:</span>
            <button type="button" role="menuitem" aria-pressed={mine?.dir === 'asc'} onClick={() => onSort('asc', true)}>
              A → Z
            </button>
            <button type="button" role="menuitem" aria-pressed={mine?.dir === 'desc'} onClick={() => onSort('desc', true)}>
              Z → A
            </button>
          </div>
        ) : (
          <p className="inv-cm__note">Shift-click a heading to sort by a second column.</p>
        )}
      </div>
      {field ? <Question field={field} label={col.label} schema={schema} rows={rows} q={q} onQ={onQ} /> : <p className="inv-cm__note">This column has no filter.</p>}
      {asks.length > 0 ? (
        <div className="inv-cm__sec">
          <div className="inv-cm__head">Also ask about</div>
          {asks.map((f) => (
            <details key={f} className="inv-cm__ask">
              <summary>{schema.labelOf(f)}</summary>
              <Question field={f} label={schema.labelOf(f)} schema={schema} rows={rows} q={q} onQ={onQ} bare />
            </details>
          ))}
        </div>
      ) : null}
      <div className="inv-cm__foot">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function Question(props: { field: string; label: string; schema: QuerySchema; rows: readonly InvRow[]; q: string; onQ: (q: string) => void; bare?: boolean }) {
  const { field, label, schema, rows, q, onQ, bare } = props;
  const spec = schema.fields.find((f) => f.key === field);
  const numeric = !!spec?.numeric;
  const [find, setFind] = useState('');
  const [op, setOp] = useState(numeric ? '>=' : '~');
  const [typed, setTyped] = useState('');
  // Counts follow the other filters but not this field's own, so picking a second value shows what it adds.
  const dv = useMemo(() => {
    const others = stripField(q, field);
    const scoped = others === '' ? rows : filterRows(rows, schema, others).rows;
    return distinctOf(scoped, schema, field);
  }, [q, rows, schema, field]);
  const st = fieldState(q, field);
  const write = (patch: Partial<typeof st>) => onQ(setField(q, field, { ...st, ...patch }));
  const tooMany = dv.n > TOO_MANY;

  const apply = () => {
    const v = typed.trim();
    if (v === '') return;
    onQ(setFieldTerm(q, field, `${field}${op}${quoteValue(v)}`));
    setTyped('');
  };

  const typedForm = (
    <form
      className="inv-cm__typed"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <select aria-label={`${label} condition`} value={op} onChange={(e) => setOp(e.currentTarget.value)}>
        {(numeric ? NUM_OPS : OPS).map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      <input aria-label={`${label} value`} value={typed} onChange={(e) => setTyped(e.currentTarget.value)} placeholder={numeric ? 'a number' : 'text'} />
      <button type="submit" disabled={typed.trim() === ''}>
        Apply
      </button>
    </form>
  );

  const needle = find.trim().toLowerCase();
  const keys = dv.keys.filter((k) => needle === '' || k.toLowerCase().includes(needle));
  const chosen = new Set(st.values.map((v) => v.toLowerCase()));
  return (
    <div className="inv-cm__sec">
      {bare ? null : <div className="inv-cm__head">Show only</div>}
      {tooMany || numeric ? (
        <>
          <p className="inv-cm__note">
            {numeric ? `${fmt(dv.n)} different values. Ask with a number.` : `${fmt(dv.n)} different values: too many to list. Type a condition.`}
          </p>
          {typedForm}
        </>
      ) : (
        <>
          {dv.n > 8 ? <input className="inv-cm__find" aria-label={`Find in ${label}`} placeholder={`Find among ${fmt(dv.n)} values`} value={find} onChange={(e) => setFind(e.currentTarget.value)} /> : null}
          <div className="inv-cm__vals" role="group" aria-label={`${label} values`}>
            {keys.slice(0, SHOWN).map((k) => (
              <label key={k}>
                <input
                  type="checkbox"
                  checked={chosen.has(k.toLowerCase())}
                  onChange={() => write({ values: chosen.has(k.toLowerCase()) ? st.values.filter((v) => v.toLowerCase() !== k.toLowerCase()) : [...st.values, k] })}
                />
                <span className="inv-cm__val">{k}</span>
                <span className="inv-cm__n">{fmt(dv.counts.get(k) ?? 0)}</span>
              </label>
            ))}
            {keys.length > SHOWN ? <p className="inv-cm__note">{fmt(keys.length - SHOWN)} more: narrow with the box above.</p> : null}
            {keys.length === 0 ? <p className="inv-cm__note">Nothing matches.</p> : null}
          </div>
          {st.values.length > 0 ? (
            <button type="button" className="inv-cm__clear" onClick={() => onQ(stripField(q, field))}>
              Clear {label}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
