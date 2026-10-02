import { useMemo, type MouseEvent } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

import { PORT_GLYPHS } from '../ports';
import { CheckBadge } from '../checks/CheckBadge';
import { ABSENT, UNNAMED_HOSTNAME, type ChassisView, type InletView, type PortView, type Sheath } from './contract';
import type { Facing } from './elevation';
import { connectorName, faceplateLayoutFor, plateItems, portWhere, type PortBox } from './faceplate';
import { RAIL_PX, U_PX } from './geometry';
import { useLive } from './liveStore';
import { isPanel } from './paths';
import { pduUsage, pduUsageLabel } from './power';
import { SHEATH_VAR } from './sheath';

/** Counts renders into `window.__cn` when a test harness has set it to a
 * number; otherwise does nothing. */
function countRender(): void {
  const w = globalThis as { __cn?: number };
  if (typeof w.__cn === 'number') w.__cn += 1;
}

/** A rear-elevation power lead's stable handle at the closet and rack
 * stops — `docs/decisions/adr-0050-the-rear-elevation.md` §1. `InletStrip`
 * (below) only mounts its own per-inlet handles when it actually draws —
 * `showInletStrip`, tied to this node's own `elevation` prop — so a lead
 * whose far node flips elevation the same render loses its handle for the
 * one frame between that mount and React Flow's own measurement of it
 * (`Drawing.tsx`'s `resolveEnd` routes here instead at those two stops, the
 * faceplate stop's own zoomed-in read still landing on the inlet itself).
 * One per chassis, not per inlet — "the plate's inlet-end edge (the same
 * side the strip sits on)," never a specific inlet's own position — so the
 * id is a plain constant, exactly like `__bundle__` below. */
export const INLET_ANCHOR_HANDLE_ID = '__inlet-anchor__';

export interface ChassisNodeData extends Record<string, unknown> {
  /** Set by Checks' Show on a plate it fades. */
  checksFaded?: boolean;
  chassis: ChassisView;
  /** This elevation's own faceplate ports (`elevation.ts`'s `faceplateItem`
   * — ADR-0050 §1) — never `chassis.ports` directly, which now carries both
   * faceplates' ports at once (this session's contract). */
  ports: PortView[];
  /** This elevation's own inlets, same filtering as `ports` — drawn in the
   * inlet strip only when `elevation === 'rear'` (`elevation` below); the
   * front elevation's inlets still end their power lead on the rack's own
   * rail hexagon (`RackNode.tsx`), "as today," so this node leaves them off
   * the faceplate there rather than drawing them twice. */
  inlets: InletView[];
  /** ADR-0050 §1: which elevation this chassis is currently drawn in —
   * decides whether the inlet strip draws at all (rear only) and is shown
   * so a caller can tell "rear" apart from "this chassis's own rear-mounted
   * fact," a different reason for the same word. */
  elevation: Facing;
  onSelectPort: (portId: string) => void;
  /** UI-SPEC "Cables": "the port a cable fills takes the sheath colour."
   * `PortView.cable` (this session's contract) names *which* cable fills a
   * port, not its sheath — the sheath lives on the `CableView` the cable's
   * own edge draws from — so `Drawing.tsx` builds this lookup once from
   * `view.cables` and hands it down rather than this component reaching
   * past its own props for the cable list. */
  portSheath: ReadonlyMap<string, Sheath>;
}

/** Every cable id ending on one of this chassis's own ports or inlets. */
function useMyCableIds(chassis: ChassisView): ReadonlySet<string> {
  return useMemo(() => {
    const ids = new Set<string>();
    for (const p of chassis.ports) if (p.cable) ids.add(p.cable.cableId);
    for (const p of chassis.psuInlets) if (p.cable) ids.add(p.cable.cableId);
    return ids;
  }, [chassis]);
}

/** Reads this chassis's own slice of the live store, so a change to another
 * chassis never re-renders this one. */
function useChassisLiveData(chassisId: string, myCableIds: ReadonlySet<string>) {
  const selected = useLive((s) => s.selected?.kind === 'chassis' && s.selected.id === chassisId);
  const litCableId = useLive((s) => (s.litCableId != null && myCableIds.has(s.litCableId) ? s.litCableId : null));
  const dragFromPortId = useLive((s) => s.dragFromPortId);
  const livePortIds = useLive((s) => s.livePortIds);
  const dimmed = useLive((s) => s.dimmedChassisId === chassisId);
  const liveDrag = dragFromPortId != null ? { fromPortId: dragFromPortId, livePortIds } : null;
  return { selected, litCableId, liveDrag, dimmed };
}

