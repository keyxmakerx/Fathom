import type { MouseEvent } from 'react';
import { Handle, Position, useViewport, type Node, type NodeProps } from '@xyflow/react';

import '../../styles/shelf.css';

import { PORT_GLYPHS } from '../ports';
// `ShelfView`/`OccupantView` are this session's own new shapes (ADR-0051
// §1) — read straight off `document/view.ts` for the same reason
// `elevation.ts`'s own file header gives: `./contract.ts` (off limits this
// session) has not widened its re-export list to carry them yet.
import type { OccupantView, ShelfView } from '../../document/view';
import type { PortView, Sheath } from './contract';
import { shelfOccupantFaceplateItems, type Facing } from './elevation';
import {
  U_PX,
  cameraStopAt,
  counterScaledFontPx,
  counterScaledGlyphScale,
  glyphScaleFittingBudget,
} from './geometry';
import { portKindFor } from './portGlyph';
import { SHEATH_VAR } from './sheath';

/** `drawing.css`'s own rack-stop label sizes, mirrored here so
 * `counterScaledFontPx` has the same floor to counter-scale from — see
 * `RackNode.tsx`'s own constants of the same shape. */
const SHELF_LABEL_BASE_PX = 10;
const OCCUPANT_LABEL_BASE_PX = 9;

/** See the file header on `elevation.ts`'s own `shelfOccupantFaceplateItem`:
 * `OccupantView` (this session's CONTRACT) carries no catalogue "role"
 * finer than `kind: 'chassis' | 'passive'` — nothing that names a switch a
 * switch. UI-SPEC "Ports": "Patch-facing gear (switches, panels) shows
 * ports always; everything else reveals on hover or selection." A passive
 * occupant (an outlet block, a stub panel sitting on the shelf) is
 * patch-facing by definition — it has no other job. A `chassis` occupant is
 * read as patch-facing when it carries more than two ports, the plainest
 * line the Shelf board's own three occupants draw: `sw-desk-01`'s eight
 * ports (patch-facing, shown) against `nuc-01`'s two and `ont-01`'s few
 * (both closed at the rack stop). Named here, not asserted as fact, for the
 * lead to confirm or correct — the same caveat `paths.ts`'s own `isPanel`
 * carries for an inferred rule with nothing in the schema to read it off.
 */
function isPatchFacing(occupant: Pick<OccupantView, 'kind' | 'ports'>): boolean {
  return occupant.kind === 'passive' || occupant.ports.length > 2;
}

export interface ShelfPlateNodeData extends Record<string, unknown> {
  shelf: ShelfView;
  elevation: Facing;
  selected: boolean;
  /** `design/places/renders/Shelf.png`: an occupied shelf's own render shows
   * a box per occupant with no gap between them. Neither `ShelfView` nor
   * `api/catalogue.ts` carries a shelf's own slot capacity yet (this
   * session's CONTRACT does not add one) — `null` until a caller can supply
   * one, which draws occupants only, no gap invented for a capacity nobody
   * stated. */
  slotCount: number | null;
  /** Which occupant (if any) is open at the faceplate stop — UI-SPEC
   * "Places" / "Motion" #10: "A box on a shelf opens at the
   * faceplate stop by the same camera as everything else." Opening is the
   * conjunction of this and the camera actually being at the faceplate stop
   * (read locally off `useViewport`, the same way `RackNode`/`ChassisNode`
   * read their own zoom) — never a second, independent toggle. */
  selectedOccupantId: string | null;
  onSelectShelf: () => void;
  onSelectOccupant: (occupantId: string) => void;
  onSelectPort: (portId: string) => void;
  liveDrag: { fromPortId: string; livePortIds: ReadonlySet<string> } | null;
  portSheath: ReadonlyMap<string, Sheath>;
  litCableId: string | null;
}

export type ShelfPlateNodeType = Node<ShelfPlateNodeData, 'shelf'>;

