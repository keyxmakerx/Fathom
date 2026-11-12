import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { signOut } from '../../api/auth';
import { UNTITLED_DESIGN } from '../../api/designs';
import { useWindowWidth } from './Dock';
import { nextFoldLevel } from './layout';
import { Popover, PopoverRow } from './Popover';
import { pathToItems } from './path';
import type { PathItem, PathPart } from './path';
import { SearchBox } from './SearchBox';
import { shortcutText } from './shortcuts';
import { ThemeMenu } from './ThemeMenu';
import type { AccountInfo, MainView, Place, PresenceUser, ShellProps, ShellSearch } from './types';
import { VaultBadge, VaultMenuRows } from '../vault/VaultBadge';

// The bar's own `gap` and side padding, counted when measuring its row.
const BAR_GAP = 12;
const BAR_PAD = 16;

/** Dots shown for others in this view before the rest fold into "+N". */
const PEOPLE_SHOWN = 5;

export interface BarProps {
  place: Place | null;
  onPlaceChange: (place: Place) => void;
  path: PathPart[];
  tree: ReactNode;
  presence: PresenceUser[];
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Print, in the design name's menu; absent with no design open. */
  onPrint?: () => void;
  /** The Share button; present only for someone who may share (a steward). */
  onShare?: () => void;
  /** The round "?" just before the account square: opens the keyboard shortcuts sheet. */
  onShortcuts?: () => void;
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
  /** r31-bar A: the four views as the bar's tabs. Without it the two places are the tabs. */
  mainView?: ShellProps['mainView'];
  work?: ShellProps['work'];
  /** Right after the design's name: the Sample chip. */
  designExtra?: ReactNode;
  /** The Doing ▾ menu: what you can set about doing now. */
  doing?: ShellProps['doing'];
  /** A job under way: it takes the bar. */
  task?: ShellProps['task'];
}

/** The bar — UI-SPEC "The bar" and r116: one row, 44px, a 3px ink rule beneath, and the same on Canvas, Diagram,
 * Inventory and Sheet. Where you are, and what is about the whole design or about you. How a view is looked at
 * (lens, Layers, Look, zoom) is on the view, not here. */
