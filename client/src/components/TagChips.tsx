// ADR-0059: the one tag chip component. Without `onAdd` and `onRemove` it is read-only;
// with `onRename`, clicking a chip's name renames it inline.
import { useEffect, useId, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { foldTagName } from '../document/tags';
import './tagChips.css';

/** Inline, because `.shell-editor button` (`styles/shell.css`) would otherwise give the ×
 * a border and padding, and an inline style wins over any class. */
const REMOVE_STYLE: CSSProperties = {
  display: 'inline-block',
  border: 'none',
  background: 'none',
  boxShadow: 'none',
  color: 'var(--ink)',
  font: 'inherit',
  fontSize: 'var(--t-small)',
  lineHeight: '15px',
  padding: '0 2px',
  cursor: 'pointer',
  flexShrink: 0,
};

export interface TagChipItem {
  id: string;
  name: string;
  /** Shown muted after the name: "2 of 3" on a VLAN row's chip that not every member carries. */
  coverage?: string;
}

export interface TagSuggestion {
  name: string;
  count: number;
}

export interface TagChipsProps {
  tags: readonly TagChipItem[];
  /** Every tag in the design, offered as the user types. */
  suggestions?: readonly TagSuggestion[];
  onAdd?: (name: string) => { refused: string } | void;
  onRemove?: (tagId: string) => { refused: string } | void;
  onRename?: (tagId: string, name: string) => { refused: string } | void;
}

/** The suggestions for `draft`, compared by `foldTagName`, and the row Enter takes by default:
 * the existing tag the typed name folds to, otherwise "new tag …", never a longer match. */
export function matchSuggestions(
  draft: string,
  suggestions: readonly TagSuggestion[],
  attachedNames: ReadonlySet<string>,
): { filtered: TagSuggestion[]; showNewRow: boolean; defaultHighlight: number } {
  const query = foldTagName(draft.trim().replace(/\s+/g, ' '));
  const filtered = query.length === 0 ? [] : suggestions.filter((s) => foldTagName(s.name).includes(query) && !attachedNames.has(foldTagName(s.name)));
  const exactMatchIndex = filtered.findIndex((s) => foldTagName(s.name) === query);
  const showNewRow = query.length > 0 && exactMatchIndex < 0;
  const defaultHighlight = exactMatchIndex >= 0 ? exactMatchIndex : filtered.length;
  return { filtered, showNewRow, defaultHighlight };
}

export function TagChips({ tags, suggestions = [], onAdd, onRemove, onRename }: TagChipsProps) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);

  function commitRename() {
    if (!renaming || !onRename) return;
    const trimmed = renaming.draft.trim();
    if (trimmed.length === 0) {
      setRenaming(null);
      return;
    }
    const result = onRename(renaming.id, trimmed);
    if (result?.refused) {
      setRefusal(result.refused);
      return;
    }
    setRefusal(null);
    setRenaming(null);
  }

  const attached = new Set(tags.map((t) => foldTagName(t.name)));
  const { filtered, showNewRow, defaultHighlight } = matchSuggestions(draft, suggestions, attached);
  const listboxId = useId();

  useEffect(() => {
    setHighlight(defaultHighlight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  function commit(name: string) {
    const trimmed = name.trim();
    if (trimmed.length === 0 || !onAdd) return;
    const result = onAdd(trimmed);
    if (result?.refused) {
      setRefusal(result.refused);
      return;
    }
    setRefusal(null);
    setDraft('');
    setOpen(false);
    setHighlight(0);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const rowCount = filtered.length + (showNewRow ? 1 : 0);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rowCount > 0) setHighlight((h) => Math.min(h + 1, rowCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rowCount > 0) setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlight < filtered.length) commit(filtered[highlight]!.name);
      else commit(draft);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="tag-chips">
      <div className="tag-chips__list">
        {tags.length === 0 && !onAdd ? <span className="tag-chips__empty">—</span> : null}
        {tags.map((t) =>
          renaming?.id === t.id ? (
            <input
              key={t.id}
              autoFocus
              className="tag-chip tag-chip__rename"
              aria-label={`rename tag ${t.name}`}
              value={renaming.draft}
              onChange={(e) => setRenaming({ id: t.id, draft: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                else if (e.key === 'Escape') setRenaming(null);
              }}
              onBlur={commitRename}
            />
          ) : (
            <span key={t.id} className="tag-chip">
              <span
                className={onRename ? 'tag-chip__name tag-chip__name--editable' : 'tag-chip__name'}
                title={t.name}
                onClick={onRename ? () => setRenaming({ id: t.id, draft: t.name }) : undefined}
              >
                {t.name}
              </span>
              {t.coverage ? <span className="tag-chip__coverage">{t.coverage}</span> : null}
              {onRemove ? (
                <button type="button" style={REMOVE_STYLE} aria-label={`remove tag ${t.name}`} onClick={() => onRemove(t.id)}>
                  ×
                </button>
              ) : null}
            </span>
          ),
        )}
      </div>
      {onAdd ? (
        <div className="tag-chips__add">
          <input
            type="text"
            className="tag-chips__input"
            placeholder="+ Add tag"
            aria-label="Add tag"
            role="combobox"
            aria-expanded={open && (filtered.length > 0 || showNewRow)}
            aria-controls={listboxId}
            aria-activedescendant={open ? `${listboxId}-${highlight}` : undefined}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
              setRefusal(null);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
          {open && (filtered.length > 0 || showNewRow) ? (
            <div className="tag-chips__suggestions" role="listbox" id={listboxId}>
              {filtered.map((s, i) => (
                <div
                  key={s.name}
                  id={`${listboxId}-${i}`}
                  role="option"
                  aria-selected={i === highlight}
                  className={'tag-chips__suggestion' + (i === highlight ? ' tag-chips__suggestion--on' : '')}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(s.name);
                  }}
                >
                  <span>{s.name}</span>
                  <span className="tag-chips__suggestion-count">{s.count}</span>
                </div>
              ))}
              {showNewRow ? (
                <div
                  id={`${listboxId}-${filtered.length}`}
                  role="option"
                  aria-selected={highlight === filtered.length}
                  className={
                    'tag-chips__suggestion tag-chips__suggestion--new' +
                    (highlight === filtered.length ? ' tag-chips__suggestion--on' : '')
                  }
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(draft);
                  }}
                >
                  <span>new tag &ldquo;{draft.trim()}&rdquo;</span>
                  <span className="tag-chips__suggestion-count">Enter</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {refusal != null ? <div className="tag-chips__refusal">{refusal}</div> : null}
    </div>
  );
}
