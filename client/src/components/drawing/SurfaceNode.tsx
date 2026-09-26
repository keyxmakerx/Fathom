import { useMemo, type CSSProperties, type MouseEvent } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

import '../../styles/drawing.css';

import { PORT_GLYPHS } from '../ports';
// `FixtureView`/`SurfaceView` come from `document/view.ts`, the one place
// they are declared; `./contract.ts` does not re-export them yet.
import type { FixtureView } from '../../document/view';
import type { LiveDrag } from './ChassisNode';
import type { InletView, PortView, Sheath } from './contract';
import { useLive } from './liveStore';
import { portKindFor } from './portGlyph';
import { isOneFitted, isSingleFed, pduUsage, pduUsageLabel } from './power';
import type { SurfacePlacement } from './rows';
import { mmRailTicks, mmToPx } from './rows';
import { SHEATH_VAR } from './sheath';

/**
 * A closet surface — `docs/decisions/adr-0051-shelves-surfaces-the-room-and-blueprints.md`
 * §1/§2, `docs/UI-SPEC.md` "Places", `design/places/renders/Surfaces.png`.
 * A wall/desk/ceiling draws as a flat elevation beside the rack rows, the
 * same faceplate machinery a rack elevation already uses (name, model,
 * ports, PSU inlets, single-fed/one-fitted washes) but at ONE face — UI-SPEC
 * "A surface has no rear and no flip." A floor draws instead as a band
 * beneath the rows, its fixtures standing upright along it. Either way this
 * is one React Flow node per `SurfaceView` (`nodeId.ts`'s `surfaceNodeId`):
 * a board and its own nested fixtures are ordinary content INSIDE that one
 * node, never nodes of their own — the same "one node, many boxes inside
 * it" shape `ShelfPlate.tsx` already uses for a shelf's own occupants.
 *
 * **The scale rule.** Every millimetre fact this node draws (`FixedTo.x_mm`/
 * `.y_mm`, `Surface.width_mm`) is scaled by `rows.ts`'s `pxPerMm`/`mmToPx` —
 * one U is 44.45mm (`rows.ts`'s `MM_PER_U`, the EIA-310 unit a rack
 * elevation is already built to) against `uPx` (`geometry.ts`'s `U_PX`,
 * handed down from `Drawing.tsx`), so a metre of wall and a metre of rack
 * read the same number of flow pixels. A panel's own drawn HEIGHT is not
 * derived from millimetres at all — it draws at the height of a rack
 * (`design/places/renders/Surfaces.png`, ADR-0051 §1/§2) — it is
 * `Drawing.tsx`'s own `panelHeightPx`
 * (`placement.heightPx`, `rows.ts`'s `layoutSurfaces`), the representative
 * rack's own drawn height, so a wall visually lines up with the row it
 * stands beside regardless of what (or whether) `Surface.height_mm` says.
 */
export interface SurfaceNodeData extends Record<string, unknown> {
  placement: SurfacePlacement;
  /** `geometry.ts`'s `U_PX` — see the file header's "the scale rule." */
  uPx: number;
  onSelectPort: (portId: string) => void;
  /** ADR-0051 §1/§2 — clicking a fixture's own box (its header, for a board)
   * selects it, `contract.ts`'s `Selection` `'fixture'` kind. A click on one
   * of the fixture's own ports (`PortGlyphs`/`InletStrip` below) already
   * stops the event there and calls `onSelectPort` instead, so the two never
   * fire for the same click. */
  onSelectFixture: (fixtureId: string) => void;
  portSheath: ReadonlyMap<string, Sheath>;
}

export type SurfaceNodeType = Node<SurfaceNodeData, 'surface'>;

/** Every cable id ending on one of this surface's own fixtures. */
function collectCableIds(fixtures: readonly FixtureView[], ids: Set<string>): void {
  for (const f of fixtures) {
    for (const p of f.ports) if (p.cable) ids.add(p.cable.cableId);
    for (const p of f.psuInlets) if (p.cable) ids.add(p.cable.cableId);
    collectCableIds(f.fixtures, ids);
  }
}

function useMyCableIds(fixtures: readonly FixtureView[]): ReadonlySet<string> {
  return useMemo(() => {
    const ids = new Set<string>();
    collectCableIds(fixtures, ids);
    return ids;
  }, [fixtures]);
}

/** The lit cable and drag state live in the external store; the lit-cable
 * selector answers for this surface's own fixtures alone. */
