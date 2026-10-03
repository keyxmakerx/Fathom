import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { signOut } from '../../api/auth';
import { applyTheme, getStoredTheme } from '../../theme';
import type { Theme } from '../../theme';
import { searchShouldCollapse } from './layout';
import { DIAGRAM_STYLES, DIAGRAM_STYLE_LABEL, type DiagramStyle } from '../drawing/diagramStyle';
import { LAYERS, type LayerId, type LayerSet } from '../drawing/layers';
import { LOOKS, LOOK_LABEL, type Look } from '../drawing/look';
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
  /** The Rack | Diagram switch; omitted where the look does not apply. */
  look?: { value: Look; onChange: (look: Look) => void };
  /** The Show ▾ menu of canvas layers; omitted where there is no canvas. */
  layers?: { value: LayerSet; onToggle: (id: LayerId) => void; style?: { value: DiagramStyle; onChange: (style: DiagramStyle) => void } };
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
  /** The Print button beside Undo/Redo; absent with no design open. */
  onPrint?: () => void;
  /** The Share button; present only for someone who may share (a steward). */
  onShare?: () => void;
  /** The Docs button: the design's docs list. */
  onDocs?: () => void;
  /** The History button: the design's saves beside the canvas. */
  onHistory?: () => void;
  historyOpen?: boolean;
  account: AccountInfo;
  /** ADR-0052 §5 — the open design's `capability` is `'read'`
   * (`RacksPlace.tsx`'s `canDraw`, negated). Renders the "view only" chip
   * beside the undo/redo pair; absent everywhere there is nothing to be
   * read-only about (Home, or a writable design). */
  viewOnly?: boolean;
  /** A chip before Undo (the Checks count). */
  barExtra?: ReactNode;
  /** Where the brand goes: Home. Omitted on Home itself. */
  onHome?: () => void;
  /** Quick search; the box is absent without it. */
  search?: ShellSearch;
  /** The caller's own account-menu rows (Site, credentials, Home), above
   * Theme and Sign out. A row is present only when it acts. */
  menu?: ReactNode;
  /** The amber Admin pill beside the account square (display only). */
  adminPill?: { current?: boolean; onSelect?: () => void };
  /** The Cables list, hanging from the Cables lens: absent everywhere but
   * the Racks place. The lens shows a ▾ while lit, and a click while it is
   * ALREADY lit opens this as a popover; a click while some other lens is
   * lit only switches to Cables, the same as every other lens button. */
  cablesGroupsPopover?: ReactNode;
  /** While anything is filtered, the lens reads "Cables · 5 of 38."
   * `null`/absent leaves the lens reading plain "Cables". */
  cablesGroupsSummary?: string | null;
  /** The bar shows "3 hidden · show" in the Racks place while any cable in
   * this closet is hidden one at a time. Zero or absent renders nothing. */
  hiddenCablesCount?: number;
  onShowAllHiddenCables?: () => void;
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
  look,
  layers,
  presence,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPrint,
  onShare,
  onDocs,
  onHistory,
  historyOpen,
  account,
  viewOnly,
  barExtra,
  onHome,
  menu,
  adminPill,
  search,
  cablesGroupsPopover,
  cablesGroupsSummary,
  hiddenCablesCount,
  onShowAllHiddenCables,
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
              <span className="shell-bar__tab">Canvas</span>
              <span className="shell-bar__tab">Inventory</span>
            </>
          ) : (
            <>
              <button
                type="button"
                className={place === 'racks' ? 'shell-bar__tab shell-bar__tab--on' : 'shell-bar__tab'}
                onClick={() => onPlaceChange('racks')}
              >
                Canvas
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
        {/* Others in this view: a round dot with their initials; the full name is its label. */}
        {presence.length > 0 && (
          <div className="shell-bar__people" role="group" aria-label="Also in this view">
            {presence.map((person) => (
              <span className="shell-person" key={person.id} role="img" tabIndex={0} aria-label={person.name} title={person.name}>
                {person.initials}
              </span>
            ))}
          </div>
        )}
        {/* A lens is what is drawn on top of the drawing's boxes, so it
            belongs to the camera and not to every screen. On Home
            (`place === null`) there is nothing for a lens to act on, and
            the approved Home board carries no lens row — the same reason
            the People and Site boards carry no zoom. ADR-0047 §1. */}
        {place !== null && (
          <>
            <Sep />
            <div className="shell-bar__lenses">
              {LENSES_IN[place].map((candidate) =>
                candidate === 'cables' && cablesGroupsPopover != null ? (
                  <Popover
                    key={candidate}
                    align="left"
                    renderTrigger={({ toggle, triggerRef, triggerProps }) => (
                      <button
                        type="button"
                        aria-pressed={candidate === lens}
                        className={candidate === lens ? 'shell-lens shell-lens--on' : 'shell-lens'}
                        aria-haspopup={triggerProps['aria-haspopup']}
                        aria-expanded={candidate === lens ? triggerProps['aria-expanded'] : false}
                        aria-controls={triggerProps['aria-controls']}
                        onClick={(event) => {
                          triggerRef.current = event.currentTarget;
                          // Clicking the Cables lens while it is lit opens
                          // the list; while it is some other lens's turn, a
                          // click only switches to Cables, the same as any
                          // other lens button — it never also opens the
                          // popover in the same click.
                          if (candidate !== lens) {
                            onLensChange(candidate);
                            return;
                          }
                          toggle();
                        }}
                      >
                        {LENS_LABEL[candidate]}
                        {cablesGroupsSummary != null && ` · ${cablesGroupsSummary}`}
                        {candidate === lens && (
                          <span className="shell-lens__caret" aria-hidden="true">
                            {' '}
                            ▾
                          </span>
                        )}
                      </button>
                    )}
                  >
                    {cablesGroupsPopover}
                  </Popover>
                ) : (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={candidate === lens}
                    className={candidate === lens ? 'shell-lens shell-lens--on' : 'shell-lens'}
                    onClick={() => onLensChange(candidate)}
                  >
                    {LENS_LABEL[candidate]}
                  </button>
                ),
              )}
            </div>
            {look != null && <Sep />}
            {look != null && (
              <div className="shell-bar__lenses" role="group" aria-label="Look">
                {LOOKS.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={candidate === look.value}
                    className={candidate === look.value ? 'shell-lens shell-lens--on' : 'shell-lens'}
                    onClick={() => look.onChange(candidate)}
                  >
                    {LOOK_LABEL[candidate]}
                  </button>
                ))}
              </div>
            )}
            {hiddenCablesCount != null && hiddenCablesCount > 0 && (
              <>
                <Sep />
                <span className="shell-chip shell-bar__hidden-chip" data-testid="shell-hidden-cables-chip">
                  {hiddenCablesCount} hidden ·{' '}
                  <button type="button" className="shell-chip__link" onClick={onShowAllHiddenCables}>
                    show
                  </button>
                </span>
              </>
            )}
            {layers != null && <Sep />}
            {layers != null && (
              <Popover
                renderTrigger={({ open, triggerProps, triggerRef }) => (
                  <button
                    type="button"
                    className={open ? 'shell-lens shell-lens--on' : 'shell-lens'}
                    data-testid="shell-show"
                    ref={(el) => {
                      triggerRef.current = el;
                    }}
                    {...triggerProps}
                  >
                    Show ▾
                  </button>
                )}
              >
                <div className="shell-show" role="group" aria-label="Show on the drawing">
                  <div className="shell-show__head">Show on the drawing</div>
                  {LAYERS.filter((l) => l.available).map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={layers.value[l.id]}
                      className="shell-show__row"
                      data-testid={`show-${l.id}`}
                      onClick={() => layers.onToggle(l.id)}
                    >
                      <span aria-hidden="true">{layers.value[l.id] ? '☑' : '☐'}</span>
                      <span>{l.label}</span>
                      {l.onByDefault && <span className="shell-show__note">on by default</span>}
                    </button>
                  ))}
                  {look?.value === 'rack' && <p className="shell-show__hint">The words and icons are drawn in the Diagram look.</p>}
                  <p className="shell-show__hint">Each layer adds words in ink, placed so they never overlap. Yours, per browser.</p>
                  {layers.style != null && (
                    <div className="shell-show__style" role="group" aria-label="Device style">
                      <span className="shell-show__head">Device style</span>
                      {DIAGRAM_STYLES.map((st) => (
                        <button
                          key={st}
                          type="button"
                          role="menuitemradio"
                          aria-checked={layers.style!.value === st}
                          className={layers.style!.value === st ? 'shell-lens shell-lens--on' : 'shell-lens'}
                          data-testid={`style-${st}`}
                          onClick={() => layers.style!.onChange(st)}
                        >
                          {DIAGRAM_STYLE_LABEL[st]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Popover>
            )}
          </>
        )}
      </div>

      <div className="shell-bar__spacer" />

      {search && <SearchBox search={search} collapsed={searchCollapsed} />}

      <div className="shell-bar__trailing" ref={trailingRef}>
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

        {barExtra != null && (
          <>
            {barExtra}
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
        {onDocs && (
          <>
            <button type="button" className="shell-chip shell-chip--ink" onClick={onDocs} data-testid="shell-docs">
              Docs
            </button>
            <Sep />
          </>
        )}
        {onHistory && (
          <>
            <button
              type="button"
              className="shell-chip shell-chip--ink"
              aria-pressed={historyOpen ?? false}
              onClick={onHistory}
              data-testid="shell-history"
            >
              History
            </button>
            <Sep />
          </>
        )}
        {onShare && (
          <>
            <button type="button" className="shell-chip shell-chip--ink" onClick={onShare} data-testid="shell-share">
              Share
            </button>
            <Sep />
          </>
        )}
        {onPrint && (
          <>
            <button type="button" className="shell-chip shell-chip--ink" onClick={onPrint} data-testid="shell-print">
              Print
            </button>
            <Sep />
          </>
        )}
        {place === 'racks' && (
          <>
            <div className="shell-bar__zoom">
              <button type="button" className="shell-zoom-btn" aria-label="Zoom out" title="Zoom out" onClick={onZoomOut}>
                &minus;
              </button>
              {onZoomFit ? (
                <button type="button" className="shell-zoom-value" aria-label="Fit to view" title="Fit to view" onClick={onZoomFit}>
                  {zoom}%
                </button>
              ) : (
                <span className="shell-zoom-value">{zoom}%</span>
              )}
              <button type="button" className="shell-zoom-btn" aria-label="Zoom in" title="Zoom in" onClick={onZoomIn}>
                +
              </button>
            </div>
            <Sep />
          </>
        )}
        {adminPill &&
          (adminPill.onSelect && !adminPill.current ? (
            <button type="button" className="shell-admin-pill" data-testid="shell-admin-pill" onClick={adminPill.onSelect}>
              Admin
            </button>
          ) : (
            <span className="shell-admin-pill" data-testid="shell-admin-pill" aria-current={adminPill.current ? 'page' : undefined}>
              Admin
            </span>
          ))}
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
              title="Account menu"
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
