import { Fragment, useEffect, useRef, useState } from 'react';

import type { SearchHit } from './search';
import type { ShellSearch } from './types';

function MagnifierIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <circle cx="4.5" cy="4.5" r="3.5"></circle>
      <path d="M7.2 7.2 L10.5 10.5"></path>
    </svg>
  );
}

/** The bar's quick search (the owner's option A): type in the box, results drop beneath it. */
export function SearchBox({ search, collapsed }: { search: ShellSearch; collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const hits = open ? search.run(query) : [];

  function close() {
    setOpen(false);
    setQuery('');
    setActive(0);
  }

  function choose(hit: SearchHit) {
    close();
    search.choose(hit.selection);
  }

  // Ctrl K (Cmd K on a Mac) opens it from anywhere.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    function onDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        className={collapsed ? 'shell-search shell-search--collapsed' : 'shell-search'}
        aria-label="Search"
        onClick={() => setOpen(true)}
      >
        <MagnifierIcon />
        {!collapsed && (
          <>
            <span className="shell-search__label">Search</span>
            <span className="shell-search__spacer" />
            <span className="shell-search__shortcut">Ctrl K</span>
          </>
        )}
      </button>
    );
  }

  return (
    <div className="shell-search shell-search--open" ref={rootRef}>
      <MagnifierIcon />
      <input
        className="shell-search__input"
        aria-label="Search this design"
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((i) => Math.min(i + 1, hits.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (event.key === 'Enter' && hits[active]) {
            event.preventDefault();
            choose(hits[active]);
          }
        }}
      />
      {query.trim() !== '' && (
        <div className="shell-search__results" role="listbox" aria-label="Search results">
          {hits.length === 0 && <div className="shell-search__none">Nothing in this design matches.</div>}
          {hits.map((hit, i) => (
            <Fragment key={`${hit.selection.kind}:${hit.selection.id}`}>
              {(i === 0 || hits[i - 1].group !== hit.group) && <div className="shell-search__group">{hit.group}</div>}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={i === active ? 'shell-search__row shell-search__row--on' : 'shell-search__row'}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(hit)}
              >
                <span className="shell-search__name">{hit.name}</span>
                <span className="shell-search__why">{hit.why}</span>
              </button>
            </Fragment>
          ))}
          <div className="shell-search__foot">
            <span>↑ ↓ move</span>
            <span>Enter go</span>
            <span>Esc close</span>
            <span className="shell-search__scope">this design only</span>
          </div>
        </div>
      )}
    </div>
  );
}
