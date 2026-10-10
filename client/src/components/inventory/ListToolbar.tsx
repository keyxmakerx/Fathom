// The strip above the Inventory table (ADR-0062): add by name, filters, column choice, paste, and
// the bulk-edit bar that replaces nothing — it appears when rows are ticked.

import { useEffect, useRef, useState } from 'react';

import { PROGRESS_FROM, planFor, type BulkPlan, type BulkSpec } from './bulk';
import type { Column, InvRow } from './kinds';

export interface ListToolbarProps {
  kindLabel: string;
  columnsAll: readonly Column[];
  columns: readonly Column[];
  onColumns: (keys: string[]) => void;
  canAdd: boolean;
  addHint: string;
  onAdd: (name: string) => string | void;
  /** A button in place of the add-by-name box, for kinds that need more than a name. */
  addAction?: { label: string; onClick: () => void };
  onPaste?: () => void;
  /** Opens the file importer (round 9). */
  onImport?: () => void;
  /** One-click narrowing by what a row is (r14 A1): All, then the commonest values. */
  kindFilter?: KindFilter;
  checkedRows: readonly InvRow[];
  bulkColumns: readonly Column[];
  /** Writes a previewed change; returns a sentence when it cannot. */
  onBulkApply?: (plan: BulkPlan) => string | void | Promise<string | void>;
  /** What a change would be refused for, found without writing; null when too many to try. */
  bulkCheck?: (plan: BulkPlan) => string[] | null;
  /** How many rows the line matches, and a way to tick them all. */
  matching: number;
  onSelectAllMatching: () => void;
  onClearChecked: () => void;
  notice: string | null;
  /** A bulk change being written in steps: how far it has got. */
  progress?: { done: number; total: number } | null;
  /** Shown beside the notice after a bulk change. */
  undo?: { run: () => void } | null;
}

export interface KindFilter {
  label: string;
  options: readonly { value: string; label: string; count: number }[];
  /** The value picked, or null for All. */
  current: string | null;
  onPick: (value: string | null) => void;
}

