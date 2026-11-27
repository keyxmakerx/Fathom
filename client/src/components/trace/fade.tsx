// The path on the canvas: everything the trace does not touch takes the phantom fade (as Checks' Show does), the
// path's cables draw heavier, and each hop gets a numbered ink circle. No colour. A pressed question's path is
// framed first: the camera moves to it, and goes back when the trace closes.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ViewportPortal, useNodes, useReactFlow, useStore, useStoreApi } from '@xyflow/react';
import type { Edge, Node, ReactFlowState, Viewport } from '@xyflow/react';

import { cableIdsOf, matchShown, type Canon } from '../checks/checksModel';
import { useChecksApi } from '../checks/checksStore';
import { glideOptions } from '../drawing/motion';
import { restyle, type Restyled } from '../drawing/restyledNodes';
import { markBox, markGrow, markText, placeMarks, type Spot } from './marks';
import { pageReader, readPath } from './pathBoxes';
import { PATH_MIN_ZOOM, around, pathCamera, sameCamera, type PathRoom } from './pathFrame';
import { pathKeys } from './traceModel';
import { revealedResult } from './tracePlayback';
import { TraceContext, useTraceFrame, useTraceRevealed, useTraceResult } from './traceStore';
import './tracePlay.css';

const identity: Canon = (id) => id;

const withClass = <T extends { className?: string; data?: unknown }>(item: T, cls: string, data?: object): T => ({
  ...item,
  className: item.className ? `${item.className} ${cls}` : cls,
  ...(data ? { data: { ...(item.data as object | undefined), ...data } } : {}),
});

/** The same arrays, untouched, unless a trace is showing. */
export function useTraceFade(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const result = useTraceResult();
  const revealed = useTraceRevealed();
  const checks = useChecksApi();
  const flow = useStoreApi();
  // The copy each node was last given. A node handed to React Flow as a new object is measured again and its
  // cables leave the page until it has been, which starts a lit cable drawing itself again at every hop.
  const [kept] = useState(() => ({ nodes: new Map<string, Restyled>() }));
  return useMemo(() => {
    const was = kept.nodes;
    const now = new Map<string, Restyled>();
    kept.nodes = now;
    if (result == null) return { nodes, edges };
    const canon = checks?.store.get().canon ?? identity;
    // While the trace plays, only the hops lit so far count; the rest of the canvas stays faded.
    const keys = pathKeys(revealedResult(result, revealed), canon);
    const playing = revealed != null;
    if (keys.size === 0 && !playing) return { nodes, edges };
    const { nodeIds, edgeIds } = matchShown(nodes, edges, keys, canon);
    const held = flow.getState().nodeLookup;
    const dress = (n: Node, cls: string, data?: object) => restyle(was, now, held.get(n.id), n, cls, data);
    return {
      nodes: nodes.map((n) => (nodeIds.has(n.id) ? (playing ? dress(n, 'trace-lit') : n) : dress(n, 'trace-faded', { checksFaded: true }))),
      edges: edges.map((e) => (edgeIds.has(e.id) ? withClass(e, playing ? 'trace-path trace-play' : 'trace-path') : withClass(e, 'trace-faded', { checksFaded: true }))),
    };
  }, [result, revealed, checks, nodes, edges, flow, kept]);
}

/** True for the instant React Flow is measuring an end of one of the path's cables again: the cable is off the
 * page until it has, so where it runs cannot be read. */
function pathAway(state: ReactFlowState, keys: ReadonlySet<string>, edges: readonly Edge[]): boolean {
  const unmeasured = (id: string) => {
    const node = state.nodeLookup.get(id);
    return node != null && node.hidden !== true && node.internals.handleBounds == null;
  };
  return edges.some((e) => cableIdsOf(e).some((c) => keys.has(c)) && (unmeasured(e.source) || unmeasured(e.target)));
}

/** How many animation frames the camera waits for the pane's size to be known before it moves anyway. */
const PANE_WAIT_FRAMES = 40;
/** How long past a glide's own length its end is taken as read, in milliseconds. */
const GLIDE_SLACK_MS = 80;
/** How many animation frames the marks wait for a cable that is off the page before they are placed without it. */
const AWAY_FRAMES = 12;

/** Inside the drawing's React Flow provider: the camera moves to a pressed question's path before its hops light,
 * and goes back when the trace closes unless the person has moved it since. `room` is what the pane has room for
 * once the trace's panel has opened beside it. */
