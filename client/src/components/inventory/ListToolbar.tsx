// The strip above the Inventory table (ADR-0062): add by name, filters, column choice, paste, and
// the bulk-edit bar that replaces nothing — it appears when rows are ticked.

import { useState } from 'react';

import { parseFilterText } from './filterText';
import type { CellEdit, Column, InvRow } from './kinds';

export interface Filter {
  /** A column key, or `*` for any cell. */
  col: string;
  value: string;
}

export interface ListToolbarProps {
  kindLabel: string;
  columnsAll: readonly Column[];
  columns: readonly Column[];
  onColumns: (keys: string[]) => void;
  filters: readonly Filter[];
  onFilters: (f: Filter[]) => void;
  canAdd: boolean;
  addHint: string;
  onAdd: (name: string) => string | void;
  /** A button in place of the add-by-name box, for kinds that need more than a name. */
  addAction?: { label: string; onClick: () => void };
  onPaste?: () => void;
  /** Opens the file importer (round 9). */
  onImport?: () => void;
  checkedRows: readonly InvRow[];
  bulkColumns: readonly Column[];
  onBulk?: (edits: CellEdit[]) => string | void;
  onClearChecked: () => void;
  notice: string | null;
}

export function ListToolbar(props: ListToolbarProps) {
  const { kindLabel, columnsAll, columns, onColumns, filters, onFilters, canAdd, addHint, onAdd, addAction, onPaste, onImport, checkedRows, bulkColumns, onBulk, onClearChecked, notice } = props;
  const [name, setName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [filterCol, setFilterCol] = useState('*');
  const [filterValue, setFilterValue] = useState('');
  const [open, setOpen] = useState<'columns' | 'filter' | null>(null);
  const [bulkCol, setBulkCol] = useState('');
  const [bulkValue, setBulkValue] = useState('');
  const [bulkError, setBulkError] = useState<string | null>(null);

  const submitAdd = () => {
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
  const applyBulk = (mode: 'set' | 'add-tag' | 'remove-tag') => {
    if (!onBulk) return;
    const tagsCol = bulkColumns.find((c) => c.type === 'tags');
    let edits: CellEdit[];
    if (mode === 'set') {
      if (!bulkTarget) return;
      edits = checkedRows.map((row) => ({ row, col: bulkTarget, value: bulkValue }));
    } else {
      if (!tagsCol || bulkValue.trim() === '') return;
      const t = bulkValue.trim().toLowerCase();
      edits = checkedRows.map((row) => {
        const have = row.tags.filter((x) => x.toLowerCase() !== t);
        const next = mode === 'add-tag' ? [...have, bulkValue.trim()] : have;
        return { row, col: tagsCol, value: next.join(', ') };
      });
    }
    const refused = onBulk(edits);
    setBulkError(typeof refused === 'string' ? refused : null);
  };

  return (
    <div className="inv-toolbar">
      <div className="inv-toolbar__row">
        {canAdd ? (
          <form
            className="inv-toolbar__add"
            onSubmit={(e) => {
              e.preventDefault();
              submitAdd();
            }}
          >
            <input
              aria-label={`Name of the new ${kindLabel.toLowerCase().replace(/s$/, '')}`}
              placeholder="+ Add by name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <button type="submit" disabled={name.trim() === ''}>
              Add
            </button>
          </form>
        ) : addAction ? (
          <button type="button" onClick={addAction.onClick}>
            {addAction.label}
          </button>
        ) : addHint ? (
          <span className="inv-toolbar__hint">{addHint}</span>
        ) : null}
        {filters.map((f, i) => (
          <span key={`${f.col}:${f.value}:${i}`} className="inv-chip">
            {f.col === '*' ? 'Any' : (columnsAll.find((c) => c.key === f.col)?.label ?? f.col)}: {f.value}
            <button type="button" aria-label="Remove filter" onClick={() => onFilters(filters.filter((_, j) => j !== i))}>
              ×
            </button>
          </span>
        ))}
        <button type="button" aria-expanded={open === 'filter'} onClick={() => setOpen(open === 'filter' ? null : 'filter')}>
          + Filter
        </button>
        <span className="inv-toolbar__grow" />
        {onImport ? (
          <button type="button" onClick={onImport}>
            Import file
          </button>
        ) : null}
        {onPaste ? (
          <button type="button" onClick={onPaste}>
            Paste rows
          </button>
        ) : null}
        <button type="button" aria-expanded={open === 'columns'} onClick={() => setOpen(open === 'columns' ? null : 'columns')}>
          Columns
        </button>
      </div>
      {open === 'filter' ? (
        <form
          className="inv-toolbar__pop"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = parseFilterText(filterValue, columnsAll, filterCol);
            if (parsed == null) return;
            onFilters([...filters, parsed]);
            setFilterValue('');
            setOpen(null);
          }}
        >
          <select aria-label="Filter column" value={filterCol} onChange={(e) => setFilterCol(e.currentTarget.value)}>
            <option value="*">Any column</option>
            {columnsAll.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <input aria-label="Contains" placeholder="contains, or tag:edge" value={filterValue} onChange={(e) => setFilterValue(e.currentTarget.value)} autoFocus />
          <button type="submit">Add filter</button>
        </form>
      ) : null}
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
      {notice ? (
        <div className="inv-toolbar__notice" role="status">
          {notice}
        </div>
      ) : null}
      {checkedRows.length > 0 ? (
        <div className="inv-bulk" role="group" aria-label="Bulk edit">
          <b>{checkedRows.length} selected</b>
          {onBulk ? (
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
              <button type="button" disabled={!bulkTarget} onClick={() => applyBulk('set')}>
                Set
              </button>
              <button type="button" onClick={() => applyBulk('add-tag')}>
                Add tag
              </button>
              <button type="button" onClick={() => applyBulk('remove-tag')}>
                Remove tag
              </button>
            </>
          ) : null}
          <button type="button" onClick={onClearChecked}>
            Clear
          </button>
          {bulkError ? <span className="inv-toolbar__error">{bulkError}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