export type ChassisNodeType = Node<ChassisNodeData, 'chassis'>;

/** The live drag's fixed end and every port still a valid target. */
export type LiveDrag = { fromPortId: string; livePortIds: ReadonlySet<string> } | null;

/** One port on the plate, drawn where the unit has it. Zoomed out it is only
 * its handle, so a cable still has somewhere to end and no glyph is drawn. */
function PlatePort({
  box,
  port,
  inlet,
  glyphs,
  scale,
  liveDrag,
  portSheath,
  litCableId,
  tip,
  onSelectPort,
  faded,
}: {
  box: PortBox;
  port: PortView;
  inlet: InletView | null;
  glyphs: boolean;
  scale: number;
  liveDrag: LiveDrag;
  portSheath: ChassisNodeData['portSheath'];
  litCableId: string | null;
  tip: string;
  onSelectPort: (portId: string) => void;
  faded: boolean;
}) {
  const cable = port.cable ?? null;
  const cabled = cable != null;
  const isOrigin = liveDrag?.fromPortId === port.id;
  const isLive = isOrigin || (liveDrag != null && liveDrag.livePortIds.has(port.id));
  const dimmed = (liveDrag != null && !isLive) || (inlet != null && litCableId != null && cable?.cableId !== litCableId);
  const style: Record<string, string | number> = { left: box.x, top: box.y, width: box.w, height: box.h };
  // A plate Checks' Show has faded is not dimmed again here.
  if (dimmed && !faded) style.opacity = 'var(--phantom)';
  const sheath = cabled ? portSheath.get(port.id) : undefined;
  if (sheath != null) style['--port-sheath'] = SHEATH_VAR[sheath];
  const handle = (
    <Handle
      type="source"
      position={Position.Bottom}
      id={port.id}
      isConnectable={inlet != null ? inlet.fitted && !cabled : !cabled}
      className="drawing-chassis__port-handle"
    />
  );
  if (!glyphs) {
    return (
      <div data-port-id={port.id} className="drawing-chassis__port drawing-chassis__port--bare" style={style}>
        {handle}
      </div>
    );
  }
  const Glyph = PORT_GLYPHS[box.kind];
  const unfitted = inlet != null && !inlet.fitted;
  return (
    <button
      type="button"
      data-port-id={port.id}
      title={tip}
      className={cabled ? 'drawing-chassis__port drawing-chassis__port--cabled nodrag' : 'drawing-chassis__port nodrag'}
      style={style}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        onSelectPort(port.id);
      }}
    >
      <Glyph
        cabled={cabled}
        title={tip}
        scale={scale}
        className={unfitted ? 'drawing-chassis__inlet--unfitted' : undefined}
      />
      {handle}
    </button>
  );
}

function portTip(port: PortView, layout: ReturnType<typeof faceplateLayoutFor>, inlet: InletView | null): string {
  const where = portWhere(layout, port.id);
  const state = port.cable != null ? 'cabled' : 'free';
  const label = inlet != null ? inlet.slot || inlet.label : port.label ? `Port ${port.label}` : 'Port';
  return [label, connectorName(port.connector), where, inlet != null && !inlet.fitted ? 'not fitted' : state]
    .filter(Boolean)
    .join(' · ');
}

/** The device plate: its ports drawn where the unit has them (`faceplate.ts`),
 * its name in the blank part of the plate and above any cable, or on a tab at
 * the rail when the plate has no room. ADR-0050 §1: draws whichever faceplate
 * (`ports`/`inlets`, already resolved for `elevation`) faces the current
 * elevation. A face with no ports draws as a plain plate, so an empty
 * faceplate still reads as a device, never as a rendering failure.
 *
 * A freshly placed device has no hostname yet and may carry a model the
 * catalogue does not recognise — neither is a reason for the box to go
 * blank: an unset hostname reads as the muted word `UNNAMED_HOSTNAME`, never
 * blank and never invented — same rule, same word, as `Editor.tsx`. */
