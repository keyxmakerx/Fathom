import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { DockSlot, DockTab } from './Dock';
import { Editor, type EditorProps } from './Editor';
import type { PanelId } from './panelSizing';
import { HeadMenuHost, PanelHead } from './PanelHead';
import { isTypingTarget } from './shortcuts';
import type { SideTab } from './sideSlot';
import type { RightTab } from './useRightTab';

/** The width each tab remembers; the Equipment list keeps the width it had on the left. */
export const PANEL_OF: Record<RightTab, PanelId> = { equipment: 'rail', details: 'details', history: 'history', trail: 'trail' };
const NAME_OF: Record<RightTab, string> = { equipment: 'Equipment', details: 'Details', history: 'History', trail: 'History' };

export interface RightDockProps {
  shown: RightTab | null;
  /** What each tab holds; a tab with nothing behind it is not drawn. The Trail is the History panel's second tab. */
  equipment?: ReactNode | null;
  details: ReactNode | null;
  history: ReactNode | null;
  trail: ReactNode | null;
  /** The History tab is offered whenever the History button is. */
  canOpenHistory: boolean;
  /** History mode is on while another tab is showing: a past save is still on the canvas. */
  historyLive: boolean;
  editorProps: Omit<EditorProps, 'children'>;
  width: number;
  max: number;
  onChoose: (tab: RightTab) => void;
  onFold: (tab: RightTab) => void;
  onResize: (panel: PanelId, width: number, commit: boolean) => void;
  onReset: (panel: PanelId) => void;
  onDragging: (dragging: boolean) => void;
  /** r30-panels: Checks, a plan, "It's down" and a trace, as more tabs of the same panel. */
  side?: readonly SideTab[];
  /** The side tab holding the panel, over whichever of the four is chosen. */
  active?: string | null;
  onActivate?: (id: string | null) => void;
  /** Where each side tab's slot element goes, once it is in the page. */
  slotRef?: (id: string) => (el: HTMLElement | null) => void;
}

/** A side tab gave the panel up while focus was inside it (Esc, a fold link): which tab's button takes focus, so it
 * is never left on the page's body. Null when nothing was lost, the tab went away, or another tab took the panel. */
export function refocusAfterFold(before: string | null, now: string | null, tabs: readonly Pick<SideTab, 'id'>[], focusLost: boolean): string | null {
  if (!focusLost || before == null || now != null) return null;
  return tabs.some((t) => t.id === before) ? before : null;
}

/**
 * The right-hand edge: one slot whose tabs are Equipment, the selection's Details and History (the Trail is a
 * second tab inside it), and (r30-panels) whatever side tabs the place adds: Checks, Docs, a plan, "It's down",
 * a trace. Folded, it is a slim strip of labelled tabs; open, one panel slides out beside the strip, under the
 * same head (`PanelHead`).
 */
