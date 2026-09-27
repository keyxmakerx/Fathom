// ADR-0059, this session's brief item 3 — one chip component, used
// everywhere a tag is shown: the device, port, cable and rack editors
// (`drawing/Editor.tsx`) and VLAN rows, Docker networks and containers
// (`inventory/NetworksPanel.tsx`). Board panel 3
// (design/proposals/cables/cable-filter.dc.html): chips are ink, "Add tag"
// suggests existing tags as you type, Enter on a new name creates it.
//
// A read-only view (no `onAdd`/`onRemove`) shows the chips with no input and
// no remove control — ADR-0052 §5's "no action, not a disabled one",
// `drawing/Editor.tsx`'s `NotesSection` own convention. Clicking a chip's own
// name, when `onRename` is supplied, turns it into an inline rename field —
// decision 8's fourth undoable action, with no separate control the board
// does not draw.
import { useEffect, useId, useState, type CSSProperties, type KeyboardEvent } from 'react';
import './tagChips.css';

/** Inline, not a class: `.shell-editor button` (`styles/shell.css`) gives
 * every button inside an editor panel its own border and padding box —
 * "square, flat, one hairline" is right for "remove"/"Duplicate", wrong for
 * this plain "×" beside the chip's own single border. Inline wins over any
 * class regardless of specificity, `Editor.tsx`'s `SelectLink`/`LINK_STYLE`
 * own precedent ("Inline styles (segments, links) still win" — `shell.css`'s
 * own comment on that file's rule). Padding, not border/background, is what
 * keeps the same hit area a bordered box gave it. */
const REMOVE_STYLE: CSSProperties = {
  display: 'inline-block',
  border: 'none',
  background: 'none',
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
  /** Shown after the name, muted — a VLAN row's chip not every member
   * carries reads "2 of 3" rather than as plain as one every member has. */
  coverage?: string;
}

export interface TagSuggestion {
  name: string;
  count: number;
}

export interface TagChipsProps {
  tags: readonly TagChipItem[];
  /** Every tag in the design, not only the ones already on this object —
   * a suggestion offers what exists, `cable-filter.dc.html`'s own "existing
   * tags first." Omitted (or empty) reads as "nothing to suggest yet." */
  suggestions?: readonly TagSuggestion[];
  onAdd?: (name: string) => { refused: string } | void;
  onRemove?: (tagId: string) => { refused: string } | void;
  onRename?: (tagId: string, name: string) => { refused: string } | void;
}

/**
 * The suggestion list for `draft`, and which row Enter takes by default —
 * a pure function so this decision is unit-testable with no DOM. The
 * highlight starts on the typed name's OWN row: the existing tag when the
 * typed text equals one ignoring case, "new tag …" otherwise — never a mere
 * substring match, so Enter on a genuinely new name never silently tags an
 * unrelated existing one it happens to be a prefix of.
 */
export function matchSuggestions(
  draft: string,
  suggestions: readonly TagSuggestion[],
  attachedNames: ReadonlySet<string>,
): { filtered: TagSuggestion[]; showNewRow: boolean; defaultHighlight: number } {
  const query = draft.trim().toLowerCase();
  const filtered = query.length === 0 ? [] : suggestions.filter((s) => s.name.toLowerCase().includes(query) && !attachedNames.has(s.name.toLowerCase()));
  const exactMatchIndex = filtered.findIndex((s) => s.name.toLowerCase() === query);
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

  const attached = new Set(tags.map((t) => t.name.toLowerCase()));
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