export function TraceCanvasBridge({ room }: { room: () => PathRoom | null }) {
  const store = useContext(TraceContext);
  const frame = useTraceFrame();
  const checks = useChecksApi();
  const rf = useReactFlow();
  const flow = useStoreApi();
  // The camera before the question and the one its path was given: the way back.
  const trip = useRef<{ from: Viewport; to: Viewport } | null>(null);

  useEffect(() => {
    if (store == null) return undefined;
    if (frame == null) {
      const was = trip.current;
      trip.current = null;
      if (was != null && sameCamera(rf.getViewport(), was.to)) void rf.setViewport(was.from, glideOptions());
      return undefined;
    }
    // The drawing came back to a path it has already moved to (a look was switched and switched back).
    if (store.get().framed === frame) return undefined;
    let live = true;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sizeOf = (space: PathRoom | null) => (space == null ? '' : `${space.width}x${space.height}`);
    const canonNow = () => checks?.store.get().canon ?? identity;
    const arrived = () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
      const s = store.get();
      if (s.frame === frame && s.framed !== frame) store.set({ ...s, framed: frame });
    };
    // The camera before the question, kept across a second aim.
    let from: Viewport | null = null;
    const move = (again: boolean) => {
      const root = flow.getState().domNode;
      const space = room();
      const result = store.get().result;
      const page = root == null ? null : pageReader(root);
      if (root == null || space == null || result == null || page == null) return arrived();
      const canon = canonNow();
      const drawn = readPath(root, page, pathKeys(result, canon), canon, rf.getEdges());
      const path = around([...drawn.devices.values(), ...drawn.edges.values()]);
      if (path == null) return arrived();
      // Room for the marks as well. They stand out from what they number by an amount that depends on the zoom,
      // so they are placed for the camera the path alone would get, and once more for the camera that gives.
      let to = pathCamera(path, space);
      for (let pass = 0; pass < 2; pass += 1) {
        const grow = markGrow(to.zoom);
        const marks = placeMarks(result.hops, canon, drawn, grow).map((s) => markBox(s, grow));
        to = pathCamera(around([path, ...marks]) ?? path, space);
      }
      const now = rf.getViewport();
      // A second question asked from the first one's view goes back to where the first was asked from.
      from ??= trip.current != null && sameCamera(now, trip.current.to) ? trip.current.from : now;
      const start = from;
      const aim = to;
      const glide = glideOptions();
      // A drag or the wheel cuts a glide short and its end is then never heard, so a timer says it too.
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(arrived, glide.duration + GLIDE_SLACK_MS);
      void rf.setViewport(aim, glide).then(() => {
        if (!live || !sameCamera(rf.getViewport(), aim)) return;
        // The pane did not end at the size it was read as (a panel opened late): aim once more, at what is there.
        if (!again && sizeOf(room()) !== sizeOf(space)) return move(true);
        trip.current = { from: start, to: aim };
        arrived();
      });
    };
    // The trace's panel may not be on the page yet: move once the pane's size-to-be reads the same twice running
    // and the path's cables are all on the page.
    let last = '';
    let frames = 0;
    const watch = () => {
      const size = sizeOf(room());
      const result = store.get().result;
      const away = result != null && pathAway(flow.getState(), pathKeys(result, canonNow()), rf.getEdges());
      frames += 1;
      if ((size !== '' && size === last && !away) || frames >= PANE_WAIT_FRAMES) move(false);
      else {
        last = size;
        raf = requestAnimationFrame(watch);
      }
    };
    raf = requestAnimationFrame(watch);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      if (timer != null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one move per framed answer, and one back
  }, [frame]);

  return null;
}

/** The camera's zoom, straight from React Flow. */
const zoomOf = (s: ReactFlowState): number => s.transform[2];
const NO_SPOTS: readonly Spot[] = [];

/** Inside the drawing's React Flow: one numbered circle per hop, by the device's corner or on the cable's middle. */
export function TraceBadges() {
  const result = useTraceResult();
  if (result == null) return null;
  return <Badges />;
}

function Badges() {
  const result = useTraceResult()!;
  const revealed = useTraceRevealed();
  const checks = useChecksApi();
  const rf = useReactFlow();
  const flow = useStoreApi();
  const nodes = useNodes();
  const zoom = useStore(zoomOf);
  const grow = markGrow(zoom);
  const [spots, setSpots] = useState(NO_SPOTS);
  // Counted up to look at the page again on the next frame, while a cable of the path is off it.
  const [look, setLook] = useState(0);
  const waited = useRef(0);
  // Nothing is lit until the camera has framed the path, and nothing is placed until then either.
  const unlit = revealed === 0;
  // Once the page has drawn, since a device on a wall, a desk or a shelf is found where the page put it.
  useLayoutEffect(() => {
    const state = flow.getState();
    const root = state.domNode;
    const page = root == null ? null : pageReader(root);
    if (unlit || root == null || page == null) {
      setSpots(NO_SPOTS);
      return undefined;
    }
    const canon = checks?.store.get().canon ?? identity;
    const keys = pathKeys(result, canon);
    const edges = rf.getEdges();
    if (pathAway(state, keys, edges) && waited.current < AWAY_FRAMES) {
      waited.current += 1;
      const raf = requestAnimationFrame(() => setLook((n) => n + 1));
      return () => cancelAnimationFrame(raf);
    }
    waited.current = 0;
    // Every hop is placed at once, so a mark stays where it is while the hops after it light.
    setSpots(placeMarks(result.hops, canon, readPath(root, page, keys, canon, edges), grow));
    return undefined;
  }, [result, unlit, checks, rf, flow, nodes, grow, look]);
  const lit = useMemo(() => (revealed == null ? null : new Set(revealedResult(result, revealed).hops.map((h) => h.n))), [result, revealed]);
  // Further out than a path is ever framed, the marks would be all there is to see: they wait.
  const cls = zoom < PATH_MIN_ZOOM ? 'trace-dot trace-dot--steady trace-dot--far' : 'trace-dot trace-dot--steady';
  return (
    <ViewportPortal>
      {spots.map((s) => {
        const text = markText(s.ns, lit);
        if (text === '') return null;
        // Keyed by its words, so a mark pops again when another hop lands on it.
        return (
          <span
            key={text}
            className={cls}
            data-testid="trace-dot"
            style={{ transform: `translate(${s.x}px, ${s.y}px) translate(-50%, -50%) scale(${grow})`, '--trace-x': `${s.x}px`, '--trace-y': `${s.y}px`, '--trace-grow': grow } as CSSProperties}
          >
            {text}
          </span>
        );
      })}
    </ViewportPortal>
  );
}