function useSurfaceLiveData(myCableIds: ReadonlySet<string>) {
  const litCableId = useLive((s) => (s.litCableId != null && myCableIds.has(s.litCableId) ? s.litCableId : null));
  const dragFromPortId = useLive((s) => s.dragFromPortId);
  const livePortIds = useLive((s) => s.livePortIds);
  const liveDrag: LiveDrag = dragFromPortId != null ? { fromPortId: dragFromPortId, livePortIds } : null;
  return { litCableId, liveDrag };
}

const HEADER_PX = 16;
const RAIL_GUTTER_PX = 26;
const FIXTURE_WIDTH_PX = 92;
const FIXTURE_MIN_HEIGHT_PX = 34;
const FLOOR_FIXTURE_WIDTH_PX = 40;
const FLOOR_FIXTURE_HEIGHT_PX = 64;
const BOARD_PADDING_PX = 14;
const BOARD_MIN_WIDTH_PX = 150;
const BOARD_MIN_HEIGHT_PX = 70;

/** `design/places/renders/Surfaces.png` (ADR-0051 §1/§2): a fixture with no
 * position sits in a "not measured" strip at the panel's foot with its
 * name — that strip is for a fixture with NEITHER coordinate recorded.
 * `FixedTo.x_mm`/`.y_mm` each
 * carry an independent `card: "0..1"` (`schema/schema.yaml`) — a fixture
 * measured on only one axis is a real, distinct fact (e.g. a floor UPS
 * whose distance along the wall is known but whose depth was never taped),
 * so ANY coordinate present is enough to place it on the stage; `positionOf`
 * below fills the other axis from this surface's own zero (the left edge /
 * the floor — the same default `FloorBand`'s unmeasured fixtures already
 * fall back to) rather than discarding the one measurement that exists. */
function isPositioned(f: Pick<FixtureView, 'xMm' | 'yMm'>): boolean {
  return f.xMm != null || f.yMm != null;
}

/** `left`/`bottom` for a fixture on its surface's own stage — whichever of
 * `xMm`/`yMm` is null reads as this surface's own zero, per `isPositioned`'s
 * own doc, rather than `!`-asserted into a value that was never measured. */
function positionStyle(f: Pick<FixtureView, 'xMm' | 'yMm'>, uPx: number): CSSProperties {
  return {
    left: mmToPx(f.xMm ?? 0, uPx),
    bottom: mmToPx(f.yMm ?? 0, uPx),
  };
}

/** True when exactly one of a positioned fixture's two axes is measured —
 * `FixtureBox`'s own cue that the box's position is partly invented, not a
 * fact this document holds on both axes. */
function isPartiallyMeasured(f: Pick<FixtureView, 'xMm' | 'yMm'>): boolean {
  return (f.xMm == null) !== (f.yMm == null);
}

interface PlateProps {
  ports: readonly PortView[];
  onSelectPort: (portId: string) => void;
  liveDrag: LiveDrag;
  portSheath: SurfaceNodeData['portSheath'];
  litCableId: string | null;
}

/** One row of port glyphs — non-uplink left, uplink right, UI-SPEC "Ports":
 * "uplinks right", the same shape `ChassisNode.tsx`'s `PortRow` keeps. */
function PortGlyphs({ ports, onSelectPort, liveDrag, portSheath, litCableId }: PlateProps) {
  if (ports.length === 0) return null;
  const downlink = ports.filter((p) => !p.uplink);
  const uplink = ports.filter((p) => p.uplink);
  const glyph = (port: PortView) => {
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
    const style: Record<string, string | number> = {};
    if (dimmedByDrag || dimmedByLitPath) style.opacity = 'var(--phantom)';
    if (sheath != null) style['--port-sheath'] = SHEATH_VAR[sheath];
    return (
      <button
        key={port.id}
        type="button"
        data-port-id={port.id}
        className={cabled ? 'drawing-surface__port drawing-surface__port--cabled nodrag' : 'drawing-surface__port nodrag'}
        style={style}
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          onSelectPort(port.id);
        }}
      >
        <Glyph cabled={cabled} title={port.label} className="drawing-port-glyph--zoomed" />
        <Handle type="source" position={Position.Right} id={port.id} isConnectable={!cabled} className="drawing-surface__port-handle" />
      </button>
    );
  };
  return (
    <div className="drawing-surface__port-row">
      <div className="drawing-surface__port-group">{downlink.map(glyph)}</div>
      <div className="drawing-surface__port-group drawing-surface__port-group--uplink">{uplink.map(glyph)}</div>
    </div>
  );
}