export function ChassisNode({ data }: NodeProps<ChassisNodeType>) {
  countRender();
  const { chassis, ports, inlets, elevation, onSelectPort, portSheath } = data;
  const myCableIds = useMyCableIds(chassis);
  const { selected, litCableId, liveDrag, dimmed } = useChassisLiveData(chassis.id, myCableIds);
  const glyphs = useLive((s) => s.showPortGlyphs);
  const height = chassis.heightU * U_PX;
  const hasHostname = chassis.hostname.length > 0;
  const shownName = hasHostname ? chassis.hostname : UNNAMED_HOSTNAME;
  const items = plateItems(ports, inlets, elevation);
  const inletIds = useMemo(() => new Map(inlets.map((i) => [i.id, i])), [inlets]);
  const itemById = useMemo(() => new Map(items.map((p) => [p.id, p])), [items]);
  const layout = faceplateLayoutFor(items, chassis.heightU, shownName);
  const passive = isPanel(chassis);
  const usage = pduUsage({ ports });
  const plainPlate = items.length === 0;
  const spot = layout.name;

  const className = [
    'drawing-chassis',
    selected ? 'drawing-chassis--selected' : '',
    // Plate stays above, dimmed, while its config drawer is open.
    dimmed ? 'drawing-chassis-node--dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const marks = (
    <>
      {chassis.singleFed && (
        // UI-SPEC "Power": the word carries the fact, never a bare dot.
        <span className="drawing-chassis__single-fed">single-fed</span>
      )}
      {chassis.oneFitted && <span className="drawing-chassis__one-fitted">one fitted</span>}
    </>
  );
  const nameBlock = (
    <>
      {!passive && <span className="drawing-chassis__bullet" aria-hidden="true" />}
      <span
        className={
          hasHostname ? 'drawing-chassis__hostname' : 'drawing-chassis__hostname drawing-chassis__hostname--placeholder'
        }
      >
        {shownName}
      </span>
    </>
  );

  return (
    <div className="drawing-chassis-wrap" style={{ height }}>
      <CheckBadge id={chassis.deviceId} />
      <div className={className} style={{ height }}>
        {plainPlate ? (
          <div className="drawing-chassis__header">
            {nameBlock}
            {marks}
            <span className="drawing-chassis__model">{usage ? pduUsageLabel(usage) : chassis.model || ABSENT}</span>
          </div>
        ) : (
          <>
            {spot.mode !== 'tab' && (
              <div
                className={`drawing-chassis__name drawing-chassis__name--${spot.mode}`}
                style={{ left: spot.x, top: spot.mode === 'band' ? 1 : 0, width: spot.w, height: spot.mode === 'band' ? undefined : '100%' }}
              >
                {nameBlock}
                {marks}
              </div>
            )}
            <div className="drawing-chassis__ports">
              {layout.boxes.map((box: PortBox) => {
                const port = itemById.get(box.id)!;
                const inlet = inletIds.get(port.id) ?? null;
                return (
                  <PlatePort
                    key={port.id}
                    box={box}
                    port={port}
                    inlet={inlet}
                    glyphs={glyphs}
                    scale={layout.scale}
                    liveDrag={liveDrag}
                    portSheath={portSheath}
                    litCableId={litCableId}
                    tip={glyphs ? portTip(port, layout, inlet) : ''}
                    onSelectPort={onSelectPort}
                    faded={data.checksFaded === true}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>
      {!plainPlate && spot.mode === 'tab' && (
        <div className="drawing-chassis__tab nodrag" style={{ right: `calc(100% + ${RAIL_PX + 2}px)` }}>
          {nameBlock}
          {marks}
        </div>
      )}
      {/* A bundle band's shared anchor: the plate's left-centre, which the
          bundle edge replaces with its members' own port positions. */}
      <Handle type="source" position={Position.Left} id="__bundle__" className="drawing-chassis__bundle-handle nodrag" />
      {/* s6f #1: the rear elevation's stable inlet-end anchor — see
          `INLET_ANCHOR_HANDLE_ID`'s own doc above. */}
      {elevation === 'rear' && (
        <Handle
          type="source"
          position={Position.Right}
          id={INLET_ANCHOR_HANDLE_ID}
          isConnectable={false}
          className="drawing-chassis__inlet-anchor-handle nodrag"
        />
      )}
    </div>
  );
}
