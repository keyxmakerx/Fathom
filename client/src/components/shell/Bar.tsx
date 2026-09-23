import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { signOut } from '../../api/auth';
import { applyTheme, getStoredTheme } from '../../theme';
import type { Theme } from '../../theme';
import { searchShouldCollapse } from './layout';
import { LENSES_IN, LENS_LABEL } from './lens';
import type { Lens } from './lens';
import { Popover, PopoverRow } from './Popover';
import { pathToItems } from './path';
import type { PathPart } from './path';
import { SearchBox } from './SearchBox';
import type { AccountInfo, Place, PresenceUser, ShellSearch } from './types';

// BRIEF.md "The bar": "a hairline-bordered box ~180px". The magnifier alone
// (the collapsed state) is a 24px square — see `.shell-search--collapsed`.
const SEARCH_EXPANDED_WIDTH = 180;
// The bar's own `gap` (BRIEF.md's groups are separated by a hairline, but
// the flex gap on either side of the search box is unadorned space) — two
// of these sit between the fixed groups and the search box.
const BAR_GAP = 12;

const THEME_LABEL: Record<'system' | Theme, string> = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

const THEME_NEXT: Record<'system' | Theme, 'system' | Theme> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export interface BarProps {
  place: Place | null;
  onPlaceChange: (place: Place) => void;
  path: PathPart[];
  tree: ReactNode;
  lens: Lens;
  onLensChange: (lens: Lens) => void;
  presence: PresenceUser[];
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Fits the drawing into view; the percentage is the button. */
  onZoomFit?: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  account: AccountInfo;
  /** ADR-0052 §5 — the open design's `capability` is `'read'`
   * (`RacksPlace.tsx`'s `canDraw`, negated). Renders the "view only" chip
   * beside the undo/redo pair; absent everywhere there is nothing to be
   * read-only about (Home, or a writable design). */
  viewOnly?: boolean;
  /** Where the brand goes: Home. Omitted on Home itself. */
  onHome?: () => void;
  /** Quick search; the box is absent without it. */
  search?: ShellSearch;
  /** The caller's own account-menu rows (Site, credentials, Home), above
   * Theme and Sign out. A row is present only when it acts. */
  menu?: ReactNode;
}

/** The bar — BRIEF.md "The bar": one row, 44px, a 3px ink rule beneath, and
 * nothing else above the drawing. */
