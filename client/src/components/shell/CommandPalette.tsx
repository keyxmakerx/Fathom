import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../ui/EmptyState';
import { createPortal } from 'react-dom';

import { cycleGroup, firstEnabled, highlightParts, matchActions, moveActive, noteOf, type PaletteAction } from './palette';
import type { SearchHit } from './search';
import type { ShellSearch } from './types';
import '../../styles/palette.css';

type Entry = ({ kind: 'action'; action: PaletteAction } | { kind: 'thing'; hit: SearchHit }) & { group: string };

/** The heading over each group: what was found (Devices first), then what to do, then where to go. */
const ACTION_GROUP = { do: 'Do', go: 'Go to' } as const;

/** A label with the letters that were typed underlined. */
function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.hit ? (
          <span className="palette__hit" key={i}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * Ctrl+K: one box that finds things in the design and runs actions. A frosted sheet near the top.
 * Arrow keys move over what can be chosen, Enter runs it, Esc closes.
 */
export function CommandPalette(props: { search: ShellSearch; onClose: () => void }) {
  return createPortal(<PaletteSheet {...props} />, document.body);
}

/** The sheet itself, apart from where it is mounted. */
export function PaletteSheet({ search, onClose, initialQuery = '' }: { search: ShellSearch; onClose: () => void; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [narrow, setNarrow] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // The actions are asked for fresh each time the sheet opens, so they reflect what is selected now.
  const allActions = useMemo(() => search.actions?.() ?? [], [search]);
  const actions = useMemo(() => matchActions(allActions, query), [allActions, query]);
  const things = useMemo(() => (query.trim() === '' ? [] : search.run(query)), [search, query]);
  const everything = useMemo<Entry[]>(
    () => [
      ...things.map((hit): Entry => ({ kind: 'thing', hit, group: hit.group })),
      ...actions.filter((a) => a.group !== 'go').map((action): Entry => ({ kind: 'action', action, group: ACTION_GROUP.do })),
      ...actions.filter((a) => a.group === 'go').map((action): Entry => ({ kind: 'action', action, group: ACTION_GROUP.go })),
    ],
    [actions, things],
  );
  const groups = useMemo(() => [...new Set(everything.map((e) => e.group))], [everything]);
  // Tab narrows to one group; a group with nothing left in it counts as all.
  const narrowed = narrow !== null && groups.includes(narrow) ? narrow : null;
  const entries = useMemo(() => (narrowed === null ? everything : everything.filter((e) => e.group === narrowed)), [everything, narrowed]);
  const enabled = useMemo(() => entries.map((e) => e.kind === 'thing' || e.action.disabled === undefined), [entries]);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  // A new set of rows starts on the first one that can be chosen.
  const rowsKey = `${query}|${narrowed ?? ''}|${entries.length}|${enabled.map(Number).join('')}`;
  useEffect(() => {
    setActive(Math.max(0, firstEnabled(enabled)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what the rows are, not on their object identity.
  }, [rowsKey]);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  function choose(entry: Entry | undefined) {
    if (entry === undefined) return;
    if (entry.kind === 'action') {
      if (entry.action.disabled !== undefined) return;
      const run = entry.action.run;
      onClose();
      // After the sheet has gone and given focus back, so the action may take it.
      window.setTimeout(run, 0);
      return;
    }
    onClose();
    search.choose(entry.hit.selection);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => moveActive(enabled, i, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => moveActive(enabled, i, -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(entries[active]);
    } else if (event.key === 'Tab') {
      event.preventDefault(); // the box is the one thing to focus; Tab narrows to one group and back
      setNarrow(cycleGroup(groups, narrowed, event.shiftKey ? -1 : 1));
    }
  }

  const rowId = (i: number) => `${listId}-row-${i}`;
  const showShortcuts = allActions.find((a) => a.id === 'shortcuts');
  const nothing = query.trim() !== '' && entries.length === 0;

  return (
    <div className="float-scrim float-scrim--top" onPointerDown={onClose}>
      <div className="float-sheet palette" role="dialog" aria-modal="true" aria-label="Find or do anything" onPointerDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="palette__box">
          <svg className="palette__icon" width="14" height="14" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
            <circle cx="4.5" cy="4.5" r="3.5" />
            <path d="M7.2 7.2 L10.5 10.5" />
          </svg>
          <input
            ref={inputRef}
            className="palette__input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={entries.length > 0 ? rowId(active) : undefined}
            aria-label="Find a device, rack, port or cable, or run a command"
            placeholder="Find a device, rack, port, cable or address, or type a command"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd className="palette__esc" aria-hidden="true">
            Esc
          </kbd>
        </div>
        <div className="palette__list" id={listId} role="listbox" aria-label="Results">
          {entries.map((entry, i) => {
            const on = i === active;
            const heading = i === 0 || entries[i - 1]!.group !== entry.group ? <div className="palette__group" role="presentation">{entry.group}</div> : null;
            const disabled = entry.kind === 'action' && entry.action.disabled !== undefined;
            return (
              <div key={entry.kind === 'action' ? `a-${entry.action.id}` : `t-${entry.hit.group}:${entry.hit.selection.kind}:${entry.hit.selection.id}:${entry.hit.name}`} role="presentation">
                {heading}
                <button
                  type="button"
                  id={rowId(i)}
                  ref={on ? activeRef : undefined}
                  tabIndex={-1}
                  role="option"
                  aria-selected={on}
                  aria-disabled={disabled || undefined}
                  className={['palette__row', on ? 'palette__row--on' : '', disabled ? 'palette__row--disabled' : ''].filter(Boolean).join(' ')}
                  onMouseMove={() => enabled[i] && setActive(i)}
                  onClick={() => choose(entry)}
                >
                  {entry.kind === 'action' ? (
                    <>
                      <span className="palette__name">
                        <Marked text={entry.action.label} query={query} />
                      </span>
                      <span className="palette__why">{entry.action.disabled ?? ''}</span>
                      {on && !disabled ? <span className="palette__enter">{entry.action.group === 'go' ? 'Enter to open' : 'Enter to run'}</span> : entry.action.hint ? <kbd className="palette__hint">{entry.action.hint}</kbd> : null}
                    </>
                  ) : (
                    <>
                      <span className="palette__name palette__name--mono">
                        <Marked text={entry.hit.name} query={query} />
                      </span>
                      <span className="palette__why">{noteOf(entry.hit)}</span>
                      {on ? <span className="palette__enter">Enter to open</span> : null}
                    </>
                  )}
                </button>
              </div>
            );
          })}
          {nothing && (
            <EmptyState className="palette__none" title="Nothing in this design matches." compact>
              Try a device name, a rack, an address or a tag.
            </EmptyState>
          )}
        </div>
        <div className="palette__foot">
          <span className="palette__keys" aria-hidden="true">
            <span>↑↓ move</span>
            <span>Enter go</span>
            <span>{narrowed !== null ? `Tab shows only ${narrowed}` : 'Tab narrow to one group'}</span>
          </span>
          {showShortcuts !== undefined ? (
            <button
              type="button"
              className="palette__more"
              tabIndex={-1}
              onClick={() => {
                onClose();
                window.setTimeout(showShortcuts.run, 0);
              }}
            >
              ? all shortcuts
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
