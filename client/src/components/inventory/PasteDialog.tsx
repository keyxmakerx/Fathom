// Paste rows from a spreadsheet (ADR-0062): TSV or CSV, a header row optional. Shows what will be
// added and updated, runs every cell through the redaction gate, then hands the plan back.

import { useEffect, useMemo, useState } from 'react';

import type { Column, InvRow } from './kinds';
import { gatePastedTable, parseTable, planPaste, type PastePlan } from './paste';

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

export function PasteDialog(props: PasteDialogProps) {
  const { custom, initialText, kindLabel, columns, rows, canAdd, redact, onCancel, onApply } = props;
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const table = useMemo(() => parseTable(text), [text]);
  const plan = useMemo(() => planPaste(table, custom ? [] : columns, rows, { canAdd }), [table, columns, rows, canAdd, custom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const { clean } = await gatePastedTable(table, redact);
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
        <textarea aria-label="Pasted rows" data-gate="self" rows={8} value={text} onChange={(e) => setText(e.currentTarget.value)} autoFocus />
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
                {plan.mapped.map((c, i) => (
                  <th key={i}>{c ? c.label : 'ignored'}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.slice(0, 6).map((cells, ri) => (
                <tr key={ri}>
                  {plan.mapped.map((_, i) => (
                    <td key={i}>{cells[i] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
