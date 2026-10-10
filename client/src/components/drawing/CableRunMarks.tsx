import { createContext, useContext, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { CABLE_RUN_FORM_LABEL, type CableRunView } from '../../document/cableRuns';
import { pointOnRun, rackRunLine, RUN_THICK_PX, type RackBox } from './runGeometry';

/** What a tie on a run can do: slide along it, or come off when dragged clear. Absent for a
 * reader, who sees runs and ties but cannot move them. */
export interface CableRunActions {
  moveTie(tieId: string, at: number): void;
  removeTie(tieId: string): void;
}

export const CableRunActionsContext = createContext<CableRunActions | null>(null);

/** Dragged this far clear of its run (screen pixels), a tie comes off. */
const UNCLIP_PX = 32;
const TIE_LONG_PX = 14;
const TIE_SHORT_PX = 3;

/**
 * A rack's trays and lacing bars (schema 0.21), drawn just outside its frame, with the ties
 * clipped onto them. A tie slides along its run as it is dragged; let go well clear of the run
 * and it comes off. Coordinates are the rack node's own.
 */
export function CableRunMarks({ runs, box }: { runs: readonly CableRunView[]; box: RackBox }) {
  const actions = useContext(CableRunActionsContext);
  const [drag, setDrag] = useState<{ tieId: string; at: number; off: boolean } | null>(null);
  if (runs.length === 0) return null;
  return (
    <>
      {runs.map((run) => {
        const line = rackRunLine(box, run.side);
        const left = Math.min(line.x1, line.x2) - (line.vertical ? RUN_THICK_PX / 2 : 0);
        const top = Math.min(line.y1, line.y2) - (line.vertical ? 0 : RUN_THICK_PX / 2);
        const width = line.vertical ? RUN_THICK_PX : Math.abs(line.x2 - line.x1);
        const height = line.vertical ? Math.abs(line.y2 - line.y1) : RUN_THICK_PX;
        const name = run.label ?? `${CABLE_RUN_FORM_LABEL[run.form]}, ${run.side}`;

        function atFromPointer(event: ReactPointerEvent, el: Element): { at: number; off: boolean } {
          const rect = el.getBoundingClientRect();
          const along = line.vertical ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
          const across = line.vertical ? event.clientX - (rect.left + rect.width / 2) : event.clientY - (rect.top + rect.height / 2);
          return { at: Math.round(Math.max(0, Math.min(1, along)) * 1000), off: Math.abs(across) > UNCLIP_PX };
        }

        return (
          <div
            key={run.id}
            className={`drawing-run drawing-run--${run.form}`}
            data-run-id={run.id}
            style={{ left, top, width, height }}
            title={name}
          >
            {run.ties.map((tie) => {
              const dragging = drag?.tieId === tie.id ? drag : null;
              const p = pointOnRun({ x1: 0, y1: 0, x2: width, y2: height }, dragging?.at ?? tie.at);
              const w = line.vertical ? TIE_LONG_PX : TIE_SHORT_PX;
              const h = line.vertical ? TIE_SHORT_PX : TIE_LONG_PX;
              return (
                <div
                  key={tie.id}
                  role="slider"
                  aria-label={`Cable tie holding ${tie.cableIds.length} cable${tie.cableIds.length === 1 ? '' : 's'}`}
                  aria-valuemin={0}
                  aria-valuemax={1000}
                  aria-valuenow={dragging?.at ?? tie.at}
                  data-tie-id={tie.id}
                  className={[
                    'drawing-run__tie nodrag nopan',
                    actions != null ? 'drawing-run__tie--movable' : '',
                    dragging?.off ? 'drawing-run__tie--off' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left: (line.vertical ? width / 2 : p.x) - w / 2, top: (line.vertical ? p.y : height / 2) - h / 2, width: w, height: h }}
                  onPointerDown={(event) => {
                    if (actions == null || event.button !== 0) return;
                    event.stopPropagation();
                    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
                    setDrag({ tieId: tie.id, at: tie.at, off: false });
                  }}
                  onPointerMove={(event) => {
                    if (drag?.tieId !== tie.id) return;
                    const runEl = (event.currentTarget as Element).parentElement;
                    if (runEl != null) setDrag({ tieId: tie.id, ...atFromPointer(event, runEl) });
                  }}
                  onPointerUp={() => {
                    if (drag?.tieId !== tie.id || actions == null) return;
                    if (drag.off) actions.removeTie(tie.id);
                    else if (drag.at !== tie.at) actions.moveTie(tie.id, drag.at);
                    setDrag(null);
                  }}
                  onPointerCancel={() => setDrag(null)}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
}
