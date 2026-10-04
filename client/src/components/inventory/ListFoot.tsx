// Under the table: how many rows, how many are ticked, and what the rows add up to.

import type { InvRow, Kind } from './kinds';
import { totalsOf } from './totals';

export interface ListFootProps {
  kind: Kind;
  noun: string;
  rows: readonly InvRow[];
  total: number;
  checkedRows: readonly InvRow[];
}

const fmt = (n: number): string => n.toLocaleString('en-GB');

export function ListFoot({ kind, noun, rows, total, checkedRows }: ListFootProps) {
  const all = totalsOf(kind, rows);
  const picked = checkedRows.length > 0 ? totalsOf(kind, checkedRows) : [];
  return (
    <div className="inv-foot" role="status" aria-label="Totals">
      <span className="inv-foot__count">{rows.length === total ? `${fmt(rows.length)} ${noun}` : `${fmt(rows.length)} of ${fmt(total)} ${noun}`}</span>
      {all.map((t) => (
        <span key={t.label} className="inv-foot__sum">
          {t.label} <b>{t.value}</b>
        </span>
      ))}
      {checkedRows.length > 0 ? (
        <span className="inv-foot__sel">
          {fmt(checkedRows.length)} selected
          {picked.map((t) => (
            <span key={t.label} className="inv-foot__sum">
              {t.label} <b>{t.value}</b>
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}
