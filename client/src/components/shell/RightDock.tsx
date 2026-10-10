import { useRef, type ReactNode } from 'react';

import { DockSlot, DockTab } from './Dock';
import { Editor, type EditorProps } from './Editor';
import type { PanelId } from './panelSizing';
import type { RightTab } from './useRightTab';

const PANEL_OF: Record<RightTab, PanelId> = { details: 'details', history: 'history', trail: 'trail' };
const NAME_OF: Record<RightTab, string> = { details: 'Details', history: 'History', trail: 'Trail' };

export interface RightDockProps {
  shown: RightTab | null;
  /** What each tab holds; a tab with nothing behind it is not drawn. */
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
}

/**
 * The right-hand edge: one slot whose tabs are the selection's Details, History and the Trail.
 * Folded, it is a slim strip of labelled tabs; open, one panel slides out beside the strip.
 */
export function RightDock({
  shown,
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
}: RightDockProps) {
  const last = useRef<RightTab>('details');
  if (shown != null) last.current = shown;
  const tab = shown ?? last.current;
  const hasDetails = details != null;
  const hasTrail = trail != null;
  const press = (t: RightTab) => (shown === t ? onFold(t) : onChoose(t));
  const content =
    shown === 'details' ? (
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

  if (!hasDetails && !canOpenHistory && !hasTrail) return null;
  return (
    <div className="dock-right">
      <DockSlot
        side="right"
        open={shown != null}
        width={width}
        name={NAME_OF[tab]}
        panel={PANEL_OF[tab]}
        max={max}
        onResize={onResize}
        onReset={onReset}
        onDragging={onDragging}
      >
        {content}
      </DockSlot>
      <div className="dock-strip dock-strip--right" role="group" aria-label="Side panels">
        {hasDetails && <DockTab label="Details" name={shown === 'details' ? 'Close the details' : 'Open the details'} open={shown === 'details'} testId="dock-details" onClick={() => press('details')} />}
        {canOpenHistory && (
          <DockTab
            label="History"
            name={shown === 'history' ? 'Close the history' : 'Open the history'}
            open={shown === 'history'}
            marked={historyLive && shown !== 'history'}
            testId="dock-history"
            onClick={() => press('history')}
          />
        )}
        {hasTrail && <DockTab label="Trail" name={shown === 'trail' ? 'Close the trail' : 'Open the trail'} open={shown === 'trail'} testId="dock-trail" onClick={() => press('trail')} />}
      </div>
    </div>
  );
}
