import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { signOut } from '../../api/auth';
import { nextFoldLevel } from './layout';
import { DIAGRAM_STYLES, DIAGRAM_STYLE_LABEL, type DiagramStyle } from '../drawing/diagramStyle';
import { LAYERS, type LayerId, type LayerSet } from '../drawing/layers';
import { LOOKS, LOOK_LABEL, type Look } from '../drawing/look';
import { LENSES_IN, LENS_LABEL } from './lens';
import type { Lens } from './lens';
import { Popover, PopoverRow } from './Popover';
import { pathToItems } from './path';
import type { PathItem, PathPart } from './path';
import { SearchBox } from './SearchBox';
import { ThemeMenu } from './ThemeMenu';
import type { AccountInfo, Place, PresenceUser, ShellSearch } from './types';

// The bar's own `gap` and side padding, counted when measuring its row.
const BAR_GAP = 12;
const BAR_PAD = 16;

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
  views?: ReactNode;
  /** The saved views as rows for the View ▾ menu, shown once the bar folds the views group away. */
  viewsFolded?: ReactNode;
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
  views,
  viewsFolded,
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

  // BRIEF.md "The bar": search folds to the magnifier before anything else
  // gives; past that the action chips fold into More, the path to its last
  // part, and the lenses into one View menu. Measured, never a breakpoint.
  const [fold, setFold] = useState(0);
  const foldRef = useRef(0);
  foldRef.current = fold;
  const neededRef = useRef<(number | undefined)[]>([]);
  const contentKey = [place, path.map((p) => p.label).join('/'), lens, presence.length, account.initials, zoom, viewOnly, hiddenCablesCount, look?.value, onDocs != null, onHistory != null, onShare != null, onPrint != null].join('|');
  useLayoutEffect(() => {
    neededRef.current = [];
    setFold(0);
  }, [contentKey]);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    function measure() {
      if (!container) return;
      const kids = Array.from(container.children) as HTMLElement[];
      const total = kids.reduce((sum, el) => sum + naturalWidth(el), 0) + BAR_GAP * Math.max(0, kids.length - 1) + BAR_PAD * 2;
      const level = foldRef.current;
      const next = nextFoldLevel({ level, total, avail: container.clientWidth, needed: neededRef.current });
      if (next > level) neededRef.current[level] = total;
      if (next !== level) setFold(next);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    if (leadingRef.current) observer.observe(leadingRef.current);
    if (trailingRef.current) observer.observe(trailingRef.current);
    return () => observer.disconnect();
  }, [fold, contentKey]);
  const searchCollapsed = fold >= 1;
  const actionsFolded = fold >= 2;
  const pathFolded = fold >= 3;
  const lensesFolded = fold >= 4;
  const editsFolded = fold >= 5;

  async function handleSignOut() {
    await signOut();
  }

  const allPathItems = pathToItems(path);
  // Folded, the path keeps the crumb that opens the switcher and what follows it.
  const switcherAt = allPathItems.findLastIndex((item) => item.opensTree === true);
  const pathItems = pathFolded ? allPathItems.slice(switcherAt >= 0 ? switcherAt : Math.max(0, allPathItems.length - 2)) : allPathItems;

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
        {/* Earlier crumbs go somewhere; the design's own crumb opens the
            list of places to switch to. */}
        <div className="shell-bar__path">
          {pathItems.length === 0 && <span className="shell-bar__path-empty">Home</span>}
          {pathItems.map((item, index) => (
            <span className="shell-bar__path-part" key={`${item.label}-${index}`}>
              {index > 0 && (
                <span className="shell-bar__path-sep" aria-hidden="true">
                  &rsaquo;
                </span>
              )}
              <PathCrumb item={item} tree={tree} />
            </span>
          ))}
        </div>
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
            {lensesFolded ? (
              <Popover
                align="left"
                renderTrigger={({ open, triggerProps, triggerRef }) => (
                  <button
                    type="button"
                    className={open ? 'shell-lens shell-lens--on shell-bar__fold' : 'shell-lens shell-bar__fold'}
                    data-testid="shell-view-menu"
                    ref={(el) => {
                      triggerRef.current = el;
                    }}
                    {...triggerProps}
                  >
                    {LENS_LABEL[lens]}
                    {look != null ? ` · ${LOOK_LABEL[look.value]}` : ''} ▾
                  </button>
                )}
              >
                <div className="shell-show" role="group" aria-label="View">
                  <div className="shell-show__head">Lens</div>
                  {LENSES_IN[place].map((candidate) => (
                    <PopoverRow key={candidate} current={candidate === lens} onSelect={() => onLensChange(candidate)}>
                      {LENS_LABEL[candidate]}
                      {candidate === 'cables' && cablesGroupsSummary != null ? ` · ${cablesGroupsSummary}` : ''}
                    </PopoverRow>
                  ))}
                  {look != null && (
                    <>
                      <div className="shell-show__head">Look</div>
                      {LOOKS.map((candidate) => (
                        <PopoverRow key={candidate} current={candidate === look.value} onSelect={() => look.onChange(candidate)}>
                          {LOOK_LABEL[candidate]}
                        </PopoverRow>
                      ))}
                    </>
                  )}
                  {layers != null && viewsFolded}
                </div>
              </Popover>
            ) : (
            <>
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
            </>
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
            {layers != null && !lensesFolded && views}
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
        {place !== null && !editsFolded && (
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
        {actionsFolded && (onDocs || onHistory || onShare || onPrint || editsFolded) ? (
          <>
            <Popover
              align="right"
              renderTrigger={({ open, triggerProps, triggerRef }) => (
                <button
                  type="button"
                  className={open ? 'shell-chip shell-chip--ink shell-chip--on' : 'shell-chip shell-chip--ink'}
                  data-testid="shell-more"
                  ref={(el) => {
                    triggerRef.current = el;
                  }}
                  {...triggerProps}
                >
                  More ▾
                </button>
              )}
            >
              {editsFolded && place !== null && (
                <>
                  <PopoverRow onSelect={onUndo} disabled={!canUndo}>
                    Undo
                  </PopoverRow>
                  <PopoverRow onSelect={onRedo} disabled={!canRedo}>
                    Redo
                  </PopoverRow>
                </>
              )}
              {editsFolded && place === 'racks' && (
                <>
                  <PopoverRow onSelect={onZoomIn}>Zoom in</PopoverRow>
                  <PopoverRow onSelect={onZoomOut}>Zoom out</PopoverRow>
                  {onZoomFit && <PopoverRow onSelect={onZoomFit}>Fit to view ({zoom}%)</PopoverRow>}
                </>
              )}
              {onDocs && <PopoverRow onSelect={onDocs} testId="shell-docs">Docs</PopoverRow>}
              {onHistory && (
                <PopoverRow onSelect={onHistory} current={historyOpen ?? false} testId="shell-history">
                  History
                </PopoverRow>
              )}
              {onShare && <PopoverRow onSelect={onShare} testId="shell-share">Share</PopoverRow>}
              {onPrint && <PopoverRow onSelect={onPrint} testId="shell-print">Print</PopoverRow>}
            </Popover>
            <Sep />
          </>
        ) : (
          <>
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
          </>
        )}
        {place === 'racks' && !editsFolded && (
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
          className="shell-popover--frosted"
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
          <ThemeMenu />
          <PopoverRow onSelect={handleSignOut}>Sign out</PopoverRow>
        </Popover>
      </div>
    </div>
  );
}

function PathCrumb({ item, tree }: { item: PathItem; tree: ReactNode }) {
  const className = item.current ? 'shell-bar__path-label shell-bar__path-label--current' : 'shell-bar__path-label';
  if (item.opensTree) {
    return (
      <Popover
        align="left"
        renderTrigger={({ toggle, triggerRef, triggerProps }) => (
          <button
            type="button"
            className={className}
            title="Switch to another place or design"
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
            <span className="shell-bar__path-caret" aria-hidden="true">
              {' '}
              ▾
            </span>
          </button>
        )}
      >
        {tree}
      </Popover>
    );
  }
  if (item.onSelect) {
    return (
      <button type="button" className={className + ' shell-bar__path-label--link'} title={item.hint} onClick={item.onSelect}>
        {item.label}
      </button>
    );
  }
  return <span className={className + ' shell-bar__path-label--plain'}>{item.label}</span>;
}

/** A bar group's width at its content's size, however the row squeezed it.
 * Open pop-overs are positioned out of flow and never count. */
function naturalWidth(el: HTMLElement): number {
  if (el.classList.contains('shell-bar__spacer')) return 0;
  if (!el.classList.contains('shell-bar__leading') && !el.classList.contains('shell-bar__trailing')) return el.offsetWidth;
  const kids = Array.from(el.children) as HTMLElement[];
  const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
  return kids.reduce((sum, k) => sum + k.offsetWidth, 0) + gap * Math.max(0, kids.length - 1);
}

function Sep() {
  return (
    <span className="shell-bar__sep-wrap">
      <span className="shell-bar__sep" aria-hidden="true" />
    </span>
  );
}
