// The Inventory list (ADR-0062): a virtualised grid whose cells edit in place. Rows have a fixed
// height, so only the rows in view are in the DOM and a design with thousands of rows stays fast.
// Keys: arrows move, Enter or F2 or typing edits, Tab and Shift Tab move to the next editable cell
// (committing), Escape cancels. It never writes the document: `onCommit` does, and may refuse.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { Column, InvRow } from './kinds';
import type { SortKey } from './listState';
import { SheathWord } from './Swatch';

export const ROW_HEIGHT = 30;
const OVERSCAN = 8;
const CHECK_WIDTH = 34;

export type Sort = SortKey;

export interface DataTableProps {
  columns: readonly Column[];
  rows: readonly InvRow[];
  /** The row last opened, marked when the list comes back. */
  openKey: string | null;
  checked: ReadonlySet<string>;
  /** First is the main sort; a second comes from a shift-click. */
  sorts: readonly Sort[];
  canEdit: boolean;
  /** Returns a sentence when the edit is refused; the editor then stays open. */
  onCommit: (row: InvRow, col: Column, value: string) => string | void;
  /** A tag chip was clicked: filter the list by it. */
  onFilterTag?: (tag: string) => void;
  onOpen: (row: InvRow) => void;
  onToggleChecked: (row: InvRow, shift: boolean) => void;
  onToggleAll: (checkAll: boolean) => void;
  /** `additive` is a shift-click: sort by this column after the others. */
  onSort: (key: string, additive: boolean) => void;
  /** The ▾ menu's content for a column; omit it and headings have no ▾. */
  columnMenu?: (col: Column, close: () => void) => ReactNode;
  emptyText: string;
  /** Where the list was scrolled to when it was last left. */
  initialScrollTop?: number;
  onScrollTop?: (top: number) => void;
}

interface Cell {
  rowKey: string;
  colKey: string;
}

const TEXT_TYPES = new Set(['text', 'number', 'tags']);
/** The column that stays in view while the others scroll sideways. */
const STICKY = new Set(['name', 'prefix']);

function inputType(col: Column): string {
  return col.type === 'date' ? 'date' : 'text';
}

