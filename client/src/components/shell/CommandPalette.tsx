import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../ui/EmptyState';
import { createPortal } from 'react-dom';

import { firstEnabled, matchActions, moveActive, type PaletteAction } from './palette';
import type { SearchHit } from './search';
import type { ShellSearch } from './types';
import '../../styles/palette.css';

type Entry = { kind: 'action'; action: PaletteAction } | { kind: 'thing'; hit: SearchHit };

const GROUP_WORD: Record<SearchHit['group'], string> = {
  Devices: 'Device',
  Racks: 'Rack',
  Ports: 'Port',
  Cables: 'Cable',
  VLANs: 'VLAN',
  Containers: 'Container',
};

/**
 * Ctrl+K: one box that finds things in the design and runs actions. A frosted sheet near the top.
 * Arrow keys move over what can be chosen, Enter runs it, Esc closes.
 */
export function CommandPalette({ search, onClose }: { search: ShellSearch; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // The actions are asked for fresh each time the sheet opens, so they reflect what is selected now.
  const allActions = useMemo(() => search.actions?.() ?? [], [search]);
  const actions = useMemo(() => matchActions(allActions, query), [allActions, query]);
  const things = useMemo(() => (query.trim() === '' ? [] : search.run(query)), [search, query]);
  const entries = useMemo<Entry[]>(
    () => [...actions.map((action): Entry => ({ kind: 'action', action })), ...things.map((hit): Entry => ({ kind: 'thing', hit }))],
    [actions, things],
  );
  const enabled = useMemo(() => entries.map((e) => e.kind === 'thing' || e.action.disabled === undefined), [entries]);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  // A new set of rows starts on the first one that can be chosen.
  const rowsKey = `${query}|${entries.length}|${enabled.map(Number).join('')}`;
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
      event.preventDefault(); // the box is the one thing to focus; the list is moved with the arrows
    }
  }

  const rowId = (i: number) => `${listId}-row-${i}`;
  const thingStart = actions.length;
  const nothing = query.trim() !== '' && entries.length === 0;

  return createPortal(
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
        </div>
        <div className="palette__list" id={listId} role="listbox" aria-label="Results">
          {actions.length > 0 && <div className="palette__group" role="presentation">Actions</div>}
          {entries.map((entry, i) => {
            const on = i === active;
            const heading = entry.kind === 'thing' && i === thingStart ? <div className="palette__group" role="presentation" key={`h-${i}`}>Things</div> : null;
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
                      <span className="palette__name">{entry.action.label}</span>
                      <span className="palette__why">{entry.action.disabled ?? ''}</span>
                      {entry.action.hint ? <kbd className="palette__hint">{entry.action.hint}</kbd> : null}
                    </>
                  ) : (
                    <>
                      <span className="palette__name palette__name--mono">{entry.hit.name}</span>
                      <span className="palette__why">{entry.hit.why}</span>
                      <span className="palette__tag">{GROUP_WORD[entry.hit.group]}</span>
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
        <div className="palette__foot" aria-hidden="true">
          <span>↑ ↓ move</span>
          <span>Enter run</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