interface GlyphRowProps {
  ports: PortView[];
  scale: number;
  showLabels: boolean;
  onSelectPort: (portId: string) => void;
  liveDrag: ShelfPlateNodeData['liveDrag'];
  portSheath: ShelfPlateNodeData['portSheath'];
  litCableId: string | null;
}

/** One occupant's ports, glyph by glyph — the shared renderer between the
 * compact rack-stop box (small, no labels, shrunk to fit —
 * `glyphScaleFittingBudget`, the same helper `ChassisNode.tsx`'s own
 * `PortRow` uses) and the faceplate-stop inset (`design/places/renders/Shelf.png`'s
 * own middle panel: full glyph size with labels — `counterScaledGlyphScale`,
 * the same "true size" a `ChassisNode`'s own faceplate reads at, never
 * shrunk). Each glyph
 * carries the same kind of `Handle` `ChassisNode.tsx`'s own port glyph does
 * (loose connection mode, `Drawing.tsx`), under the SAME port id, so a
 * cable can start or land on a shelf occupant's port exactly as it does on
 * a rack-mounted chassis's — once `lookup.ts` can find it (this session's
 * own handback note: it does not yet, see the report). */
function GlyphRow({ ports, scale, showLabels, onSelectPort, liveDrag, portSheath, litCableId }: GlyphRowProps) {
  return (
    <div className="drawing-shelf__glyph-row">
      {ports.map((port) => {
        const kind = portKindFor(port.connector);
        if (kind == null) return null;
        const Glyph = PORT_GLYPHS[kind];
        const cable = port.cable ?? null;
        const cabled = cable != null;
        const sheath = cabled ? portSheath.get(port.id) : undefined;

        const isOrigin = liveDrag?.fromPortId === port.id;
        const isLive = isOrigin || (liveDrag != null && liveDrag.livePortIds.has(port.id));
        const dimmedByDrag = liveDrag != null && !isLive;
        const dimmedByLitPath = litCableId != null && cable?.cableId !== litCableId;
        const dimmed = dimmedByDrag || dimmedByLitPath;

        const style: Record<string, string | number> = {};
        if (dimmed) style.opacity = 'var(--phantom)';
        if (sheath != null) style['--port-sheath'] = SHEATH_VAR[sheath];

        return (
          <button
            key={port.id}
            type="button"
            data-port-id={port.id}
            className={
              cabled
                ? 'drawing-shelf__port drawing-shelf__port--cabled nodrag'
                : 'drawing-shelf__port nodrag'
            }
            style={style}
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              onSelectPort(port.id);
            }}
          >
            <Glyph cabled={cabled} title={port.label} scale={scale} />
            {showLabels && (
              <span className="drawing-shelf__port-label">
                {port.label} · {port.connector}
              </span>
            )}
            <Handle
              type="source"
              position={Position.Right}
              id={port.id}
              isConnectable={!cabled}
              className="drawing-shelf__port-handle"
            />
          </button>
        );
      })}
    </div>
  );
}

/** One occupant box at the rack stop — `design/places/renders/Shelf.png`'s
 * own left panel: named boxes left to right by slot, each showing its model
 * or a dotted TYPED mark on a sketch. */