export function DataTable(props: DataTableProps) {
  const { columns, rows, openKey, checked, sorts, canEdit, onCommit, onFilterTag, onOpen, onToggleChecked, onToggleAll, onSort, columnMenu, emptyText, initialScrollTop = 0, onScrollTop } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(initialScrollTop);
  const [viewHeight, setViewHeight] = useState(600);
  const [active, setActive] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<{ cell: Cell; draft: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (menuRef.current?.contains(t) || t.closest('.inv-table__menu')) return;
      setMenu(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = () => setViewHeight(el.clientHeight || 600);
    measure();
    if (initialScrollTop > 0) el.scrollTop = initialScrollTop;
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalWidth = CHECK_WIDTH + columns.reduce((n, c) => n + c.width, 0);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);

  const rowIndex = useCallback((key: string) => rows.findIndex((r) => r.key === key), [rows]);

  const reveal = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = index * ROW_HEIGHT;
      const view = el.clientHeight - ROW_HEIGHT; // the sticky header
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_HEIGHT > el.scrollTop + view) el.scrollTop = top + ROW_HEIGHT - view;
    },
    [],
  );

  const moveTo = useCallback(
    (ri: number, ci: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, ri))];
      const col = columns[Math.max(0, Math.min(columns.length - 1, ci))];
      if (!row || !col) return;
      setActive({ rowKey: row.key, colKey: col.key });
      reveal(rows.indexOf(row));
    },
    [rows, columns, reveal],
  );

  const startEdit = (cell: Cell, seed?: string) => {
    const row = rows.find((r) => r.key === cell.rowKey);
    const col = columns.find((c) => c.key === cell.colKey);
    if (!canEdit || !row || !col || !col.editable) return;
    setError(null);
    setEditing({ cell, draft: seed ?? row.cells[col.key] ?? '' });
  };

  /** Commits the open editor. Returns true when it closed. */
  const commit = (value: string): boolean => {
    if (!editing) return true;
    const row = rows.find((r) => r.key === editing.cell.rowKey);
    const col = columns.find((c) => c.key === editing.cell.colKey);
    if (!row || !col) {
      setEditing(null);
      return true;
    }
    if ((row.cells[col.key] ?? '') === value.trim()) {
      setEditing(null);
      setError(null);
      return true;
    }
    const refusal = onCommit(row, col, value);
    if (typeof refusal === 'string') {
      setError(refusal);
      return false;
    }
    setEditing(null);
    setError(null);
    return true;
  };

  const nextEditable = (ri: number, ci: number, dir: 1 | -1): [number, number] | null => {
    let r = ri;
    let c = ci + dir;
    for (let guard = 0; guard < rows.length * columns.length + 1; guard += 1) {
      if (c >= columns.length) {
        c = 0;
        r += 1;
      } else if (c < 0) {
        c = columns.length - 1;
        r -= 1;
      }
      if (r < 0 || r >= rows.length) return null;
      if (columns[c]!.editable) return [r, c];
      c += dir;
    }
    return null;
  };

  const onEditorKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!editing) return;
    const ri = rowIndex(editing.cell.rowKey);
    const ci = columns.findIndex((c) => c.key === editing.cell.colKey);
    const value = (e.target as HTMLInputElement).value;
    if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(null);
      setError(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (commit(value)) moveTo(ri + 1, ci);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (!commit(value)) return;
      const next = nextEditable(ri, ci, e.shiftKey ? -1 : 1);
      if (next) {
        moveTo(next[0], next[1]);
        const row = rows[next[0]]!;
        const col = columns[next[1]]!;
        setEditing({ cell: { rowKey: row.key, colKey: col.key }, draft: row.cells[col.key] ?? '' });
      }
    }
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || !active) return;
    const ri = rowIndex(active.rowKey);
    const ci = columns.findIndex((c) => c.key === active.colKey);
    if (ri < 0 || ci < 0) return;
    const go = (r: number, c: number) => {
      e.preventDefault();
      moveTo(r, c);
    };
    switch (e.key) {
      case 'ArrowDown':
        return go(ri + 1, ci);
      case 'ArrowUp':
        return go(ri - 1, ci);
      case 'ArrowRight':
        return go(ri, ci + 1);
      case 'ArrowLeft':
        return go(ri, ci - 1);
      case 'PageDown':
        return go(ri + Math.floor(viewHeight / ROW_HEIGHT), ci);
      case 'PageUp':
        return go(ri - Math.floor(viewHeight / ROW_HEIGHT), ci);
      case 'Home':
        return go(ri, 0);
      case 'End':
        return go(ri, columns.length - 1);
      case 'Tab': {
        const next = nextEditable(ri, ci, e.shiftKey ? -1 : 1);
        if (next) return go(next[0], next[1]);
        return;
      }
      case ' ':
        e.preventDefault();
        onToggleChecked(rows[ri]!, e.shiftKey);
        return;
      case 'F2':
        e.preventDefault();
        if (columns[ci]!.editable && canEdit) startEdit(active);
        return;
      case 'Enter':
        e.preventDefault();
        // The first column is the row's title: Enter opens it. Other editable cells edit.
        if (ci > 0 && columns[ci]!.editable && canEdit) startEdit(active);
        else onOpen(rows[ri]!);
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const col = columns[ci]!;
          if (col.editable && canEdit && TEXT_TYPES.has(col.type)) {
            e.preventDefault();
            startEdit(active, e.key);
          }
        }
    }
  };

  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.key));

  return (
    <div className="inv-table" role="presentation">
      {error ? (
        <div className="inv-table__error" role="alert">
          {error}
        </div>
      ) : null}
      <div
        className="inv-table__scroll"
        ref={scrollRef}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          onScrollTop?.(e.currentTarget.scrollTop);
        }}
        role="grid"
        aria-rowcount={rows.length + 1}
        aria-colcount={columns.length + 1}
        tabIndex={0}
        onKeyDown={onGridKey}
      >
        <div className="inv-table__inner" style={{ width: totalWidth }}>
          <div className="inv-table__head" role="row" style={{ height: ROW_HEIGHT }}>
            <div className="inv-table__check" role="columnheader" style={{ width: CHECK_WIDTH }}>
              <input
                type="checkbox"
                aria-label="Select all rows"
                checked={allChecked}
                onChange={(e) => onToggleAll(e.currentTarget.checked)}
              />
            </div>
            {columns.map((c) => {
              const at = sorts.findIndex((x) => x.key === c.key);
              const sort = at >= 0 ? sorts[at]! : null;
              return (
                <div
                  key={c.key}
                  role="columnheader"
                  className={`inv-table__th${STICKY.has(c.key) ? ' inv-table__stick' : ''}`}
                  style={{ width: c.width }}
                  aria-sort={sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button type="button" className="inv-table__sort" onClick={(e) => onSort(c.key, e.shiftKey)}>
                    <span className="inv-table__label">{c.label}</span>
                    {sort ? (
                      <span className="inv-table__mark" aria-hidden="true">
                        {sorts.length > 1 ? `${at + 1}` : ''}
                        {sort.dir === 'asc' ? '▲' : '▼'}
                      </span>
                    ) : null}
                  </button>
                  {columnMenu ? (
                    <button
                      type="button"
                      className="inv-table__caret"
                      aria-label={`${c.label} menu`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.key === c.key}
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setMenu(menu?.key === c.key ? null : { key: c.key, left: Math.min(r.left, window.innerWidth - 340), top: r.bottom + 2 });
                      }}
                    >
                      ▾
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {rows.length === 0 ? <div className="inv-table__empty">{emptyText}</div> : null}
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            {visible.map((row, i) => {
              const index = first + i;
              const isOpen = row.key === openKey;
              return (
                <div
                  key={row.key}
                  role="row"
                  aria-rowindex={index + 2}
                  aria-selected={isOpen}
                  className={`inv-table__row${isOpen ? ' inv-table__row--open' : ''}${checked.has(row.key) ? ' inv-table__row--checked' : ''}`}
                  style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                >
                  <div className="inv-table__check" role="gridcell" style={{ width: CHECK_WIDTH }}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.title}`}
                      checked={checked.has(row.key)}
                      onChange={() => undefined}
                      onClick={(e) => onToggleChecked(row, e.shiftKey)}
                    />
                  </div>
                  {columns.map((col, colIndex) => {
                    const isActive = active?.rowKey === row.key && active.colKey === col.key;
                    const isEditing = editing?.cell.rowKey === row.key && editing.cell.colKey === col.key;
                    const text = row.cells[col.key] ?? '';
                    return (
                      <div
                        key={col.key}
                        role="gridcell"
                        aria-selected={isActive}
                        className={`inv-table__cell${STICKY.has(col.key) ? ' inv-table__stick' : ''}${isActive ? ' inv-table__cell--active' : ''}${col.editable && canEdit ? ' inv-table__cell--editable' : ''}`}
                        style={{ width: col.width }}
                        onClick={() => {
                          setActive({ rowKey: row.key, colKey: col.key });
                          // A click opens the row, except in an editable cell past the first column,
                          // which takes the click as "select it" so a double-click can edit.
                          if (colIndex === 0 || !(col.editable && canEdit)) onOpen(row);
                        }}
                        onDoubleClick={() => startEdit({ rowKey: row.key, colKey: col.key })}
                      >
                        {isEditing ? (
                          <CellEditor
                            col={col}
                            draft={editing!.draft}
                            onDraft={(d) => setEditing({ cell: editing!.cell, draft: d })}
                            onKeyDown={onEditorKey}
                            onBlur={(v) => {
                              commit(v);
                            }}
                          />
                        ) : col.type === 'tags' ? (
                          <TagCell tags={row.tags} onFilterTag={onFilterTag} />
                        ) : col.type === 'bar' && row.meter?.[col.key] !== undefined ? (
                          <span className="inv-table__meter" title={text}>
                            <span className="inv-table__bar" aria-hidden="true">
                              <span style={{ width: `${Math.min(100, Math.round(row.meter[col.key]! * 100))}%` }} />
                            </span>
                            <span className="inv-table__text">{text}</span>
                          </span>
                        ) : text !== '' && col.key === 'sheath' ? (
                          <span className="inv-table__text" title={text}>
                            <SheathWord name={text} />
                          </span>
                        ) : text !== '' ? (
                          <span className="inv-table__text" title={text}>
                            {text}
                          </span>
                        ) : (
                          <span className="inv-table__blank" aria-label="empty">
                            —
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {menu && columnMenu ? (
        <div ref={menuRef} className="inv-table__menu" style={{ left: menu.left, top: menu.top }}>
          {columnMenu(columns.find((c) => c.key === menu.key)!, () => setMenu(null))}
        </div>
      ) : null}
    </div>
  );
}

function TagCell({ tags, onFilterTag }: { tags: readonly string[]; onFilterTag?: (tag: string) => void }) {
  if (tags.length === 0) {
    return (
      <span className="inv-table__blank" aria-label="no tags">
        —
      </span>
    );
  }
  return (
    <span className="inv-table__tags">
      {tags.map((t) => (
        <button
          type="button"
          key={t}
          className="inv-table__tag"
          title={`Filter by ${t}`}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onFilterTag?.(t);
          }}
        >
          {t}
        </button>
      ))}
    </span>
  );
}

function CellEditor(props: {
  col: Column;
  draft: string;
  onDraft: (d: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onBlur: (value: string) => void;
}) {
  const { col, draft, onDraft, onKeyDown, onBlur } = props;
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (col.type === 'text' || col.type === 'number' || col.type === 'tags') ref.current?.setSelectionRange?.(draft.length, draft.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once, when the editor opens.
  }, []);
  if (col.type === 'select') {
    const options = col.options ?? [];
    return (
      <select
        ref={ref}
        className="inv-table__editor"
        value={draft}
        aria-label={col.label}
        onChange={(e) => onDraft(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onBlur={(e) => onBlur(e.currentTarget.value)}
      >
        <option value="" />
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      ref={ref}
      className="inv-table__editor"
      type={inputType(col)}
      value={draft}
      aria-label={col.label}
      placeholder={col.type === 'tags' ? 'tag, tag' : undefined}
      onChange={(e) => onDraft(e.currentTarget.value)}
      onKeyDown={onKeyDown}
      onBlur={(e) => onBlur(e.currentTarget.value)}
    />
  );
}
