import { useViewport } from '@xyflow/react';

import { UNNAMED_HOSTNAME, type ChassisView } from './contract';

const CARD_W = 210;
/** Gap beside the rack: wide enough on the left to clear a rail name tab. */
const TAB_CLEAR_FLOW = 104;

/** A device's callout: a card that draws itself out to the side, joined to
 * the plate by an animated dotted line in the leader colour. Screen-sized, so
 * it reads the same at every zoom; it follows the device as the camera moves.
 * It hangs off the rack's right, or its left when the pane has no room there.
 * `plate` is the plate's flow-space edges at its middle height. */
export function Callout({
  chassis,
  rackLabel,
  plate,
  rack,
  paneWidth,
  onOpen,
  onDetails,
}: {
  chassis: ChassisView;
  rackLabel: string | null;
  plate: { left: number; right: number; y: number };
  rack: { left: number; right: number };
  paneWidth: number;
  onOpen: () => void;
  onDetails: () => void;
}) {
  const { x, y, zoom } = useViewport();
  const tabClear = 28 + TAB_CLEAR_FLOW * zoom;
  const rightX = rack.right * zoom + x + 28;
  const leftSide = rightX + CARD_W > paneWidth;
  const ax = (leftSide ? plate.left : plate.right) * zoom + x;
  const ay = plate.y * zoom + y;
  const cx = leftSide ? Math.max(CARD_W + 8, rack.left * zoom + x - tabClear) : rightX;
  const cabled = chassis.ports.filter((p) => p.cable != null).length;
  const topU = chassis.positionU + chassis.heightU - 1;
  const where = rackLabel != null ? `${rackLabel} · ${chassis.heightU === 1 ? `U${chassis.positionU}` : `U${chassis.positionU}–U${topU}`}` : null;
  const facts = [chassis.model || null, where].filter(Boolean).join(' · ');
  return (
    <>
      <svg className="drawing-callout__leader" aria-hidden="true">
        <path d={`M ${ax} ${ay} L ${cx} ${ay}`} className="drawing-callout__line" />
        <circle cx={ax} cy={ay} r={2.5} className="drawing-callout__dot" />
      </svg>
      <div className={leftSide ? 'drawing-callout drawing-callout--left' : 'drawing-callout'} role="dialog" aria-label={`${chassis.hostname || UNNAMED_HOSTNAME} summary`} style={{ left: cx, top: ay }}>
        <div className="drawing-callout__name">{chassis.hostname || UNNAMED_HOSTNAME}</div>
        {facts !== '' && <div className="drawing-callout__muted">{facts}</div>}
        {chassis.managementAddress != null && <div>{chassis.managementAddress}</div>}
        <div>
          {cabled} of {chassis.ports.length} ports cabled
        </div>
        <div className="drawing-callout__actions">
          <button type="button" onClick={onOpen}>
            Open
          </button>
          <button type="button" onClick={onDetails}>
            Details
          </button>
        </div>
      </div>
    </>
  );
}
