import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { createDesign, renameDesign, sortDesignsByRecency, type DesignSummary } from '../../api/designs';
import { ApiRefusal } from '../../api/errors';
import { fetchFile, storeFile } from '../../api/files';
import { openDesign } from '../../api/payload';
import type { Scope } from '../../api/scopes';
import { emptyDocument, type Document } from '../../document/model';
import { readPlain, writePlain } from '../../document/plain';
import {
  addRoom,
  areaM2,
  floorPlansOf,
  removeRoom,
  renameRoom,
  roomsOf,
  scaleFromPoints,
  setFloorPlanImage,
  setFloorPlanScale,
  type FloorPlanView,
  type Point,
  type RoomView,
} from '../../document/rooms';
import { getSession } from '../../state/sessionState';
import { ConditionalSave } from '../design/conditionalSave';
import { canDrawFor, describeError } from '../design/useDesignSession';
import { closesRoom, floorBox, labelAt, lengthWords, readDistance, snapPoint } from './roomTrace';

/** The picture a person may drop in: what the server's file store takes as an image. */
const PICTURE_TYPES = 'image/png,image/jpeg,image/webp,image/gif';
const PICTURE_MAX_BYTES = 25 * 1024 * 1024;
/** How many of a building's designs are opened looking for its plan before giving up. */
const LOOK_IN = 5;
/** A click this close, in screen pixels, lands on a corner or closes the room. */
const SNAP_PX = 10;

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; designId: string | null; doc: Document; saver: ConditionalSave | null };

type Mode = { kind: 'view' } | { kind: 'scale'; points: Point[] } | { kind: 'trace'; draft: Point[] } | { kind: 'name'; corners: Point[] };

export interface BuildingPlanProps {
  organisationId: string;
  building: Scope;
  /** The closet folders in this building: a room named as one opens it. */
  closets: readonly Scope[];
  /** Every design the person may open, for finding this building's plan. */
  designs: readonly DesignSummary[];
  /** A plan design was made in the building folder. */
  onDesignMade: (design: DesignSummary) => void;
  /** Opens a closet folder, as its box does. */
  onOpenCloset: (scopeId: string) => void;
}

const hasPlan = (doc: Document) => floorPlansOf(doc).length > 0 || roomsOf(doc).length > 0;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * ADR-0051 and ADR-0074 decision 4: the building's floor plan, drawn at the building stop. A picture
 * of the plan sits beneath at the phantom opacity, scaled by two points a known distance apart;
 * rooms are traced over it with straight-line and right-angle snapping and named. A room named as a
 * closet folder opens that closet. The plan is a design in the building folder, so who may see or
 * change it follows the folder, and every change is in its history.
 */
