import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { signOut } from '../../api/auth';
import { useWindowWidth } from './Dock';
import { nextFoldLevel } from './layout';
import type { DiagramStyle } from '../drawing/diagramStyle';
import type { CableStyle } from '../drawing/cableStyle';
import type { LayerId, LayerSet } from '../drawing/layers';
import { LayersMenu, LensGroup } from './CanvasBar';
import { LOOKS, LOOK_LABEL, type Look } from '../drawing/look';
import { LENSES_IN, LENS_LABEL } from './lens';
import type { Lens } from './lens';
import { Popover, PopoverRow } from './Popover';
import { pathToItems } from './path';
import type { PathItem, PathPart } from './path';
import { SearchBox } from './SearchBox';
import { shortcutText } from './shortcuts';
import { ThemeMenu } from './ThemeMenu';
import type { AccountInfo, MainView, Place, PresenceUser, ShellProps, ShellSearch, ShowAids } from './types';

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
  layers?: { value: LayerSet; onToggle: (id: LayerId) => void; style?: { value: DiagramStyle; onChange: (style: DiagramStyle) => void }; cables?: { value: CableStyle; onChange: (style: CableStyle) => void }; aids?: ShowAids };
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
  /** r31-bar A: the four views as the bar's tabs. Without it the two places are the tabs. */
  mainView?: ShellProps['mainView'];
  /** Right after the design's name: the Sample chip. */
  designExtra?: ReactNode;
  /** The Doing ▾ menu: what you can set about doing now. */
  doing?: ShellProps['doing'];
  /** The lens, Layers, Undo, Redo, zoom, Docs, History and Print are on the drawing and the right panel, not here. */
  toolsOnCanvas?: boolean;
  /** A job under way: it takes the bar. */
  task?: ShellProps['task'];
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
  mainView,
  designExtra,
  doing,
  toolsOnCanvas = false,
  task = null,
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
  // r31-motion: on the drawing, search folds to its magnifier below 1440px (Ctrl K still opens it).
  const windowWidth = useWindowWidth();
  const searchCollapsed = fold >= 1 || (toolsOnCanvas && windowWidth < 1440);
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
    <div className={task != null ? 'shell-bar shell-bar--task' : 'shell-bar'} data-tone={task?.tone} ref={containerRef}>
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
        {mainView != null ? (
          <ViewTabs view={mainView.value} onChange={mainView.onChange} folded={task != null} />
        ) : (
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
        )}
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
              <PathCrumb item={item} tree={tree} onPrint={toolsOnCanvas ? onPrint : undefined} />
            </span>
          ))}
        </div>
        {designExtra}
        {task != null && (
          <div className="shell-task" role="status" data-testid="shell-task">
            <span className="shell-task__dot" aria-hidden="true" />
            <span className="shell-task__label">{task.label}</span>
            {task.stage != null && <span className="shell-task__stage">{task.stage}</span>}
            <button type="button" className="shell-task__exit" onClick={task.onExit} data-testid="shell-task-exit">
              Exit
            </button>
          </div>
        )}
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
        {place !== null && !toolsOnCanvas && (
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
                  {/* Folded, the Cables lens's own list of groups sits here. */}
                  {lens === 'cables' && cablesGroupsPopover != null && (
                    <div className="shell-bar__fold-groups">{cablesGroupsPopover}</div>
                  )}
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
            <LensGroup place={place} lens={lens} onLensChange={onLensChange} cablesGroupsPopover={cablesGroupsPopover} cablesGroupsSummary={cablesGroupsSummary} />
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
            {layers != null && <LayersMenu layers={layers} look={look} extra={actionsFolded ? viewsFolded : undefined} />}
            {layers != null && !actionsFolded && views}
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
        {doing != null && doing.length > 0 && task == null && <DoingMenu items={doing} />}
        {toolsOnCanvas && onShare && (
          <button type="button" className="shell-chip shell-chip--ink" onClick={onShare} data-testid="shell-share">
            Share
          </button>
        )}
        {place !== null && !toolsOnCanvas && !editsFolded && (
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
        {toolsOnCanvas ? null : actionsFolded && (onDocs || onHistory || onShare || onPrint || editsFolded) ? (
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
          (onDocs || onHistory || onShare || onPrint) && (
            <>
              <div className="shell-bar__undoredo">
                {onDocs && (
                  <button type="button" className="shell-chip shell-chip--ink" onClick={onDocs} data-testid="shell-docs">
                    Docs
                  </button>
                )}
                {onHistory && (
                  <button
                    type="button"
                    className="shell-chip shell-chip--ink"
                    aria-pressed={historyOpen ?? false}
                    onClick={onHistory}
                    data-testid="shell-history"
                  >
                    History
                  </button>
                )}
                {onShare && (
                  <button type="button" className="shell-chip shell-chip--ink" onClick={onShare} data-testid="shell-share">
                    Share
                  </button>
                )}
                {onPrint && (
                  <button type="button" className="shell-chip shell-chip--ink" onClick={onPrint} data-testid="shell-print">
                    Print
                  </button>
                )}
              </div>
              <Sep />
            </>
          )
        )}
        {place === 'racks' && !toolsOnCanvas && !editsFolded && (
          <>
            <div className="shell-bar__zoom">
              <button type="button" className="shell-zoom-btn" aria-label="Zoom out" title={`Zoom out (${shortcutText('zoom-out')})`} onClick={onZoomOut}>
                &minus;
              </button>
              {onZoomFit ? (
                <button type="button" className="shell-zoom-value" aria-label="Fit to view" title={`Fit to view (${shortcutText('zoom-fit')})`} onClick={onZoomFit}>
                  {zoom}%
                </button>
              ) : (
                <span className="shell-zoom-value">{zoom}%</span>
              )}
              <button type="button" className="shell-zoom-btn" aria-label="Zoom in" title={`Zoom in (${shortcutText('zoom-in')})`} onClick={onZoomIn}>
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

function PathCrumb({ item, tree, onPrint }: { item: PathItem; tree: ReactNode; onPrint?: () => void }) {
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
        {/* r31-bar A: Print is the design's own business, so it sits in the design's menu. */}
        {onPrint && (
          <PopoverRow onSelect={onPrint} testId="shell-print">
            Print or export…
          </PopoverRow>
        )}
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

const VIEW_LABEL: Record<MainView, string> = { diagram: 'Diagram', canvas: 'Canvas', inventory: 'Inventory', sheet: 'Sheet' };
const VIEWS: readonly MainView[] = ['diagram', 'canvas', 'inventory', 'sheet'];

/** r31-bar A: the four views. The ink underline slides to the one you choose (r31-motion). */
function ViewTabs({ view, onChange, folded = false }: { view: MainView; onChange: (view: MainView) => void; folded?: boolean }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [mark, setMark] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const on = rowRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (on != null) setMark({ left: on.offsetLeft, width: on.offsetWidth });
  }, [view, folded]);
  return (
    <div className={folded ? 'shell-bar__tabs shell-bar__tabs--views shell-bar__tabs--folded' : 'shell-bar__tabs shell-bar__tabs--views'} ref={rowRef} role="tablist" aria-label="Views">
      {VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={v === view}
          aria-current={v === view ? 'page' : undefined}
          className={v === view ? 'shell-bar__tab shell-bar__tab--on' : 'shell-bar__tab'}
          data-testid={`view-${v}`}
          onClick={() => onChange(v)}
        >
          {VIEW_LABEL[v]}
        </button>
      ))}
      {mark != null && <span className="shell-bar__tabs-mark" aria-hidden="true" style={{ left: mark.left, width: mark.width }} />}
    </div>
  );
}

/** Doing ▾: the jobs you can set about from here. A row that needs something first says what. */
function DoingMenu({ items }: { items: NonNullable<ShellProps['doing']> }) {
  return (
    <Popover
      align="right"
      renderTrigger={({ open, triggerProps, triggerRef }) => (
        <button
          type="button"
          className={open ? 'shell-chip shell-chip--ink shell-chip--on' : 'shell-chip shell-chip--ink'}
          data-testid="shell-doing"
          ref={(el) => {
            triggerRef.current = el;
          }}
          {...triggerProps}
        >
          Doing ▾
        </button>
      )}
    >
      {items.map((item) => (
        <PopoverRow key={item.id} onSelect={item.onSelect ?? (() => {})} disabled={item.onSelect == null} testId={`doing-${item.id}`}>
          {item.label}
          {item.hint != null && <span className="shell-doing__hint">{item.hint}</span>}
        </PopoverRow>
      ))}
    </Popover>
  );
}