export function Bar({
  place,
  onPlaceChange,
  path,
  tree,
  lens,
  onLensChange,
  presence,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  account,
  viewOnly,
  onHome,
  menu,
  search,
}: BarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  const [themeMode, setThemeMode] = useState<'system' | Theme>(() => getStoredTheme() ?? 'system');

  // BRIEF.md "The bar": "if it will not fit 1440, search collapses to the
  // magnifier alone before anything else gives." Real behaviour, not a
  // fixed choice: measured against whatever width the bar actually has.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const leading = leadingRef.current;
    const trailing = trailingRef.current;
    if (!container || !leading || !trailing) {
      return undefined;
    }

    function measure() {
      if (!container || !leading || !trailing) {
        return;
      }
      const containerWidth = container.clientWidth;
      const fixedWidth = leading.getBoundingClientRect().width + trailing.getBoundingClientRect().width + BAR_GAP * 2;
      setSearchCollapsed(
        searchShouldCollapse({ containerWidth, fixedWidth, searchExpandedWidth: SEARCH_EXPANDED_WIDTH }),
      );
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [path, lens, presence, account, zoom]);

  function cycleTheme() {
    const next = THEME_NEXT[themeMode];
    setThemeMode(next);
    applyTheme(next === 'system' ? null : next);
  }

  async function handleSignOut() {
    await signOut();
  }

  const pathItems = pathToItems(path);

  return (
    <div className="shell-bar" ref={containerRef}>
      <div className="shell-bar__leading" ref={leadingRef}>
        {onHome ? (
          <button type="button" className="shell-bar__brand" onClick={onHome}>
            Fathom
          </button>
        ) : (
          <span className="shell-bar__brand">Fathom</span>
        )}
        <Sep />
        {/* With no design open (Home, Site) the two places are named but are
            not controls: a place needs a design, and Home is where you pick
            one. */}
        <div className="shell-bar__tabs">
          {place === null ? (
            <>
              <span className="shell-bar__tab">Racks</span>
              <span className="shell-bar__tab">Inventory</span>
            </>
          ) : (
            <>
              <button
                type="button"
                className={place === 'racks' ? 'shell-bar__tab shell-bar__tab--on' : 'shell-bar__tab'}
                onClick={() => onPlaceChange('racks')}
              >
                Racks
              </button>
              <button
                type="button"
                className={place === 'inventory' ? 'shell-bar__tab shell-bar__tab--on' : 'shell-bar__tab'}
                onClick={() => onPlaceChange('inventory')}
              >
                Inventory
              </button>
            </>
          )}
        </div>
        <Sep />
        <Popover
          align="left"
          renderTrigger={({ toggle, triggerRef, triggerProps }) => (
            <div className="shell-bar__path">
              {pathItems.length === 0 && <span className="shell-bar__path-empty">Home</span>}
              {pathItems.map((item, index) => (
                <span className="shell-bar__path-part" key={`${item.label}-${index}`}>
                  {index > 0 && (
                    <span className="shell-bar__path-sep" aria-hidden="true">
                      &rsaquo;
                    </span>
                  )}
                  <button
                    type="button"
                    className={
                      item.current
                        ? 'shell-bar__path-label shell-bar__path-label--current'
                        : 'shell-bar__path-label'
                    }
                    aria-haspopup={triggerProps['aria-haspopup']}
                    aria-expanded={triggerProps['aria-expanded']}
                    aria-controls={triggerProps['aria-controls']}
                    onClick={(event) => {
                      triggerRef.current = event.currentTarget;
                      item.onSelect?.();
                      toggle();
                    }}
                  >
                    {item.label}
                  </button>
                </span>
              ))}
            </div>
          )}
        >
          {tree}
        </Popover>
        {/* A lens is what is drawn on top of the drawing's boxes, so it
            belongs to the camera and not to every screen. On Home
            (`place === null`) there is nothing for a lens to act on, and
            the approved Home board carries no lens row — the same reason
            the People and Site boards carry no zoom. ADR-0047 §1. */}
        {place !== null && (
          <>
            <Sep />
            <div className="shell-bar__lenses">
              {LENSES_IN[place].map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={candidate === lens}
                  className={candidate === lens ? 'shell-lens shell-lens--on' : 'shell-lens'}
                  onClick={() => onLensChange(candidate)}
                >
                  {LENS_LABEL[candidate]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="shell-bar__spacer" />

      {search && <SearchBox search={search} collapsed={searchCollapsed} />}

      <div className="shell-bar__trailing" ref={trailingRef}>
        {presence.length > 0 && (
          <>
            <div className="shell-bar__presence">
              {presence.map((person) => (
                <span className="shell-chip" key={person.id}>
                  {person.name}
                </span>
              ))}
            </div>
            <Sep />
          </>
        )}

        {/* ADR-0052 §5: "view only" reads with the same plain hairline chip
            as everything else in this group — UI-SPEC "Look" reserves
            colour for an error, a warning, a recommendation or a
            confirmation, and this is none of those, only a fact about the
            open design. */}
        {viewOnly === true && (
          <>
            <span className="shell-chip" aria-label="view only">
              View only
            </span>
            <Sep />
          </>
        )}

        {/* Undo and Redo act on an open design; zoom acts on the drawing,
            so it is Racks only (Inventory is lists). */}
        {place !== null && (
          <>
            <div className="shell-bar__undoredo">
              <button type="button" className="shell-chip shell-chip--ink" disabled={!canUndo} onClick={onUndo}>
                Undo
              </button>
              <button type="button" className="shell-chip shell-chip--ink" disabled={!canRedo} onClick={onRedo}>
                Redo
              </button>
            </div>
            <Sep />
          </>
        )}
        {place === 'racks' && (
          <>
            <div className="shell-bar__zoom">
              <button type="button" className="shell-zoom-btn" aria-label="Zoom out" onClick={onZoomOut}>
                &minus;
              </button>
              {onZoomFit ? (
                <button type="button" className="shell-zoom-value" aria-label="Fit to view" onClick={onZoomFit}>
                  {zoom}%
                </button>
              ) : (
                <span className="shell-zoom-value">{zoom}%</span>
              )}
              <button type="button" className="shell-zoom-btn" aria-label="Zoom in" onClick={onZoomIn}>
                +
              </button>
            </div>
            <Sep />
          </>
        )}
        <Popover
          align="right"
          renderTrigger={({ toggle, triggerRef, triggerProps }) => (
            <button
              type="button"
              className="shell-account"
              ref={(node) => {
                triggerRef.current = node;
              }}
              aria-label="Account menu"
              aria-haspopup={triggerProps['aria-haspopup']}
              aria-expanded={triggerProps['aria-expanded']}
              aria-controls={triggerProps['aria-controls']}
              onClick={toggle}
            >
              {account.initials}
            </button>
          )}
        >
          {menu}
          <PopoverRow onSelect={cycleTheme}>{THEME_LABEL[themeMode]}</PopoverRow>
          <PopoverRow onSelect={handleSignOut}>Sign out</PopoverRow>
        </Popover>
      </div>
    </div>
  );
}

function Sep() {
  return (
    <span className="shell-bar__sep-wrap">
      <span className="shell-bar__sep" aria-hidden="true" />
    </span>
  );
}