function OccupantBox({
  occupant,
  ports,
  open,
  selected,
  zoom,
  onSelectOccupant,
  onSelectPort,
  liveDrag,
  portSheath,
  litCableId,
}: {
  occupant: OccupantView;
  ports: PortView[];
  open: boolean;
  selected: boolean;
  zoom: number;
  onSelectOccupant: () => void;
  onSelectPort: (portId: string) => void;
  liveDrag: ShelfPlateNodeData['liveDrag'];
  portSheath: ShelfPlateNodeData['portSheath'];
  litCableId: string | null;
}) {
  const patchFacing = isPatchFacing(occupant);
  // `design/places/renders/Shelf.png`: patch-facing gear shows its ports at
  // the rack stop; everything else shows ports only once opened (the inset
  // below) — UI-SPEC "Ports"' own "Patch-facing gear... shows ports always;
  // everything else reveals on hover or selection," applied to a shelf
  // occupant.
  const showCompactPorts = patchFacing && !open;
  const budget = Math.max(0, U_PX - OCCUPANT_LABEL_BASE_PX);
  const compactScale = glyphScaleFittingBudget(zoom, budget);
  const labelFontPx = counterScaledFontPx(OCCUPANT_LABEL_BASE_PX, zoom);

  return (
    <button
      type="button"
      className={
        selected
          ? 'drawing-shelf__occupant drawing-shelf__occupant--selected nodrag'
          : 'drawing-shelf__occupant nodrag'
      }
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        onSelectOccupant();
      }}
    >
      <span className="drawing-shelf__occupant-header">
        <span className="drawing-shelf__occupant-label" style={{ fontSize: labelFontPx }}>
          {occupant.label}
        </span>
        {occupant.sketch && (
          // `design/places/renders/Shelf.png`: a dotted TYPED mark on a
          // sketch — a fact about provenance, not risk, so it carries no
          // colour
          // (UI-SPEC "Look": colour is reserved to error/warning/
          // recommendation/confirmation) — a dotted hairline only, the same
          // device `.drawing-chassis__inlet--unfitted` already uses for "a
          // state with nothing to colour."
          <span className="drawing-shelf__typed" aria-label="typed by hand">
            typed
          </span>
        )}
      </span>
      {!occupant.sketch && occupant.model && <span className="drawing-shelf__occupant-model">{occupant.model}</span>}
      {showCompactPorts && (
        <GlyphRow
          ports={ports}
          scale={compactScale}
          showLabels={false}
          onSelectPort={onSelectPort}
          liveDrag={liveDrag}
          portSheath={portSheath}
          litCableId={litCableId}
        />
      )}
    </button>
  );
}

/** The faceplate-stop inset — `design/places/renders/Shelf.png`'s own
 * middle panel: at the faceplate stop an occupant opens beside the shelf,
 * its ports at full glyph size with labels. Positioned outside the plate's
 * own box (`shelf.css`'s `.drawing-shelf__inset`, `left: 100%`) so it reads
 * as something opening beside the row rather than inside it, exactly that
 * board's own middle panel. It is ordinary flow-space content, a plain
 * child of this same React Flow node — Motion #10's "the same camera as
 * everything else" is then simply true, with nothing extra to build for it:
 * there is no second, independently-scaling layer here. */
function OccupantInset({
  occupant,
  ports,
  zoom,
  onSelectPort,
  liveDrag,
  portSheath,
  litCableId,
}: {
  occupant: OccupantView;
  ports: PortView[];
  zoom: number;
  onSelectPort: (portId: string) => void;
  liveDrag: ShelfPlateNodeData['liveDrag'];
  portSheath: ShelfPlateNodeData['portSheath'];
  litCableId: string | null;
}) {
  const trueScale = counterScaledGlyphScale(zoom);
  const headerFontPx = counterScaledFontPx(OCCUPANT_LABEL_BASE_PX, zoom);
  return (
    <div className={occupant.sketch ? 'drawing-shelf__inset drawing-shelf__inset--sketch' : 'drawing-shelf__inset'}>
      <div className="drawing-shelf__inset-header" style={{ fontSize: headerFontPx }}>
        <span className="drawing-shelf__inset-label">{occupant.label}</span>
        {occupant.model ? (
          <span className="drawing-shelf__inset-model">{occupant.model}</span>
        ) : (
          <span className="drawing-shelf__typed" aria-label="typed by hand">
            no catalogue entry — typed
          </span>
        )}
      </div>
      <GlyphRow
        ports={ports}
        scale={trueScale}
        showLabels
        onSelectPort={onSelectPort}
        liveDrag={liveDrag}
        portSheath={portSheath}
        litCableId={litCableId}
      />
    </div>
  );
}

