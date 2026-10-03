// Paste rows from a spreadsheet (ADR-0062): TSV or CSV, a header row optional. Shows what will be
// added and updated, runs every cell through the redaction gate, then hands the plan back.

import { useEffect, useMemo, useState } from 'react';

import type { Column, InvRow } from './kinds';
import { gatePastedTable, parseTable, planPaste, splitRowNote, withoutUntickedSplitRows, type GatedTable, type PastePlan } from './paste';

/** A kind whose rows are not matched by Name (prefixes, VLANs): it reads the pasted table itself. */
export interface CustomPaste {
  hint: string;
  /** One line about what applying would do. */
  summarise: (table: string[][]) => string;
  /** Gets the table after every cell has passed the redaction gate. */
  onApply: (clean: string[][]) => void;
}

export interface PasteDialogProps {
  custom?: CustomPaste;
  initialText: string;
  kindLabel: string;
  columns: readonly Column[];
  rows: readonly InvRow[];
  canAdd: boolean;
  redact: (text: string) => Promise<string>;
  onCancel: () => void;
  onApply: (plan: PastePlan) => void;
}

const toggled = (set: ReadonlySet<number>, i: number, on: boolean): ReadonlySet<number> => {
  const next = new Set(set);
  if (on) next.add(i);
  else next.delete(i);
  return next;
};

export function PasteDialog(props: PasteDialogProps) {
  const { custom, initialText, kindLabel, columns, rows, canAdd, redact, onCancel, onApply } = props;
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rows with a secret split across cells wait here, unticked, until the user decides (then Apply again).
  const [review, setReview] = useState<GatedTable | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());

  const table = useMemo(() => parseTable(text), [text]);
  const plan = useMemo(() => planPaste(table, custom ? [] : columns, rows, { canAdd }), [table, columns, rows, canAdd, custom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const edit = (v: string) => {
    setText(v);
    setReview(null);
    setTicked(new Set());
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const gated = review ?? (await gatePastedTable(table, redact));
      if (!review && gated.splitRows.length > 0) {
        setReview(gated);
        setTicked(new Set());
        setBusy(false);
        return;
      }
      const clean = withoutUntickedSplitRows(gated.clean, gated.splitRows, ticked);
      if (custom) custom.onApply(clean);
      else onApply(planPaste(clean, columns, rows, { canAdd }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The redaction gate could not run, so nothing was pasted.');
      setBusy(false);
    }
  };

  const nothing = custom ? table.length === 0 : plan.adds.length + plan.updates.length === 0;
  return (
    <div className="inv-paste" role="dialog" aria-modal="true" aria-label={`Paste ${kindLabel}`}>
      <div className="inv-paste__box">
        <h2>Paste {kindLabel.toLowerCase()}</h2>
        <p className="inv-paste__muted">
          {custom ? custom.hint : `Rows copied from a spreadsheet (tab-separated or CSV). A first row of column names is used as the header; otherwise cells fill the
          columns shown, left to right. Rows are matched by name. An empty cell leaves the value alone. Pasted text passes the redaction gate.`}
        </p>
        <textarea aria-label="Pasted rows" data-gate="self" rows={8} value={text} onChange={(e) => edit(e.currentTarget.value)} autoFocus />
        <p role="status">
          {table.length === 0
            ? 'Nothing pasted yet.'
            : custom
              ? custom.summarise(table)
              : `${plan.adds.length} to add, ${plan.updates.length} to update${plan.skipped ? `, ${plan.skipped} skipped (no name${canAdd ? '' : ' match'})` : ''}.`}
          {!custom && plan.ignoredHeaders.length ? ` Ignored columns: ${plan.ignoredHeaders.join(', ')}.` : ''}
        </p>
        {!custom && table.length > 0 && plan.mapped.some(Boolean) ? (
          <table className="inv-paste__preview" aria-label="Preview">
            <thead>
              <tr>
                <th>Row</th>
                {plan.mapped.map((c, i) => (
                  <th key={i}>{c ? c.label : 'ignored'}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.slice(0, 6).map((cells, ri) => (
                <tr key={ri}>
                  <td>{ri + 1}</td>
                  {plan.mapped.map((_, i) => (
                    <td key={i}>{cells[i] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {review ? (
          <fieldset className="inv-paste__split" aria-label="Rows with a split password">
            {review.splitRows.map((ri) => (
              <label key={ri}>
                <input type="checkbox" checked={ticked.has(ri)} onChange={(e) => setTicked(toggled(ticked, ri, e.currentTarget.checked))} /> {splitRowNote(ri + 1)}
              </label>
            ))}
            <p className="inv-paste__muted">Rows left unticked are not brought in. Press Apply to go on.</p>
          </fieldset>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="inv-paste__actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" disabled={busy || nothing} onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