export function ListToolbar(props: ListToolbarProps) {
  const { kindLabel, columnsAll, columns, onColumns, canAdd, addHint, onAdd, addAction, onPaste, onImport, kindFilter, checkedRows, bulkColumns, onBulkApply, bulkCheck, matching, onSelectAllMatching, onClearChecked, notice, undo, progress } = props;
  const [name, setName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const nameBox = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<'columns' | null>(null);
  const [bulkCol, setBulkCol] = useState('');
  const [bulkValue, setBulkValue] = useState('');
  const [bulkError, setBulkError] = useState<string | null>(null);

  const submitAdd = () => {
    if (name.trim() === '') {
      nameBox.current?.focus();
      return;
    }
    const refused = onAdd(name);
    if (typeof refused === 'string') setAddError(refused);
    else {
      setName('');
      setAddError(null);
    }
  };

  const shown = new Set(columns.map((c) => c.key));
  const toggleColumn = (key: string) => {
    const keys = columns.map((c) => c.key);
    const next = shown.has(key) ? keys.filter((k) => k !== key) : [...keys, key];
    // Keep the order the kind lists them in.
    const order = columnsAll.map((c) => c.key);
    onColumns(next.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  };

  const bulkTarget = bulkColumns.find((c) => c.key === bulkCol);
  const tagsCol = bulkColumns.find((c) => c.type === 'tags');
  // The preview is planned again from the rows ticked now, so a row unticked after the preview (or
  // dropped by a changed filter) is neither shown nor written.
  const [spec, setSpec] = useState<BulkSpec | null>(null);
  const plan = spec ? planFor(spec, checkedRows) : null;
  const preview = (mode: BulkSpec['mode']) => {
    setBulkError(null);
    if (mode === 'set') {
      if (bulkTarget) setSpec({ mode, col: bulkTarget, value: bulkValue });
    } else if (tagsCol && bulkValue.trim() !== '') {
      setSpec({ mode, col: tagsCol, value: bulkValue });
    }
  };
  useEffect(() => {
    if (checkedRows.length === 0) setSpec(null);
  }, [checkedRows.length]);
  const refusals = plan && bulkCheck ? bulkCheck(plan) : null;
  const noun = kindLabel.toLowerCase();

  return (
    <div className="inv-toolbar">
      <div className="inv-toolbar__row">
        {kindFilter && kindFilter.options.length > 0 ? (
          <div className="btn-group inv-toolbar__kinds" role="group" aria-label={kindFilter.label}>
            <button type="button" aria-pressed={kindFilter.current === null} onClick={() => kindFilter.onPick(null)}>
              All
            </button>
            {kindFilter.options.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={kindFilter.current === o.value}
                title={`${o.count.toLocaleString('en-GB')} ${o.label.toLowerCase()}`}
                onClick={() => kindFilter.onPick(kindFilter.current === o.value ? null : o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : null}
        <span className="inv-toolbar__grow" />
        {onImport ? (
          <button type="button" className="btn-quiet" onClick={onImport}>
            Import file
          </button>
        ) : null}
        {onPaste ? (
          <button type="button" className="btn-quiet" onClick={onPaste}>
            Paste rows
          </button>
        ) : null}
        <button type="button" className="btn-quiet" aria-expanded={open === 'columns'} onClick={() => setOpen(open === 'columns' ? null : 'columns')}>
          Columns
        </button>
        {canAdd ? (
          <form
            className="inv-toolbar__add"
            onSubmit={(e) => {
              e.preventDefault();
              submitAdd();
            }}
          >
            <input
              ref={nameBox}
              aria-label={`Name of the new ${kindLabel.toLowerCase().replace(/s$/, '')}`}
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <button type="submit" className="btn-main">
              + {kindLabel.replace(/s$/, '')}
            </button>
          </form>
        ) : addAction ? (
          <button type="button" className="btn-main" onClick={addAction.onClick}>
            {addAction.label}
          </button>
        ) : addHint ? (
          <span className="inv-toolbar__hint">{addHint}</span>
        ) : null}
      </div>
      {open === 'columns' ? (
        <div className="inv-toolbar__pop inv-toolbar__pop--columns" role="group" aria-label="Columns">
          {columnsAll.map((c) => (
            <label key={c.key}>
              <input type="checkbox" checked={shown.has(c.key)} onChange={() => toggleColumn(c.key)} /> {c.label}
            </label>
          ))}
        </div>
      ) : null}
      {addError ? (
        <div className="inv-toolbar__error" role="alert">
          {addError}
        </div>
      ) : null}
      {progress ? (
        <div className="inv-toolbar__notice" role="status">
          Changing {progress.done.toLocaleString('en-GB')} of {progress.total.toLocaleString('en-GB')}…
        </div>
      ) : null}
      {notice && !progress ? (
        <div className="inv-toolbar__notice" role="status">
          {notice}
          {undo ? (
            <button type="button" className="inv-toolbar__undo" onClick={undo.run}>
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
      {checkedRows.length > 0 ? (
        <div className="inv-bulk" role="group" aria-label="Bulk edit">
          <b>{checkedRows.length.toLocaleString('en-GB')} selected</b>
          {onBulkApply ? (
            <>
              <select aria-label="Column to set" value={bulkCol} onChange={(e) => setBulkCol(e.currentTarget.value)}>
                <option value="">Column…</option>
                {bulkColumns
                  .filter((c) => c.type !== 'tags' && c.key !== 'name')
                  .map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
              </select>
              <input aria-label="Value" placeholder="value or tag" value={bulkValue} onChange={(e) => setBulkValue(e.currentTarget.value)} />
              <button type="button" disabled={!bulkTarget} onClick={() => preview('set')}>
                Set
              </button>
              <button type="button" onClick={() => preview('add-tag')}>
                Add tag
              </button>
              <button type="button" onClick={() => preview('remove-tag')}>
                Remove tag
              </button>
            </>
          ) : null}
          {checkedRows.length < matching ? (
            <button type="button" onClick={onSelectAllMatching}>
              Select all {matching.toLocaleString('en-GB')} matching
            </button>
          ) : null}
          <button type="button" onClick={onClearChecked}>
            Clear
          </button>
          {bulkError ? <span className="inv-toolbar__error">{bulkError}</span> : null}
        </div>
      ) : null}
      {plan ? (
        <div className="inv-bulkpv" role="group" aria-label="Preview of the change">
          <p>
            <b>{plan.title}</b> on {checkedRows.length.toLocaleString('en-GB')} {noun}: {plan.lines.length.toLocaleString('en-GB')} would change
            {plan.same > 0 ? `, ${plan.same.toLocaleString('en-GB')} already so` : ''}.
          </p>
          {plan.lines.length > 0 ? (
            <table>
              <tbody>
                {plan.lines.slice(0, 8).map((l) => (
                  <tr key={l.row.key}>
                    <td>{l.row.title}</td>
                    <td className="inv-bulkpv__was">{l.before || '—'}</td>
                    <td aria-hidden="true">→</td>
                    <td>{l.after || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {plan.lines.length > 8 ? <p className="inv-bulkpv__more">and {(plan.lines.length - 8).toLocaleString('en-GB')} more</p> : null}
          {plan.lines.length > PROGRESS_FROM ? <p className="inv-bulkpv__more">That is a large change: it is written in steps, with a progress line.</p> : null}
          {refusals && refusals.length > 0 ? (
            <p className="inv-toolbar__error" role="alert">
              {refusals.length} would be refused: {refusals.slice(0, 2).join('; ')}
            </p>
          ) : refusals === null && plan.lines.length > 0 ? (
            <p className="inv-bulkpv__more">Each row is checked as it is written; any refused is named afterwards.</p>
          ) : null}
          <div className="inv-bulkpv__acts">
            <button
              type="button"
              disabled={plan.lines.length === 0 || !!progress}
              onClick={async () => {
                const refused = await onBulkApply?.(plan);
                setBulkError(typeof refused === 'string' ? refused : null);
                if (typeof refused !== 'string') setSpec(null);
              }}
            >
              Apply to {plan.lines.length.toLocaleString('en-GB')}
            </button>
            {progress ? null : (
              <button type="button" onClick={() => setSpec(null)}>
                Cancel
              </button>
            )}
            <span className="inv-bulkpv__more">One undo step.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