/** The shelf — `design/places/renders/Shelf.png`: a shelf draws in the rack
 * at its units as a plate labelled with the shelf's label and "SHELF
 * <height>U", its occupants as named boxes left to right by slot. A sibling
 * React Flow node aligned to the rack's own frame exactly as `ChassisNode.tsx` is
 * (`RackNode.tsx`'s own file header: "Chassis are not drawn here... sibling
 * React Flow nodes positioned to align with this rack's frame") — this
 * session's own wiring note (the handback report) is that a caller lays
 * this node out the same way, from `ShelfView.positionU`/`.heightU`, never
 * from `RackView.chassis` (a shelf is never in that list, this session's
 * own CONTRACT). */

/**
 * `design/places/renders/Shelf.png`'s own 2U example gives the plate a
 * header row (the shelf's label and its "SHELF <height>U" tag) above an
 * occupants row — two rows, stacked, the way `ChassisNode.tsx`'s own 1U box
 * stacks a header above a port row. A 1U shelf has only `U_PX` (16
 * flow-space px) total to give both, the same budget a 1U chassis's header
 * and port row already have to share (`ChassisNode.tsx`'s own
 * `HEADER_MIN_PX`/`portsBudgetPx` split) — not enough room left over for a
 * full occupant box's own label-plus-model-plus-ports stack once a header
 * row has taken its share. `'compact'` is the one-row answer this session
 * settled on for exactly that height: the shelf's own name at the left, its
 * occupants as small named boxes to the right, in the SAME row — no "SHELF
 * <height>U" tag, since a 1U row has no room for it. Anything taller draws
 * `'full'`, the two-row layout the board itself shows. */
export function shelfPlateMode(heightU: number): 'compact' | 'full' {
  return heightU <= 1 ? 'compact' : 'full';
}