/** A fixture's own PSU inlets, in a strip — `design/places/renders/Surfaces.png`
 * (ADR-0051 §1/§2): a fixture draws like a chassis plate, its power inlets
 * in the strip. Unlike `ChassisNode.tsx`'s own `InletStrip` this is never gated on an
 * elevation (`ChassisNode`'s `elevation === 'rear'`) — "a surface has no
 * rear" — so a fixture's inlets show whenever it has any, always at full
 * opacity like `ChassisNode.tsx`'s own choice for the same strip. */
function InletStrip({
  inlets,
  onSelectPort,
  litCableId,
}: {
  inlets: readonly InletView[];
  onSelectPort: (portId: string) => void;
  litCableId: string | null;
}) {
  if (inlets.length === 0) return null;
  return (
    <div className="drawing-surface__port-row">
      <div className="drawing-surface__port-group drawing-surface__port-group--uplink">
        {inlets.map((inlet) => {
          const cabled = inlet.cable != null;
          const dimmed = litCableId != null && inlet.cable?.cableId !== litCableId;
          const Glyph = PORT_GLYPHS.c14;
          return (
            <button
              key={inlet.id}
              type="button"
              data-port-id={inlet.id}
              className={cabled ? 'drawing-surface__port drawing-surface__port--cabled nodrag' : 'drawing-surface__port nodrag'}
              style={dimmed ? { opacity: 'var(--phantom)' } : undefined}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                onSelectPort(inlet.id);
              }}
            >
              <Glyph
                cabled={cabled}
                title={`${inlet.slot || inlet.label} — ${inlet.fitted ? (cabled ? 'fed' : 'fitted, no lead') : 'not fitted'}`}
                className={
                  inlet.fitted ? 'drawing-port-glyph--zoomed' : 'drawing-port-glyph--zoomed drawing-chassis__inlet--unfitted'
                }
              />
              <Handle
                type="source"
                position={Position.Right}
                id={inlet.id}
                isConnectable={inlet.fitted && !cabled}
                className="drawing-surface__port-handle"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface FixtureBoxProps {
  fixture: FixtureView;
  uPx: number;
  onSelectPort: (portId: string) => void;
  onSelectFixture: (fixtureId: string) => void;
  liveDrag: LiveDrag;
  portSheath: SurfaceNodeData['portSheath'];
  litCableId: string | null;
  /** True for a fixture drawn upright on the floor band — fixtures on it
   * stand as upright boxes (`design/places/renders/Surfaces.png`, ADR-0051
   * §1/§2). Only changes the
   * box's own footprint (`FLOOR_FIXTURE_*` vs `FIXTURE_WIDTH_PX`), never the
   * plate content inside it — a UPS on the floor reads the same faceplate
   * language as an ONT on the wall. */
  upright?: boolean;
}

/** ADR-0051 §1 — "a board carries its own fixtures." A board fixture
 * (`FixtureView.form === 'board'`) has no `Surface.width_mm`/`.height_mm`
 * analogue of its own anywhere in schema 0.8 — rule 3, "a field not in
 * `schema/` does not exist" — so its own drawn size is inferred from the
 * bounding box of whatever it carries, padded, rather than invented from
 * nothing; a board with nothing positioned on it yet draws at a plain
 * minimum size. */
function boardContentSizePx(fixtures: readonly FixtureView[], uPx: number): { widthPx: number; heightPx: number } {
  const positioned = fixtures.filter(isPositioned);
  if (positioned.length === 0) return { widthPx: BOARD_MIN_WIDTH_PX, heightPx: BOARD_MIN_HEIGHT_PX };
  const maxX = Math.max(...positioned.map((f) => mmToPx(f.xMm ?? 0, uPx)));
  const maxY = Math.max(...positioned.map((f) => mmToPx(f.yMm ?? 0, uPx)));
  return {
    widthPx: Math.max(BOARD_MIN_WIDTH_PX, maxX + FIXTURE_WIDTH_PX + BOARD_PADDING_PX),
    heightPx: Math.max(BOARD_MIN_HEIGHT_PX, maxY + FIXTURE_MIN_HEIGHT_PX + BOARD_PADDING_PX),
  };
}

/** One fixture — `design/places/renders/Surfaces.png` (ADR-0051 §1/§2): a
 * fixture draws like a chassis plate: name, model, ports at the faceplate
 * stop, its power inlets in the strip, single-fed and one-fitted washes as
 * a chassis has them. `singleFed`/`oneFitted` are not carried on `FixtureView` itself
 * (unlike `ChassisView`, ADR-0050 §4) — this session derives them from
 * `fixture.psuInlets` with `power.ts`'s own mirrored rule
 * (`isSingleFed`/`isOneFitted`, that module's own file header on why).
 * `form === 'board'` recurses: the board draws as its own labelled
 * rectangle, `boardContentSizePx` above sizing it, and every child fixture
 * on it positions from the BOARD's own edges (`FixedTo`'s own schema doc)
 * rather than the wall's — a second, nested coordinate space, one level
 * deep (schema 0.8 gives a board no further nesting of its own). */
function FixtureBox({
  fixture,
  uPx,
  onSelectPort,
  onSelectFixture,
  liveDrag,
  portSheath,
  litCableId,
  upright = false,
}: FixtureBoxProps) {
  if (fixture.form === 'board') {
    const { widthPx, heightPx } = boardContentSizePx(fixture.fixtures, uPx);
    const children = fixture.fixtures.filter(isPositioned);
    const unmeasuredChildren = fixture.fixtures.filter((f) => !isPositioned(f));
    return (
      <div className="drawing-surface__board" style={{ width: widthPx, height: heightPx }}>
        <div
          className="drawing-surface__board-header nodrag"
          style={{ cursor: 'pointer' }}
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            onSelectFixture(fixture.id);
          }}
        >
          <span className="drawing-surface__fixture-label">{fixture.label}</span>
          {fixture.model && <span className="drawing-surface__fixture-model">{fixture.model}</span>}
        </div>
        {fixture.ports.length > 0 && (
          <PortGlyphs ports={fixture.ports} onSelectPort={onSelectPort} liveDrag={liveDrag} portSheath={portSheath} litCableId={litCableId} />
        )}
        <div className="drawing-surface__board-stage">
          {/* A board's own children position from ITS edges, not the
              wall's — the same from-left/from-floor convention one level
              down, anchored to the board's own bottom-left. */}
          {children.map((child) => (
            <div key={child.id} className="drawing-surface__fixture-anchor" style={positionStyle(child, uPx)}>
              {isPartiallyMeasured(child) && (
                <span className="drawing-surface__fixture-partial">{child.xMm == null ? 'x not measured' : 'y not measured'}</span>
              )}
              <FixtureBox
                fixture={child}
                uPx={uPx}
                onSelectPort={onSelectPort}
                onSelectFixture={onSelectFixture}
                liveDrag={liveDrag}
                portSheath={portSheath}
                litCableId={litCableId}
              />
            </div>
          ))}
        </div>
        {unmeasuredChildren.length > 0 && (
          <div className="drawing-surface__unmeasured drawing-surface__unmeasured--board">
            <span className="drawing-surface__unmeasured-label">not measured</span>
            {unmeasuredChildren.map((f) => (
              <NotMeasuredEntry
                key={f.id}
                fixture={f}
                uPx={uPx}
                onSelectPort={onSelectPort}
                onSelectFixture={onSelectFixture}
                liveDrag={liveDrag}
                portSheath={portSheath}
                litCableId={litCableId}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const singleFed = isSingleFed(fixture.psuInlets);
  const oneFitted = isOneFitted(fixture.psuInlets);
  const usage = pduUsage({ ports: fixture.ports });
  const noCatalogueEntry = fixture.model == null;

  return (
    <div
      className={
        upright
          ? 'drawing-surface__fixture drawing-surface__fixture--upright nodrag'
          : 'drawing-surface__fixture nodrag'
      }
      style={{
        width: upright ? FLOOR_FIXTURE_WIDTH_PX : FIXTURE_WIDTH_PX,
        minHeight: upright ? FLOOR_FIXTURE_HEIGHT_PX : FIXTURE_MIN_HEIGHT_PX,
        cursor: 'pointer',
      }}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        onSelectFixture(fixture.id);
      }}
    >
      <div className="drawing-surface__fixture-header">
        <span className="drawing-surface__fixture-label">{fixture.label}</span>
        {singleFed && <span className="drawing-chassis__single-fed">single-fed</span>}
        {oneFitted && <span className="drawing-chassis__one-fitted">one fitted</span>}
      </div>
      {/* Short: the fixture box is fixed-width (92px, 40px on the floor),
          always too small for "no catalogue entry — typed" in full. */}
      {noCatalogueEntry ? (
        <span className="drawing-surface__typed" aria-label="no catalogue entry — typed by hand">
          typed
        </span>
      ) : (
        <span className="drawing-surface__fixture-model">{usage ? pduUsageLabel(usage) : fixture.model}</span>
      )}
      {fixture.ports.length > 0 && (
        <PortGlyphs ports={fixture.ports} onSelectPort={onSelectPort} liveDrag={liveDrag} portSheath={portSheath} litCableId={litCableId} />
      )}
      <InletStrip inlets={fixture.psuInlets} onSelectPort={onSelectPort} litCableId={litCableId} />
      {/* A bundle band's one shared anchor per fixture, the same trick
          `ChassisNode.tsx`'s own `__bundle__` handle uses. */}
      <Handle type="source" position={Position.Left} id="__bundle__" className="drawing-surface__bundle-handle nodrag" />
    </div>
  );
}

/** ADR-0051 §1/§2, this session's brief item 3 — a board fixed with no
 * position still shows what it carries: every OTHER unmeasured fixture in
 * the "not measured" strip (`Panel`/`FloorBand`/`FixtureBox`'s own nested
 * `unmeasuredChildren`, below) draws as its bare name, since there is
 * nothing else to show for one — but a board (`fixture.form === 'board'`)
 * carries its own nested fixtures, positioned from ITS edges regardless of
 * whether the board itself has been measured against the wall
 * (`FixtureBox`'s own doc on that nested coordinate space). Drawing it as a
 * bare name here would hide every one of those, so it draws as its own
 * full box instead — the same `FixtureBox` every positioned board already
 * uses — "never as a bare name" (the brief's own words). */
function NotMeasuredEntry({ fixture, uPx, onSelectPort, onSelectFixture, liveDrag, portSheath, litCableId }: FixtureBoxProps) {
  if (fixture.form === 'board') {
    return (
      <FixtureBox
        fixture={fixture}
        uPx={uPx}
        onSelectPort={onSelectPort}
        onSelectFixture={onSelectFixture}
        liveDrag={liveDrag}
        portSheath={portSheath}
        litCableId={litCableId}
      />
    );
  }
  return <span className="drawing-surface__unmeasured-name">{fixture.label}</span>;
}

/** A wall/desk/ceiling — `design/places/renders/Surfaces.png` (ADR-0051
 * §1/§2): a flat panel the height of a rack, a millimetre rail at its left,
 * its fixtures at their positions (xMm from the left edge, yMm from the
 * floor). The elevation body's own coordinate origin is its bottom-left:
 * `left: xMm→px`, `bottom: yMm→px` — the same "0 is the floor" the mm rail
 * itself draws (`mmRailTicks`, `rows.ts`). A fixture with no position
 * (`isPositioned` false) never guesses one — it sits instead in the "not
 * measured" strip at the panel's own foot, named, nothing invented. */
function Panel({ placement, uPx, onSelectPort, onSelectFixture, liveDrag, portSheath, litCableId }: {
  placement: SurfacePlacement;
  uPx: number;
  onSelectPort: (portId: string) => void;
  onSelectFixture: (fixtureId: string) => void;
  liveDrag: LiveDrag;
  portSheath: SurfaceNodeData['portSheath'];
  litCableId: string | null;
}) {
  const { surface } = placement;
  const bodyHeightPx = Math.max(0, placement.heightPx - HEADER_PX);
  const positioned = surface.fixtures.filter(isPositioned);
  const unmeasured = surface.fixtures.filter((f) => !isPositioned(f));
  const ticks = mmRailTicks(bodyHeightPx, uPx);

  return (
    <div className="drawing-surface drawing-surface--panel" style={{ width: placement.widthPx, height: placement.heightPx }}>
      <div className="drawing-surface__header">
        <span className="drawing-surface__label">{surface.label}</span>
        <span className="drawing-surface__form">{surface.form.toUpperCase()}</span>
      </div>
      <div className="drawing-surface__elevation" style={{ height: bodyHeightPx }}>
        <div className="drawing-surface__rail" style={{ width: RAIL_GUTTER_PX }}>
          {ticks.map((mm) => (
            <span key={mm} className="drawing-surface__rail-tick" style={{ bottom: mmToPx(mm, uPx) }}>
              {mm}
            </span>
          ))}
        </div>
        <div className="drawing-surface__stage" style={{ left: RAIL_GUTTER_PX }}>
          {positioned.map((fixture) => {
            return (
              <div key={fixture.id} className="drawing-surface__fixture-anchor" style={positionStyle(fixture, uPx)}>
                {isPartiallyMeasured(fixture) && (
                  <span className="drawing-surface__fixture-partial">
                    {fixture.xMm == null ? 'x not measured' : 'y not measured'}
                  </span>
                )}
                <FixtureBox
                  fixture={fixture}
                  uPx={uPx}
                  onSelectPort={onSelectPort}
                  onSelectFixture={onSelectFixture}
                  liveDrag={liveDrag}
                  portSheath={portSheath}
                  litCableId={litCableId}
                />
              </div>
            );
          })}
        </div>
      </div>
      {unmeasured.length > 0 && (
        <div className="drawing-surface__unmeasured">
          <span className="drawing-surface__unmeasured-label">not measured</span>
          {unmeasured.map((f) => (
            <NotMeasuredEntry
              key={f.id}
              fixture={f}
              uPx={uPx}
              onSelectPort={onSelectPort}
              onSelectFixture={onSelectFixture}
              liveDrag={liveDrag}
              portSheath={portSheath}
              litCableId={litCableId}
            />
          ))}
        </div>
      )}
      {/* A surface has no rear and no flip — named on the plate itself. */}
      <span className="drawing-surface__no-rear" aria-hidden="true">
        no rear · no flip
      </span>
    </div>
  );
}

/** The floor — a band beneath the row's racks; fixtures on it stand as
 * upright boxes at xMm, no mm rail. A fixture with no `xMm` gets no
 * invented distance: it draws in the "not measured" strip instead. */
function FloorBand({ placement, uPx, onSelectPort, onSelectFixture, liveDrag, portSheath, litCableId }: {
  placement: SurfacePlacement;
  uPx: number;
  onSelectPort: (portId: string) => void;
  onSelectFixture: (fixtureId: string) => void;
  liveDrag: LiveDrag;
  portSheath: SurfaceNodeData['portSheath'];
  litCableId: string | null;
}) {
  const { surface } = placement;
  const positioned = surface.fixtures.filter((f) => f.xMm != null);
  const unmeasured = surface.fixtures.filter((f) => f.xMm == null);
  return (
    <div className="drawing-surface drawing-surface--floor" style={{ width: placement.widthPx, height: placement.heightPx }}>
      <div className="drawing-surface__header">
        <span className="drawing-surface__label">{surface.label}</span>
        <span className="drawing-surface__form">FLOOR</span>
      </div>
      <div className="drawing-surface__floor-stage">
        {positioned.map((fixture) => {
          const x = mmToPx(fixture.xMm!, uPx);
          return (
            <div key={fixture.id} className="drawing-surface__floor-anchor" style={{ left: x }}>
              <FixtureBox
                fixture={fixture}
                uPx={uPx}
                onSelectPort={onSelectPort}
                onSelectFixture={onSelectFixture}
                liveDrag={liveDrag}
                portSheath={portSheath}
                litCableId={litCableId}
                upright
              />
            </div>
          );
        })}
      </div>
      {unmeasured.length > 0 && (
        <div className="drawing-surface__unmeasured">
          <span className="drawing-surface__unmeasured-label">not measured</span>
          {unmeasured.map((f) => (
            <NotMeasuredEntry
              key={f.id}
              fixture={f}
              uPx={uPx}
              onSelectPort={onSelectPort}
              onSelectFixture={onSelectFixture}
              liveDrag={liveDrag}
              portSheath={portSheath}
              litCableId={litCableId}
            />
          ))}
        </div>
      )}
      <span className="drawing-surface__no-rear" aria-hidden="true">
        no rear · no flip
      </span>
    </div>
  );
}

/** One `SurfaceView`, at its `rows.ts`-computed placement — `Drawing.tsx`'s
 * own entry point for the closet stop's third kind of box. Dispatches on
 * `surface.form`: every non-floor form draws as `Panel` (an elevation), and
 * `'floor'` draws as `FloorBand` — the two shapes `design/places/renders/Surfaces.png`
 * (ADR-0051 §1/§2) shows. */
export function SurfaceNode({ data }: NodeProps<SurfaceNodeType>) {
  const { placement, uPx, onSelectPort, onSelectFixture, portSheath } = data;
  const myCableIds = useMyCableIds(placement.surface.fixtures);
  const { liveDrag, litCableId } = useSurfaceLiveData(myCableIds);
  const shared = { uPx, onSelectPort, onSelectFixture, liveDrag, portSheath, litCableId };

  if (placement.surface.form === 'floor') {
    return <FloorBand placement={placement} {...shared} />;
  }
  return <Panel placement={placement} {...shared} />;
}
