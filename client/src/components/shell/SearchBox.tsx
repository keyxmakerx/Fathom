import { useEffect, useState } from 'react';

import { CommandPalette } from './CommandPalette';
import { matches } from './shortcuts';
import type { ShellSearch } from './types';

function MagnifierIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <circle cx="4.5" cy="4.5" r="3.5"></circle>
      <path d="M7.2 7.2 L10.5 10.5"></path>
    </svg>
  );
}

/** The bar's search button. It opens the command palette: find things in the design, or run a command. */
export function SearchBox({ search, collapsed }: { search: ShellSearch; collapsed: boolean }) {
  const [open, setOpen] = useState(false);

  // Ctrl K (Cmd K on a Mac) opens it from anywhere, and closes it again.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (matches(event, 'find')) {
        event.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        className={collapsed ? 'shell-search shell-search--collapsed' : 'shell-search'}
        aria-label="Search"
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
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
      {open && <CommandPalette search={search} onClose={() => setOpen(false)} />}
    </>
  );
}