export function ShelfPlate({ data }: NodeProps<ShelfPlateNodeType>) {
  const {
    shelf,
    elevation,
    selected,
    slotCount,
    selectedOccupantId,
    onSelectShelf,
    onSelectOccupant,
    onSelectPort,
    liveDrag,
    portSheath,
    litCableId,
  } = data;
  const { zoom } = useViewport();
  const zoomPercent = Math.round(zoom * 100);
  const cameraStop = cameraStopAt(zoomPercent);
  const labelFontPx = counterScaledFontPx(SHELF_LABEL_BASE_PX, zoom);
  const height = shelf.heightU * U_PX;

  const items = shelfOccupantFaceplateItems(shelf, elevation);
  const bySlot = new Map(items.map((item) => [item.occupant.slot, item]));
  // `design/places/renders/Shelf.png`: from the shelf's slot count if the
  // catalogue gives one, else occupants only — see
  // `ShelfPlateNodeData.slotCount`'s own doc.
  const slotNumbers: number[] =
    slotCount != null && slotCount > 0
      ? Array.from({ length: slotCount }, (_, i) => i + 1)
      : items.map((i) => i.occupant.slot);

  const openOccupant =
    cameraStop === 'faceplate' && selectedOccupantId != null
      ? items.find((i) => i.occupant.id === selectedOccupantId)
      : undefined;

  // `mode` is read off the shelf's own height alone, the same at every
  // camera stop — a 1U shelf's `height` below stays fixed at one `U_PX`
  // (16 flow px) regardless of zoom, and `.drawing-shelf__header`'s own
  // `min-height` (`shelf.css`) already claims most of that box, so forcing
  // `'full'` at the faceplate stop left `.drawing-shelf__occupants`
  // clipped to nothing rather than legible — a 1U shelf never got the room
  // `ChassisNode.tsx`'s own 1U box has via its glyph-scale budget, since
  // `OccupantBox` does not shrink to fit the way a port row does. Compact
  // mode's own occupant chips stay readable at any height, and the
  // faceplate-stop inset below opens beside them exactly as it would beside
  // the full layout's occupant boxes.
  const mode = shelfPlateMode(shelf.heightU);

  const bundleHandle = (
    // A bundle band's one shared anchor per shelf, the same trick
    // `ChassisNode.tsx`'s own `__bundle__` handle uses, so a bundled cable
    // can still anchor to "the shelf" as a whole at the closet stop even
    // before a per-occupant handle is resolvable.
    <Handle type="source" position={Position.Left} id="__bundle__" className="drawing-shelf__bundle-handle nodrag" />
  );

  if (mode === 'compact') {
    return (
      <div
        className={
          selected ? 'drawing-shelf drawing-shelf--compact drawing-shelf--selected' : 'drawing-shelf drawing-shelf--compact'
        }
        style={{ height }}
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          onSelectShelf();
        }}
      >
        <div className="drawing-shelf__compact-row" style={{ fontSize: labelFontPx }}>
          <span className="drawing-shelf__label">{shelf.label}</span>
          {/* Gap 4: never an empty plate — the shelf's own name above is
              always drawn, occupants or not; this row is simply empty when
              there are none. */}
          <div className="drawing-shelf__compact-occupants">
            {items.map((item) => (
              <button
                key={item.occupant.id}
                type="button"
                className={
                  selectedOccupantId === item.occupant.id
                    ? 'drawing-shelf__compact-occupant drawing-shelf__compact-occupant--selected nodrag'
                    : 'drawing-shelf__compact-occupant nodrag'
                }
                onClick={(event: MouseEvent) => {
                  event.stopPropagation();
                  onSelectOccupant(item.occupant.id);
                }}
              >
                {item.occupant.label}
                {item.ports.map((port) => (
                  <Handle
                    key={port.id}
                    type="source"
                    position={Position.Left}
                    id={port.id}
                    isConnectable={port.cable == null}
                    className="drawing-shelf__compact-port-handle"
                  />
                ))}
              </button>
            ))}
          </div>
        </div>
        {openOccupant && (
          <OccupantInset
            occupant={openOccupant.occupant}
            ports={openOccupant.ports}
            zoom={zoom}
            onSelectPort={onSelectPort}
            liveDrag={liveDrag}
            portSheath={portSheath}
            litCableId={litCableId}
          />
        )}
        {bundleHandle}
      </div>
    );
  }

  return (
    <div
      className={selected ? 'drawing-shelf drawing-shelf--selected' : 'drawing-shelf'}
      style={{ height }}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        onSelectShelf();
      }}
    >
      <div className="drawing-shelf__header" style={{ fontSize: labelFontPx }}>
        <span className="drawing-shelf__label">{shelf.label}</span>
        <span className="drawing-shelf__height">SHELF {shelf.heightU}U</span>
      </div>
      <div className="drawing-shelf__occupants">
        {slotNumbers.map((slot) => {
          const item = bySlot.get(slot);
          if (!item) {
            // `design/places/renders/Shelf.png`: empty slots draw as
            // hatched gaps the way free units do — `.drawing-rack__free`'s
            // own hatch, `shelf.css`'s `.drawing-shelf__gap` shares its
            // token.
            return <div key={`gap-${slot}`} className="drawing-shelf__gap" aria-hidden="true" />;
          }
          return (
            <OccupantBox
              key={item.occupant.id}
              occupant={item.occupant}
              ports={item.ports}
              open={openOccupant?.occupant.id === item.occupant.id}
              selected={selectedOccupantId === item.occupant.id}
              zoom={zoom}
              onSelectOccupant={() => onSelectOccupant(item.occupant.id)}
              onSelectPort={onSelectPort}
              liveDrag={liveDrag}
              portSheath={portSheath}
              litCableId={litCableId}
            />
          );
        })}
      </div>
      {openOccupant && (
        <OccupantInset
          occupant={openOccupant.occupant}
          ports={openOccupant.ports}
          zoom={zoom}
          onSelectPort={onSelectPort}
          liveDrag={liveDrag}
          portSheath={portSheath}
          litCableId={litCableId}
        />
      )}
      {bundleHandle}
    </div>
  );
}