export function RightDock({
  shown,
  equipment = null,
  details,
  history,
  trail,
  canOpenHistory,
  historyLive,
  editorProps,
  width,
  max,
  onChoose,
  onFold,
  onResize,
  onReset,
  onDragging,
  side = [],
  active = null,
  onActivate,
  slotRef,
}: RightDockProps) {
  const last = useRef<RightTab>('details');
  if (shown != null) last.current = shown;
  const tab = shown ?? last.current;
  const hasEquipment = equipment != null;
  const hasDetails = details != null;
  const hasTrail = trail != null;
  const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
  const inHistory = shown === 'history' || shown === 'trail';
  const activeTab = side.find((t) => t.id === active) ?? null;
  // Folded with focus inside (Esc in "It's down" or a plan): the tab's own button takes focus.
  const strip = useRef<HTMLDivElement>(null);
  const wasActive = useRef<string | null>(active);
  useEffect(() => {
    const before = wasActive.current;
    wasActive.current = active;
    const el = document.activeElement;
    const lost = el == null || el === document.body || (before != null && el.closest(`.dock-side[data-side="${CSS.escape(before)}"]`) != null);
    const id = refocusAfterFold(before, active, side, lost);
    if (id != null) strip.current?.querySelector<HTMLElement>(`[data-side-tab="${CSS.escape(id)}"]`)?.focus();
  }, [active, side]);
  // A side tab holding the panel gives it back to whichever of the four is pressed.
  const press = (t: RightTab) => {
    if (activeTab != null) {
      onActivate?.(null);
      if (shown !== t) onChoose(t);
      return;
    }
    if (shown === t) onFold(t);
    else onChoose(t);
  };
  const pressSide = (t: SideTab) => {
    if (active === t.id) t.onClose();
    else if (t.open) onActivate?.(t.id);
    else t.onOpen();
  };
  const slots = side.map((t) => (
    <div key={t.id} ref={slotRef?.(t.id)} className="dock-side" data-side={t.id} hidden={active !== t.id}>
      {t.content != null && t.open ? t.content : null}
    </div>
  ));
  const headName = shown === 'equipment' ? 'Equipment' : shown === 'details' ? 'Details' : 'History';
  const core =
    activeTab != null || shown == null ? null : (
      <>
        <PanelHead name={headName} onFold={() => onFold(shown)} hostRef={setMenuHost} testId="dock-head" />
        {inHistory && hasTrail && (
          <div className="panel-tabs" role="tablist" aria-label="History">
            <button type="button" role="tab" className="panel-tabs__tab" aria-selected={shown === 'history'} data-testid="history-tab-saves" onClick={() => shown !== 'history' && onChoose('history')}>
              Saves
            </button>
            <button type="button" role="tab" className="panel-tabs__tab" aria-selected={shown === 'trail'} data-testid="history-tab-trail" onClick={() => shown !== 'trail' && onChoose('trail')}>
              Trail
            </button>
          </div>
        )}
        {shown === 'equipment' ? (
          <nav className="shell-rail" aria-label="Equipment">
            {equipment}
          </nav>
        ) : shown === 'details' ? (
          <HeadMenuHost.Provider value={menuHost}>
            <Editor {...editorProps}>{details}</Editor>
          </HeadMenuHost.Provider>
        ) : shown === 'history' ? (
          <aside className="shell-editor" aria-label="History">
            {history}
          </aside>
        ) : (
          <aside className="shell-trail" aria-label="Trail">
            {trail}
          </aside>
        )}
      </>
    );
  const content = (
    <>
      {core}
      {slots}
    </>
  );

  // Esc, with focus in the open panel, folds it: the same as its fold arrow and its edge tab.
  const onEsc = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e.target)) return;
    if (!(e.target instanceof Element) || e.target.closest('.dock-panel') == null) return;
    if (activeTab != null) activeTab.onClose();
    else if (shown != null) onFold(shown);
    else return;
    e.preventDefault();
  };

  if (!hasEquipment && !hasDetails && !canOpenHistory && !hasTrail && side.length === 0) return null;
  return (
    <div className="dock-right" onKeyDown={onEsc}>
      <DockSlot
        side="right"
        open={shown != null || activeTab != null}
        width={width}
        name={activeTab?.label ?? NAME_OF[tab]}
        panel={activeTab != null ? 'details' : PANEL_OF[tab]}
        max={max}
        onResize={onResize}
        onReset={onReset}
        onDragging={onDragging}
      >
        {content}
      </DockSlot>
      <div ref={strip} className="dock-strip dock-strip--right" role="group" aria-label="Side panels">
        {hasEquipment && (
          <DockTab
            label="Equipment"
            name={activeTab == null && shown === 'equipment' ? 'Close the equipment list' : 'Open the equipment list'}
            open={activeTab == null && shown === 'equipment'}
            testId="dock-equipment"
            onClick={() => press('equipment')}
          />
        )}
        {hasDetails && <DockTab label="Details" name={activeTab == null && shown === 'details' ? 'Close the details' : 'Open the details'} open={activeTab == null && shown === 'details'} testId="dock-details" onClick={() => press('details')} />}
        {(canOpenHistory || hasTrail) && (
          <DockTab
            label="History"
            name={activeTab == null && inHistory ? 'Close the history' : 'Open the history'}
            open={activeTab == null && inHistory}
            marked={historyLive && !inHistory}
            testId="dock-history"
            onClick={() => press(shown != null && inHistory ? shown : canOpenHistory ? 'history' : 'trail')}
          />
        )}
        {side.map((t) => {
          const word = `${t.label}${t.count != null && t.count > 0 ? ` ${t.count}` : ''}`;
          return (
            <DockTab
              key={t.id}
              label={word}
              name={active === t.id ? `Close ${t.label}` : `Open ${t.label}`}
              open={active === t.id}
              marked={t.open && active !== t.id}
              testId={`dock-${t.id}`}
              sideId={t.id}
              onClick={() => pressSide(t)}
            />
          );
        })}
      </div>
    </div>
  );
}
