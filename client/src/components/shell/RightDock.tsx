import { useRef, type ReactNode } from 'react';

import { DockSlot, DockTab } from './Dock';
import { Editor, type EditorProps } from './Editor';
import type { PanelId } from './panelSizing';
import type { SideTab } from './sideSlot';
import type { RightTab } from './useRightTab';

/** The width each tab remembers; the Equipment list keeps the width it had on the left. */
export const PANEL_OF: Record<RightTab, PanelId> = { equipment: 'rail', details: 'details', history: 'history', trail: 'trail' };
const NAME_OF: Record<RightTab, string> = { equipment: 'Equipment', details: 'Details', history: 'History', trail: 'Trail' };

export interface RightDockProps {
  shown: RightTab | null;
  /** What each tab holds; a tab with nothing behind it is not drawn. */
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

/**
 * The right-hand edge: one slot whose tabs are Equipment, the selection's Details, History and the Trail, and
 * (r30-panels) whatever side tabs the place adds: Checks, a plan, "It's down", a trace.
 * Folded, it is a slim strip of labelled tabs; open, one panel slides out beside the strip.
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
  const activeTab = side.find((t) => t.id === active) ?? null;
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
  const slots = side.map((t) => <div key={t.id} ref={slotRef?.(t.id)} className="dock-side" data-side={t.id} hidden={active !== t.id} />);
  const core =
    activeTab != null ? null : shown === 'equipment' ? (
      <nav className="shell-rail" aria-label="Equipment">
        {equipment}
      </nav>
    ) : shown === 'details' ? (
      <Editor {...editorProps}>{details}</Editor>
    ) : shown === 'history' ? (
      <aside className="shell-editor" aria-label="History">
        {history}
      </aside>
    ) : shown === 'trail' ? (
      <aside className="shell-trail" aria-label="Trail">
        {trail}
      </aside>
    ) : null;
  const content = (
    <>
      {core}
      {slots}
    </>
  );

  if (!hasEquipment && !hasDetails && !canOpenHistory && !hasTrail && side.length === 0) return null;
  return (
    <div className="dock-right">
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
      <div className="dock-strip dock-strip--right" role="group" aria-label="Side panels">
        {hasEquipment && (
          <DockTab
            label="Equipment"
            name={shown === 'equipment' ? 'Close the equipment list' : 'Open the equipment list'}
            open={activeTab == null && shown === 'equipment'}
            testId="dock-equipment"
            onClick={() => press('equipment')}
          />
        )}
        {hasDetails && <DockTab label="Details" name={shown === 'details' ? 'Close the details' : 'Open the details'} open={activeTab == null && shown === 'details'} testId="dock-details" onClick={() => press('details')} />}
        {canOpenHistory && (
          <DockTab
            label="History"
            name={shown === 'history' ? 'Close the history' : 'Open the history'}
            open={activeTab == null && shown === 'history'}
            marked={historyLive && shown !== 'history'}
            testId="dock-history"
            onClick={() => press('history')}
          />
        )}
        {hasTrail && <DockTab label="Trail" name={shown === 'trail' ? 'Close the trail' : 'Open the trail'} open={activeTab == null && shown === 'trail'} testId="dock-trail" onClick={() => press('trail')} />}
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
              onClick={() => pressSide(t)}
            />
          );
        })}
      </div>
    </div>
  );
}