export function Bar({
  place,
  onPlaceChange,
  path,
  tree,
  presence,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPrint,
  onShare,
  onShortcuts,
  account,
  viewOnly,
  barExtra,
  onHome,
  menu,
  adminPill,
  search,
  mainView,
  work,
  designExtra,
  doing,
  task = null,
}: BarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);

  // UI-SPEC "The bar": search folds to the magnifier before anything else gives; past that Doing, Share and the
  // Admin pill fold into More, the path to its last parts, and Undo and Redo into More too. Measured, never a
  // breakpoint.
  const [fold, setFold] = useState(0);
  const foldRef = useRef(0);
  foldRef.current = fold;
  const neededRef = useRef<(number | undefined)[]>([]);
  const contentKey = [place, path.map((p) => p.label).join('/'), presence.length, account.initials, viewOnly, onShare != null, onPrint != null, doing?.length ?? 0].join('|');
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
  // r31-motion: below 1440px search folds to its magnifier (Ctrl K still opens it).
  const windowWidth = useWindowWidth();
  const searchCollapsed = fold >= 1 || windowWidth < 1440;
  const actionsFolded = fold >= 2;
  const pathFolded = fold >= 3;
  const editsFolded = fold >= 4;
  const hasDoing = doing != null && doing.length > 0 && task == null;
  const hasEdits = place !== null;

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
        {/* The same four views everywhere. On Home (and Admin) they show only once a design has been opened this
            session, and lead back to it; Work stays. */}
        {mainView != null || place === null ? (
          <ViewTabs view={work?.on ? null : (mainView?.value ?? null)} onChange={mainView?.onChange} backTo={mainView?.backTo} showViews={mainView != null || place !== null} folded={task != null} work={work} />
        ) : (
        <div className="shell-bar__tabs">
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
        </div>
        )}
        <Sep />
        {/* Earlier crumbs go somewhere; the design's own crumb opens the
            list of places to switch to, and holds Rename and Print. */}
        <div className="shell-bar__path">
          {pathItems.length === 0 && <span className="shell-bar__path-empty">Home</span>}
          {pathItems.map((item, index) => (
            <span className="shell-bar__path-part" key={`${item.label}-${index}`}>
              {index > 0 && (
                <span className="shell-bar__path-sep" aria-hidden="true">
                  &rsaquo;
                </span>
              )}
              <PathCrumb item={item} tree={tree} onPrint={onPrint} />
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
            {presence.slice(0, PEOPLE_SHOWN).map((person) => (
              <span className="shell-person" key={person.id} role="img" tabIndex={0} aria-label={person.name} title={person.name}>
                {person.initials}
              </span>
            ))}
            {/* Sign-off rua-ui-audit, "A five plus n": past five, one "+N" that lists the rest, each
                name a link to what they have selected, so 20 people never push the views off the bar. */}
            {presence.length > PEOPLE_SHOWN && (
              <Popover
                align="right"
                renderTrigger={({ triggerProps, triggerRef }) => (
                  <button
                    type="button"
                    className="shell-person shell-person--more"
                    aria-label={`${presence.length - PEOPLE_SHOWN} more in this view`}
                    data-testid="shell-people-more"
                    ref={(el) => {
                      triggerRef.current = el;
                    }}
                    {...triggerProps}
                  >
                    +{presence.length - PEOPLE_SHOWN}
                  </button>
                )}
              >
                {presence.slice(PEOPLE_SHOWN).map((person) => (
                  <PopoverRow key={person.id} onSelect={person.go} muted={person.go == null}>
                    {person.name}
                  </PopoverRow>
                ))}
              </Popover>
            )}
          </div>
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
            <span className="shell-chip shell-bar__view-only" aria-label="view only">
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

        {/* Undo and Redo act on an open design, so they are on every view of one (r116). */}
        {hasEdits && !editsFolded && (
          <>
            <div className="shell-bar__undoredo">
              <button type="button" className="shell-chip shell-chip--ink" title={`Undo (${shortcutText('undo')})`} disabled={!canUndo} onClick={onUndo} data-testid="bar-undo">
                Undo
              </button>
              <button type="button" className="shell-chip shell-chip--ink" title={`Redo (${shortcutText('redo')})`} disabled={!canRedo} onClick={onRedo} data-testid="bar-redo">
                Redo
              </button>
            </div>
            <Sep />
          </>
        )}
        {/* A narrow bar folds Undo and Redo, Doing and Share into one menu, and the Admin pill into the account menu,
            rather than clipping them off the right-hand edge. */}
        {((actionsFolded && (hasDoing || onShare)) || (editsFolded && hasEdits)) && (
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
            {editsFolded && hasEdits && (
              <>
                <PopoverRow onSelect={onUndo} disabled={!canUndo}>
                  Undo
                </PopoverRow>
                <PopoverRow onSelect={onRedo} disabled={!canRedo}>
                  Redo
                </PopoverRow>
              </>
            )}
            {actionsFolded &&
              hasDoing &&
              doing.map((item) => (
                <PopoverRow key={item.id} onSelect={item.onSelect ?? (() => {})} disabled={item.onSelect == null} testId={`doing-${item.id}`}>
                  {item.label}
                  {item.hint != null && <span className="shell-doing__hint">{item.hint}</span>}
                </PopoverRow>
              ))}
            {actionsFolded && onShare && <PopoverRow onSelect={onShare} testId="shell-share">Share</PopoverRow>}
          </Popover>
        )}
        {!actionsFolded && hasDoing && <DoingMenu items={doing} />}
        {!actionsFolded && onShare && (
          <button type="button" className="shell-chip shell-chip--ink" onClick={onShare} data-testid="shell-share">
            Share
          </button>
        )}
        {adminPill && !actionsFolded &&
          (adminPill.onSelect && !adminPill.current ? (
            <button type="button" className="shell-admin-pill" data-testid="shell-admin-pill" onClick={adminPill.onSelect}>
              Admin
            </button>
          ) : (
            <span className="shell-admin-pill" data-testid="shell-admin-pill" aria-current={adminPill.current ? 'page' : undefined}>
              Admin
            </span>
          ))}
        {onShortcuts && (
          <button
            type="button"
            className="shell-shortcuts-btn"
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="Shift+?"
            title={`Keyboard shortcuts (${shortcutText('shortcuts')})`}
            data-testid="shell-shortcuts"
            onClick={onShortcuts}
          >
            ?
          </button>
        )}
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
              <VaultBadge />
            </button>
          )}
        >
          {/* A narrow bar folds the Admin pill in here, at the top, so it can still be reached. */}
          {adminPill && actionsFolded && (
            <PopoverRow onSelect={adminPill.onSelect ?? (() => {})} current={adminPill.current ?? false} testId="shell-admin-pill">
              Admin
            </PopoverRow>
          )}
          <VaultMenuRows />
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
  const [renaming, setRenaming] = useState(false);
  const rename = item.rename;
  if (item.opensTree && rename != null && renaming) {
    return <CrumbRename label={item.label} onRename={rename.onRename} onDone={() => setRenaming(false)} />;
  }
  if (item.opensTree) {
    return (
      <>
        <Popover
          align="left"
          renderTrigger={({ toggle, triggerRef, triggerProps }) => (
            <button
              type="button"
              className={className}
              title={`${item.label} · switch to another place or design${rename != null ? ' · double-click to rename' : ''}`}
              aria-haspopup={triggerProps['aria-haspopup']}
              aria-expanded={triggerProps['aria-expanded']}
              aria-controls={triggerProps['aria-controls']}
              onClick={(event) => {
                triggerRef.current = event.currentTarget;
                item.onSelect?.();
                toggle();
              }}
              onDoubleClick={rename != null ? () => setRenaming(true) : undefined}
            >
              <span className="shell-bar__path-text">{item.label}</span>
              <span className="shell-bar__path-caret" aria-hidden="true">
                {' '}
                ▾
              </span>
            </button>
          )}
        >
          {/* The owner, 2026-10-31: the name could not be changed from the bar. */}
          {rename != null && (
            <PopoverRow onSelect={() => setRenaming(true)} testId="shell-rename">
              Rename…
            </PopoverRow>
          )}
          {tree}
          {/* r31-bar A: Print is the design's own business, so it sits in the design's menu. */}
          {onPrint && (
            <PopoverRow onSelect={onPrint} testId="shell-print">
              Print or export…
            </PopoverRow>
          )}
        </Popover>
        {rename != null && (
          <button
            type="button"
            className="shell-bar__path-rename"
            aria-label={`Rename ${item.label}`}
            title="Rename"
            data-testid="shell-rename-pencil"
            onClick={() => setRenaming(true)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </>
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

/** The design's name as a field, in the crumb's own place: Enter or leaving
 * it saves, Escape puts the name back. Emptied, the design is untitled again. */
function CrumbRename({ label, onRename, onDone }: { label: string; onRename: (name: string) => Promise<void>; onDone: () => void }) {
  const [draft, setDraft] = useState(label === UNTITLED_DESIGN ? '' : label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settled = useRef(false);

  function save() {
    if (settled.current || busy) return;
    const name = draft.trim();
    if (name === (label === UNTITLED_DESIGN ? '' : label)) {
      settled.current = true;
      onDone();
      return;
    }
    setBusy(true);
    setError(null);
    onRename(name)
      .then(() => {
        settled.current = true;
        onDone();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'The name was not saved.'))
      .finally(() => setBusy(false));
  }

  return (
    <span className="shell-bar__path-edit">
      <input
        className="shell-bar__path-input"
        aria-label="Design name"
        data-testid="shell-rename-input"
        value={draft}
        maxLength={100}
        placeholder={UNTITLED_DESIGN}
        size={Math.max(12, Math.min(40, draft.length + 2))}
        autoFocus
        disabled={busy}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            settled.current = true;
            onDone();
          }
        }}
      />
      {error != null && (
        <span className="shell-bar__path-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
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
function ViewTabs({
  view,
  onChange,
  backTo,
  showViews = true,
  folded = false,
  work,
}: {
  view: MainView | null;
  onChange?: (view: MainView) => void;
  backTo?: string;
  /** False on Home before any design has been opened this session: there is nothing for a view to show. */
  showViews?: boolean;
  folded?: boolean;
  work?: ShellProps['work'];
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [mark, setMark] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row == null) return;
    const measure = () => {
      const on = row.querySelector<HTMLElement>('[aria-current="page"]');
      setMark((prev) => {
        if (on == null) return prev;
        if (prev != null && prev.left === on.offsetLeft && prev.width === on.offsetWidth) return prev;
        return { left: on.offsetLeft, width: on.offsetWidth };
      });
    };
    measure();
    // Folding for a job slides the other views' width to nothing, so the chosen
    // view only reaches its place when that slide ends: measure again then, or the
    // underline stays where the view used to be, under the path.
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== row && (e.target as HTMLElement).classList.contains('shell-bar__tab')) measure();
    };
    row.addEventListener('transitionend', onEnd);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(row);
    return () => {
      row.removeEventListener('transitionend', onEnd);
      ro?.disconnect();
    };
  }, [view, folded, work?.on]);
  return (
    <div className={folded ? 'shell-bar__tabs shell-bar__tabs--views shell-bar__tabs--folded' : 'shell-bar__tabs shell-bar__tabs--views'} ref={rowRef} role="tablist" aria-label="Views">
      {(showViews ? VIEWS : []).map((v) =>
        onChange == null ? (
          <span key={v} className="shell-bar__tab">
            {VIEW_LABEL[v]}
          </span>
        ) : (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={v === view}
          aria-current={v === view ? 'page' : undefined}
          className={v === view ? 'shell-bar__tab shell-bar__tab--on' : 'shell-bar__tab'}
          data-testid={`view-${v}`}
          title={backTo != null ? `Back to ${backTo}, ${VIEW_LABEL[v]}` : undefined}
          onClick={() => onChange(v)}
        >
          {VIEW_LABEL[v]}
        </button>
        ),
      )}
      {work != null && (
        <button
          type="button"
          role="tab"
          aria-selected={work.on}
          aria-current={work.on ? 'page' : undefined}
          className={work.on ? 'shell-bar__tab shell-bar__tab--on' : 'shell-bar__tab'}
          data-testid="view-work"
          title="Every site's work: plans, It's down and orders"
          onClick={work.onOpen}
        >
          Work
        </button>
      )}
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