export function BuildingPlan({ organisationId, building, closets, designs, onDesignMade, onOpenCloset }: BuildingPlanProps) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; reload: boolean } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hidePicture, setHidePicture] = useState(false);
  const [floor, setFloor] = useState<string | null>(null);
  const [pictureUrl, setPictureUrl] = useState<string | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // What the next save builds on, read at the moment of saving rather than from a render's closure.
  const current = useRef<Extract<Loaded, { status: 'ready' }> | null>(null);
  const ready = (next: Extract<Loaded, { status: 'ready' }>) => {
    current.current = next;
    setLoaded(next);
  };
  const canDraw = canDrawFor(building.capability);
  const designsHere = sortDesignsByRecency(designs.filter((d) => d.scopeId === building.scopeId));
  const designKey = designsHere.map((d) => d.designId).join(',');

  const load = useCallback(async () => {
    setLoaded({ status: 'loading' });
    setError(null);
    try {
      for (const d of designsHere.slice(0, LOOK_IN)) {
        const opened = await openDesign(organisationId, d.designId);
        const doc = readPlain(opened.bytes);
        if (hasPlan(doc)) {
          ready({ status: 'ready', designId: d.designId, doc, saver: new ConditionalSave(opened.version) });
          return;
        }
      }
      ready({ status: 'ready', designId: null, doc: emptyDocument(), saver: null });
    } catch (e) {
      setLoaded({ status: 'error', message: describeError(e) });
    }
    // `designKey` stands for `designsHere`: the plan is looked for again only when the folder's designs change.
  }, [organisationId, building.scopeId, designKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const doc = loaded.status === 'ready' ? loaded.doc : emptyDocument();
  const plans = floorPlansOf(doc);
  const rooms = roomsOf(doc);
  const floors = [...new Set([...plans.map((p) => p.floor), ...rooms.map((r) => r.floor ?? '')])].filter((f) => f !== '');
  const shownFloor = floor ?? floors[0] ?? null;
  const plan: FloorPlanView | undefined = plans.find((p) => p.floor === shownFloor) ?? (shownFloor === null ? plans[0] : undefined);
  const roomsHere = rooms.filter((r) => floors.length <= 1 || (r.floor ?? floors[0]) === shownFloor);

  // The picture's bytes are fetched, checked against the hash the plan holds, and shown from memory.
  const designId = loaded.status === 'ready' ? loaded.designId : null;
  useEffect(() => {
    if (!plan?.fileId || !plan.sha256 || !designId) {
      setPictureUrl(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    fetchFile(organisationId, designId, plan.fileId, plan.sha256)
      .then((bytes) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        setPictureUrl(url);
      })
      .catch((e) => !cancelled && setError({ message: `The plan picture could not be shown: ${describeError(e)}`, reload: false }));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [organisationId, designId, plan?.fileId, plan?.sha256]);

  /** Saves `next`, making the plan design in the building folder first if there is none yet. */
  async function commit(next: Document, words: string): Promise<boolean> {
    const at = current.current;
    if (!at) return false;
    setBusy(words);
    setError(null);
    try {
      let { designId: id, saver } = at;
      if (!id || !saver) {
        const made = await createDesign(organisationId, building.scopeId, writePlain(next));
        const name = `${building.displayName} floor plan`;
        await renameDesign(organisationId, made.designId, name).catch(() => undefined);
        const opened = await openDesign(organisationId, made.designId);
        id = made.designId;
        saver = new ConditionalSave(opened.version);
        onDesignMade({ ...made, name });
      } else {
        await saver.save(organisationId, id, writePlain(next));
      }
      ready({ status: 'ready', designId: id, doc: next, saver });
      return true;
    } catch (e) {
      const conflict = e instanceof ApiRefusal && e.status === 409;
      setError({
        message: conflict ? 'Someone else saved this plan since it opened, so this change was not saved. Reload it to carry on.' : describeError(e),
        reload: conflict,
      });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const actor = { actor: getSession()?.accountId ?? '' };

  async function takePicture(file: File | undefined) {
    if (!file || !current.current) return;
    if (file.size > PICTURE_MAX_BYTES) return setError({ message: 'That picture is over 25 MB. Export the page at a lower resolution.', reload: false });
    const floorName = shownFloor ?? 'Ground';
    try {
      setBusy('Reading the picture…');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: file.type }));
      const size = { widthPx: bitmap.width, heightPx: bitmap.height };
      bitmap.close();
      // The picture is stored against the plan design, so a building with no plan yet gets one first.
      if (!current.current.designId && !(await commit(current.current.doc, 'Making the floor plan…'))) return;
      const at = current.current;
      setBusy('Storing the picture…');
      const stored = await storeFile(organisationId, at.designId!, bytes);
      if (stored.media !== 'image') return setError({ message: 'That file is not a picture Fathom can show. Use PNG, JPEG, WebP or GIF.', reload: false });
      const next = setFloorPlanImage(at.doc, floorName, { name: file.name, fileId: stored.fileId, sha256: stored.sha256, ...size }, actor);
      if (await commit(next, 'Putting the picture in…')) {
        setFloor(floorName);
        setMode({ kind: 'scale', points: [] });
      }
    } catch (e) {
      setError({ message: describeError(e), reload: false });
    } finally {
      setBusy(null);
    }
  }

  // ---- Geometry: everything is millimetres on the floor ----------------------------------------
  const um = plan?.umPerPx ?? 1000;
  const picture = plan?.widthPx && plan.heightPx ? { x: 0, y: 0, w: (plan.widthPx * um) / 1000, h: (plan.heightPx * um) / 1000 } : null;
  const allCorners = roomsHere.flatMap((r) => r.corners);
  const box = floorBox(allCorners, picture);
  const unscaled = plan?.fileId != null && plan.umPerPx == null;

  function toFloor(e: ReactPointerEvent<SVGSVGElement>): { p: Point; tol: number } | null {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const at = pt.matrixTransform(ctm.inverse());
    return { p: { x: at.x, y: at.y }, tol: SNAP_PX / ctm.a };
  }

  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (mode.kind !== 'trace' && mode.kind !== 'scale') return;
    const at = toFloor(e);
    if (!at) return;
    setPointer(mode.kind === 'trace' ? snapPoint(mode.draft, at.p, allCorners, at.tol) : at.p);
  }

  function onClick(e: ReactPointerEvent<SVGSVGElement>) {
    const at = toFloor(e);
    if (!at) return;
    if (mode.kind === 'scale') {
      if (mode.points.length < 2) setMode({ kind: 'scale', points: [...mode.points, at.p] });
      return;
    }
    if (mode.kind !== 'trace') return;
    if (closesRoom(mode.draft, at.p, at.tol)) return setMode({ kind: 'name', corners: mode.draft });
    setMode({ kind: 'trace', draft: [...mode.draft, snapPoint(mode.draft, at.p, allCorners, at.tol)] });
  }

  async function saveScale(typed: string) {
    if (mode.kind !== 'scale' || mode.points.length < 2 || !plan) return;
    const mm = readDistance(typed);
    if (mm === null) return setError({ message: 'Type the distance between the two points, such as 4.2 m or 4200 mm.', reload: false });
    // The points were marked over the picture drawn at its current scale; back to its own pixels.
    const [a, b] = mode.points.map((p) => ({ x: (p.x * 1000) / um, y: (p.y * 1000) / um }));
    try {
      const next = setFloorPlanScale(current.current?.doc ?? doc, plan.id, scaleFromPoints(a!, b!, mm), actor);
      if (await commit(next, 'Saving the scale…')) setMode({ kind: 'view' });
    } catch (e) {
      setError({ message: describeError(e), reload: false });
    }
  }

  async function saveRoom(label: string) {
    if (mode.kind !== 'name') return;
    try {
      const made = addRoom(current.current?.doc ?? doc, { label, floor: floors.length > 0 ? shownFloor : null, corners: mode.corners }, actor);
      if (await commit(made.doc, 'Saving the room…')) {
        setMode({ kind: 'view' });
        setSelected(made.roomId);
      }
    } catch (e) {
      setError({ message: describeError(e), reload: false });
    }
  }

  const closetFor = (room: RoomView) => closets.find((c) => sameName(c.displayName, room.label)) ?? null;
  const chosen = rooms.find((r) => r.id === selected) ?? null;

  if (loaded.status === 'loading') return <p className="places-map__note">Looking for this building&rsquo;s floor plan…</p>;
  if (loaded.status === 'error') return <p className="places-map__error">The floor plan could not be opened: {loaded.message}</p>;

  const nothingYet = plans.length === 0 && rooms.length === 0;
  const draft = mode.kind === 'trace' ? mode.draft : mode.kind === 'name' ? mode.corners : [];
  const last = draft[draft.length - 1];

  return (
    <section className="building-plan" aria-label="Floor plan" data-testid="building-plan">
      <div className="building-plan__bar">
        <span className="building-plan__title">Floor plan</span>
        {floors.length > 1 && (
          <select aria-label="Floor" value={shownFloor ?? ''} onChange={(e) => setFloor(e.target.value)}>
            {floors.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
        {canDraw && mode.kind === 'view' && (
          <>
            <label className="building-plan__btn">
              <input type="file" accept={PICTURE_TYPES} hidden data-testid="building-plan-picture" onChange={(e) => void takePicture(e.target.files?.[0])} />
              {plan?.fileId ? 'Replace the picture' : 'Add a plan picture'}
            </label>
            {plan?.fileId && (
              <button type="button" className="building-plan__btn" onClick={() => setMode({ kind: 'scale', points: [] })}>
                Set the scale
              </button>
            )}
            <button
              type="button"
              className="building-plan__btn"
              disabled={unscaled}
              title={unscaled ? 'Set the scale first, so rooms come out the right size' : undefined}
              onClick={() => {
                setSelected(null);
                setMode({ kind: 'trace', draft: [] });
              }}
            >
              Draw a room
            </button>
          </>
        )}
        {mode.kind !== 'view' && (
          <button type="button" className="building-plan__btn" onClick={() => setMode({ kind: 'view' })}>
            Cancel
          </button>
        )}
        {plan?.fileId && (
          <button type="button" className="building-plan__btn" aria-pressed={hidePicture} onClick={() => setHidePicture(!hidePicture)}>
            {hidePicture ? 'Show the picture' : 'Hide the picture'}
          </button>
        )}
      </div>

      <p className="building-plan__hint" aria-live="polite">
        {busy ??
          (mode.kind === 'scale'
            ? mode.points.length < 2
              ? `Click two points on the picture a known distance apart (${mode.points.length} of 2).`
              : 'How far apart are they on the ground?'
            : mode.kind === 'trace'
              ? draft.length < 3
                ? 'Click each corner of the room. Walls snap square to the last one and onto corners already drawn.'
                : 'Click the first corner to close the room.'
              : mode.kind === 'name'
                ? 'Name the room as its door does. A closet folder of the same name opens from it.'
                : nothingYet
                  ? canDraw
                    ? 'No floor plan yet. Add a picture of the plan (a scan, photo or exported page), or draw rooms straight away.'
                    : 'No floor plan yet.'
                  : unscaled
                    ? 'The picture is not scaled yet: set the scale before drawing rooms.'
                    : null)}
      </p>
      {error && (
        <p className="places-map__error" role="alert">
          {error.message}{' '}
          {error.reload && (
            <button type="button" className="building-plan__btn" onClick={() => void load()}>
              Reload
            </button>
          )}
        </p>
      )}

      {mode.kind === 'scale' && mode.points.length === 2 && <DistanceForm onSave={(t) => void saveScale(t)} />}
      {mode.kind === 'name' && <RoomNameForm closets={closets} onSave={(l) => void saveRoom(l)} />}

      <svg
        ref={svgRef}
        className={`building-plan__floor${mode.kind === 'trace' || mode.kind === 'scale' ? ' building-plan__floor--drawing' : ''}`}
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Floor plan of ${building.displayName}`}
        onPointerMove={onMove}
        onPointerUp={onClick}
        onPointerLeave={() => setPointer(null)}
      >
        {picture && pictureUrl && !hidePicture && (
          <image className="building-plan__picture" href={pictureUrl} x={picture.x} y={picture.y} width={picture.w} height={picture.h} preserveAspectRatio="none" />
        )}
        {roomsHere.map((room) => {
          const closet = closetFor(room);
          const at = labelAt(room.corners);
          return (
            <g
              key={room.id}
              className={`building-plan__room${room.id === selected ? ' building-plan__room--selected' : ''}${closet ? ' building-plan__room--closet' : ''}`}
              data-testid="building-plan-room"
              onPointerUp={(e) => {
                if (mode.kind !== 'view') return;
                e.stopPropagation();
                setSelected(room.id);
              }}
              onDoubleClick={() => closet && onOpenCloset(closet.scopeId)}
            >
              <polygon points={room.corners.map((c) => `${c.x},${c.y}`).join(' ')} vectorEffect="non-scaling-stroke" />
              <text x={at.x} y={at.y} textAnchor="middle" dominantBaseline="middle" fontSize={Math.max(box.w, box.h) / 45}>
                {room.label}
              </text>
            </g>
          );
        })}
        {draft.length > 0 && (
          <polyline
            className="building-plan__draft"
            points={[...draft, ...(mode.kind === 'trace' && pointer ? [pointer] : [])].map((c) => `${c.x},${c.y}`).join(' ')}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {mode.kind === 'trace' && last && pointer && (
          <text className="building-plan__length" x={(last.x + pointer.x) / 2} y={(last.y + pointer.y) / 2} fontSize={Math.max(box.w, box.h) / 60}>
            {lengthWords(Math.hypot(pointer.x - last.x, pointer.y - last.y))}
          </text>
        )}
        {mode.kind === 'scale' &&
          mode.points.map((p, i) => <circle key={i} className="building-plan__mark" cx={p.x} cy={p.y} r={Math.max(box.w, box.h) / 200} />)}
        {mode.kind === 'scale' && mode.points.length === 2 && (
          <line className="building-plan__draft" x1={mode.points[0]!.x} y1={mode.points[0]!.y} x2={mode.points[1]!.x} y2={mode.points[1]!.y} vectorEffect="non-scaling-stroke" />
        )}
      </svg>

      {chosen && mode.kind === 'view' && (
        <RoomPanel
          room={chosen}
          closet={closetFor(chosen)}
          canDraw={canDraw}
          onOpenCloset={onOpenCloset}
          onRename={(label) => void commit(renameRoom(current.current?.doc ?? doc, chosen.id, label, actor), 'Renaming the room…')}
          onRemove={() => void commit(removeRoom(current.current?.doc ?? doc, chosen.id, actor), 'Taking the room out…').then((ok) => ok && setSelected(null))}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function DistanceForm({ onSave }: { onSave: (typed: string) => void }) {
  const [typed, setTyped] = useState('');
  return (
    <form
      className="building-plan__form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(typed);
      }}
    >
      <label>
        Distance on the ground{' '}
        <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="4.2 m" data-testid="building-plan-distance" />
      </label>
      <button type="submit" className="building-plan__btn">
        Save the scale
      </button>
    </form>
  );
}

function RoomNameForm({ closets, onSave }: { closets: readonly Scope[]; onSave: (label: string) => void }) {
  const [label, setLabel] = useState('');
  return (
    <form
      className="building-plan__form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(label);
      }}
    >
      <label>
        Room{' '}
        <input autoFocus list="building-plan-closets" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="214" data-testid="building-plan-room-name" />
      </label>
      <datalist id="building-plan-closets">
        {closets.map((c) => (
          <option key={c.scopeId} value={c.displayName} />
        ))}
      </datalist>
      <button type="submit" className="building-plan__btn">
        Save the room
      </button>
    </form>
  );
}

interface RoomPanelProps {
  room: RoomView;
  closet: Scope | null;
  canDraw: boolean;
  onOpenCloset: (scopeId: string) => void;
  onRename: (label: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

function RoomPanel({ room, closet, canDraw, onOpenCloset, onRename, onRemove, onClose }: RoomPanelProps) {
  const [label, setLabel] = useState(room.label);
  useEffect(() => setLabel(room.label), [room.label]);
  const area = areaM2(room.corners);
  return (
    <aside className="building-plan__panel" aria-label={`Room ${room.label}`} data-testid="building-plan-panel">
      <div className="building-plan__panel-head">
        <span className="building-plan__panel-name">{room.label}</span>
        <button type="button" className="building-plan__btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="places-map__note">
        {area >= 0.1 ? `${area.toFixed(1)} m²` : 'Less than 0.1 m²'} · {room.corners.length} corners
        {room.floor ? ` · floor ${room.floor}` : ''}
      </p>
      {closet ? (
        <button type="button" className="building-plan__btn" onClick={() => onOpenCloset(closet.scopeId)}>
          Open the closet {closet.displayName}
        </button>
      ) : (
        <p className="places-map__note">No closet folder has this name. Name the room as a closet folder to open it from here.</p>
      )}
      {canDraw && (
        <form
          className="building-plan__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim() && label.trim() !== room.label) onRename(label);
          }}
        >
          <label>
            Name <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <button type="submit" className="building-plan__btn">
            Rename
          </button>
          <button type="button" className="building-plan__btn building-plan__btn--danger" onClick={onRemove}>
            Remove the room
          </button>
        </form>
      )}
    </aside>
  );
}
