import { useEffect, useLayoutEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { EdgeLabelRenderer, useReactFlow, type Edge, type EdgeProps } from '@xyflow/react';

import { CableCheckBadge } from '../checks/CheckBadge';
import type { PlacedLabel, PortPoint } from './cableEnds';
import { cableShapes, hoverCablesAt, shapeOf } from './cableHover';
import { pointAlong, polylineLength, type Pt, type Tie, type TiedRoute, type Waypoint } from './cableRoute';
import { cableShape, FadedTips, useCableSway } from './cableShape';
import type { CableView } from './contract';
import { FRESH_PLAY_MS, isFreshCable, markCablePlayed } from './cableMotion';
import { useLive, useLiveStore } from './liveStore';
import { PlanEdgeTag } from './PlanGhostEdge';
import { TONE_COLOUR, type PlanEdgeMark } from './plansMarks';
import { StubTags } from './StubTags';
import type { StubEnd } from './stubs';
import { prefersReducedMotion } from './motion';
import { needsHairlineOutline, SHEATH_VAR } from './sheath';
import '../../styles/cable-motion.css';

export interface CableEdgeData extends Record<string, unknown> {
  /** Set by Checks' Show on an edge it fades. */
  checksFaded?: boolean;
  /** Set while an open plan touches this cable: its stage colour and tag. */
  planMark?: PlanEdgeMark;
  /** While "It's down" runs (ADR-0061): sheath colours drop to ink, and the chain's cables carry the lit halo. */
  troubleInk?: boolean;
  troubleLit?: boolean;
  cable: CableView;
  onSelect: (cableId: string) => void;
  onHoverChange: (cableId: string | null) => void;
  /** UI-SPEC "Keeping it readable at forty cables" #2: "the band opens into
   * its members with their port pairs, then folds back." Set only while
   * this cable is drawing as a fanned-out bundle member (`Drawing.tsx`);
   * `undefined` the rest of the time, when a cable draws exactly as before
   * this session. */
  portPairLabel?: string;
  /** Each end's port box in flow space, so the cable leaves the port's own
   * edge; `null` for an end with no port on a plate. */
  ends?: [PortPoint | null, PortPoint | null];
  /** Close in: each end's port label and where to put it. */
  endLabels?: [{ text: string } & PlacedLabel, { text: string } & PlacedLabel];
  /** Far apart: each end draws a short fading run and a tag naming the far end. */
  stub?: [StubEnd, StubEnd];
  onPanTo?: (chassisId: string) => void;
  /** A ticked VLAN group's own trunk member, drawn dashed while that group
   * is on and no other ticked VLAN group also carries it untagged
   * (`cableGroups.ts`'s own `computeCableDraw`); drawn here as a stroke,
   * never a colour (UI-SPEC "Plastic is a line"). */
  dashed?: boolean;
  /** Cable-tied: this cable's place in its bundle (`cableRoute.ts`'s `planTies`). */
  tied?: TiedRoute;
  /** Cable-tied: the bundle's ties, drawn by its first cable. */
  ties?: readonly Tie[];
  /** Cable-tied: real ties on runs (schema 0.21) this cable passes through, in order. */
  waypoints?: readonly Waypoint[];
  /** A bundle's tie dropped at `p`: clips it onto the run there, holding `cableIds`. False when
   * no run was close enough. Absent for a reader. */
  onClipTie?: (p: Pt, cableIds: readonly string[]) => boolean;
}

export type CableEdgeType = Edge<CableEdgeData, 'cable'>;

const STROKE_WIDTH_VAR: Record<CableView['kind'], string> = {
  copper: 'var(--cable-copper)',
  fibre: 'var(--cable-fibre)',
  power: 'var(--cable-power)',
};

/**
 * The cable itself — UI-SPEC "Cables": sag (`cableSagPath`, `geometry.ts`),
 * "colour is the real sheath," "type is the line, not the hue": copper one
 * stroke, fibre a pair with the pale core, power the heavy stroke in its
 * own lane (`cableSagPath`'s `laneBiasPx`, so a power run's curve leans the
 * opposite way from a data run's rather than sharing a line). A sheath
 * within a hairline of the page (white sheath, black sheath — `sheath.ts`)
 * draws a hairline outline first, underneath.
 *
 * Bundles (cables sharing both ends drawn as one band) and fan-on-hover
 * (the band opening to its members) are UI-SPEC "Keeping it readable at
 * forty cables" #1–2 — the next round, per the session brief. This is
 * where they attach: one `CableEdge` per physical cable today; a bundle
 * would group several `CableView`s onto one edge-shaped band here and fan
 * them out into individual `CableEdge`-shaped paths on hover, without
 * changing anything about how a single cable draws below.
 */
export function CableEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<CableEdgeType>) {
  // Read straight from `liveStore.ts`, so a hover never rebuilds every
  // cable's edge — ahead of the `!data` guard below so these hooks always run.
  const litCableId = useLive((s) => s.litCableId);
  const style = useLive((s) => s.cableStyle);
  const hovered = useLive((s) => (data ? s.hoveredCableId === data.cable.id : false));
  const store = useLiveStore();
  const rf = useReactFlow();
  const litByHover = useLive((s) => (data ? s.litCableIdSet.has(data.cable.id) : false));
  // The colour key lights one colour's cables; the rest dim.
  const offKey = useLive((s) => (data != null && s.keyCableIds != null ? !s.keyCableIds.has(data.cable.id) : false));
  // A cable this person has just made pulls tight and pulses once (`cableMotion.ts`); never a teammate's, never on load.
  const cableId = data?.cable.id ?? '';
  // A bundle's tie being dragged toward a run: where it is now, and the cables it goes round.
  const [tieDrag, setTieDrag] = useState<{ p: Pt; cableIds: readonly string[] } | null>(null);
  const [playing, setPlaying] = useState(
    () => data != null && !prefersReducedMotion() && isFreshCable(cableId, data.cable.ends.flatMap((e) => ('portId' in e ? [e.portId] : []))),
  );
  const leadA = data?.ends?.[0];
  const leadB = data?.ends?.[1];
  const sway = useCableSway(
    style === 'physics' && data != null,
    leadA != null ? leadA.x + leadA.w / 2 : sourceX,
    leadA != null ? leadA.y : sourceY,
    leadB != null ? leadB.x + leadB.w / 2 : targetX,
    leadB != null ? leadB.y : targetY,
  );
  const shape =
    data != null
      ? cableShape({ style, id: cableId, kind: data.cable.kind, ends: data.ends, source: { x: sourceX, y: sourceY }, target: { x: targetX, y: targetY }, tied: data.tied, waypoints: data.waypoints, sway })
      : null;
  // Register this line so the pointer can pick the nearest of several crossing cables (`cableHover.ts`).
  const drawnWhole = data != null && data.stub == null;
  useLayoutEffect(() => {
    if (shape == null || !drawnWhole) return undefined;
    const shapes = cableShapes(store);
    shapes.set(cableId, shapeOf(shape.points));
    return () => {
      shapes.delete(cableId);
    };
  }, [store, cableId, shape?.d, drawnWhole]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing) return undefined;
    markCablePlayed(cableId);
    const t = setTimeout(() => setPlaying(false), FRESH_PLAY_MS + 80);
    return () => clearTimeout(t);
  }, [playing, cableId]);
  if (!data || shape == null) return null;
  const lit = litByHover || data.troubleLit === true;
  const { cable, onSelect, onHoverChange, portPairLabel, endLabels, stub, onPanTo, dashed } = data;
  // Checks' Show fades the whole edge already: do not dim it a second time.
  // The cable under the pointer never dims, even beside a selected one: it draws on top instead.
  const dimmed = data.checksFaded !== true && ((litCableId != null && !lit && !hovered) || offKey);
  const sheath = cable.sheath ?? 'grey';
  const colour = data.troubleInk === true ? 'var(--ink)' : SHEATH_VAR[sheath];
  const strokeWidth = STROKE_WIDTH_VAR[cable.kind];
  const { d, leads } = shape;
  // Faded: only the tips show until the cable is pointed at or selected; then all of it, at once.
  const faded = style === 'faded' && !lit && !hovered && data.troubleLit !== true;
  const opacity = dimmed ? 'var(--phantom)' : 1;
  // The pull is a draw-in along the line, so it needs a normalised length; a dashed cable keeps its own dashes and only pulses.
  const pull = playing && !dashed ? { pathLength: 1, className: 'drawing-cable__pull' } : {};
  const dashArray = dashed ? 'var(--cable-dash)' : undefined;
  // Badges and tags sit halfway along the line as drawn, whatever its style.
  const mid = pointAlong(shape.points, polylineLength(shape.points) / 2);
  const midX = mid.x;
  const midY = mid.y;

  // Off screen at the far end: stubs; while lit (selected, or its tag hovered) the whole cable draws too.
  const stubTags =
    stub != null && leads != null && onPanTo != null ? (
      <StubTags
        id={cable.id}
        colour={colour}
        width={strokeWidth}
        points={[leads.a, leads.b]}
        dirs={[{ dx: 0, dy: leads.a.dir }, { dx: 0, dy: leads.b.dir }]}
        stubs={stub}
        onPanTo={onPanTo}
        onHover={(on) => onHoverChange(on ? cable.id : null)}
      />
    ) : null;
  if (stubTags != null && !lit) {
    return (
      <g className="drawing-cable drawing-cable--stub" data-cable-id={cable.id} style={{ opacity }}>
        {stubTags}
      </g>
    );
  }

  function handleClick(event: ReactMouseEvent) {
    event.stopPropagation();
    // Where cables cross, the click selects the one the pointer picked (nearest, or Tabbed to).
    const picked = store.getState().hoveredCableId;
    onSelect(picked != null && store.getState().hoverStack.includes(picked) ? picked : cable.id);
  }
  function handlePointer(event: ReactMouseEvent) {
    hoverCablesAt(store, rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }

  return (
    <g
      className={['drawing-cable', playing ? 'drawing-cable--fresh' : '', style === 'faded' ? 'drawing-cable--faded' : ''].filter(Boolean).join(' ')}
      data-cable-id={cable.id}
      data-cable-style={style}
      style={{ opacity, cursor: 'pointer' }}
      onClick={handleClick}
    >
      {/* Everything that draws the cable sits in one group the top layer can repeat
          (`CableOverlayEdge.tsx`), so the cable being pointed at draws over the others. */}
      <g id={visualGroupId(cable.id)}>
      {lit && (
        <path
          d={d}
          fill="none"
          stroke="var(--hairline)"
          strokeWidth="var(--cable-halo)"
          strokeLinecap="round"
          className="drawing-cable__halo"
        />
      )}
      {data.planMark != null && (
        <path d={d} fill="none" stroke={TONE_COLOUR[data.planMark.tone]} className="plan-mark__wash" strokeLinecap="round" />
      )}
      {needsHairlineOutline(sheath) && data.troubleInk !== true && !faded && (
        <path
          d={d}
          fill="none"
          stroke="var(--hairline)"
          strokeWidth={`calc(${strokeWidth} + 2px)`}
          strokeLinecap="round"
        />
      )}
      {faded ? (
        <FadedTips id={cable.id} d={d} points={shape.points} colour={colour} width={strokeWidth} />
      ) : cable.kind === 'fibre' ? (
        <>
          <path d={d} fill="none" stroke={colour} strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray={dashArray} {...pull} />
          <path d={d} fill="none" stroke="var(--fibre-core)" strokeWidth="var(--fibre-core-w)" strokeLinecap="round" strokeDasharray={dashArray} {...pull} />
        </>
      ) : (
        <path d={d} fill="none" stroke={colour} strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray={dashArray} {...pull} />
      )}
      {style === 'tied' && data.ties?.map((t, i) => (
        <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className="drawing-cable__tie" />
      ))}
      {playing && <path d={d} fill="none" pathLength={1} strokeWidth={strokeWidth} strokeLinecap="round" className="drawing-cable__pulse" pointerEvents="none" />}
      </g>
      {/* A fatter, invisible stroke widens the click/hover target beyond the
          cable's own thin line — the same reasoning UI-SPEC gives a port
          glyph ("ports fade in as they become big enough to hit"), applied
          to a line rather than a box. */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        pointerEvents="stroke"
        onMouseEnter={handlePointer}
        onMouseMove={handlePointer}
        onMouseLeave={handlePointer}
      />
      {/* A bundle's ties can be picked up and dropped onto a tray or lacing bar, where they clip on. */}
      {style === 'tied' &&
        data.onClipTie != null &&
        data.ties?.map((t, i) => (
          <line
            key={`grab-${i}`}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke="transparent"
            strokeWidth={10}
            pointerEvents="stroke"
            className="drawing-cable__tie-grab nodrag nopan"
            data-testid="cable-tie-grab"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
              setTieDrag({ p: rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }), cableIds: t.cableIds ?? [cable.id] });
            }}
            onPointerMove={(event) => {
              if (tieDrag == null) return;
              setTieDrag({ ...tieDrag, p: rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }) });
            }}
            onPointerUp={() => {
              if (tieDrag != null) data.onClipTie?.(tieDrag.p, tieDrag.cableIds);
              setTieDrag(null);
            }}
            onPointerCancel={() => setTieDrag(null)}
            onClick={(event) => event.stopPropagation()}
          />
        ))}
      {tieDrag != null && (
        <line x1={tieDrag.p.x - 7} y1={tieDrag.p.y} x2={tieDrag.p.x + 7} y2={tieDrag.p.y} className="drawing-cable__tie drawing-cable__tie--dragging" pointerEvents="none" />
      )}
      {data.planMark != null && data.planMark.dashed && (
        <path d={d} fill="none" stroke={TONE_COLOUR[data.planMark.tone]} className="plan-mark__dash" strokeDasharray="5 3" strokeLinecap="round" pointerEvents="none" />
      )}
      {data.planMark != null && <PlanEdgeTag x={midX} y={midY - 14} mark={data.planMark} />}
      <CableCheckBadge id={cable.id} x={midX} y={midY} />
      {portPairLabel != null && (
        // UI-SPEC #2: "each with its own sheath and its port pair
        // labelled" — drawn only for a fanned bundle member, never for an
        // ordinary cable (`portPairLabel` is `undefined` there).
        <text x={midX} y={midY - 6} textAnchor="middle" className="drawing-cable__pair-label">
          {portPairLabel}
        </text>
      )}
      {stubTags}
      {endLabels != null && stubTags == null && leads != null && (
        <EdgeLabelRenderer>
          {([leads.a, leads.b] as const).map((lead, i) => (
            <div
              key={i}
              className="drawing-cable__end-label nodrag nopan"
              style={{ transform: `translate(-50%, -50%) translate(${lead.x + endLabels[i]!.dx}px, ${lead.y + endLabels[i]!.dy}px)` }}
            >
              {endLabels[i]!.text}
            </div>
          ))}
        </EdgeLabelRenderer>
      )}
    </g>
  );
}

/** The id of the group holding everything a cable draws, for the top layer to repeat. */
export function visualGroupId(cableId: string): string {
  return `cable-v-${cableId}`;
}
