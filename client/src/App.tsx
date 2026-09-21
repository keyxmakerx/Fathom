import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { fetchDesigns, sortDesignsByRecency, type DesignSummary } from './api/designs';
import type { Organisation } from './api/organisations';
import { buildScopeForest, fetchScopes, pathTo, type Scope, type ScopeTreeNode } from './api/scopes';
import { Console } from './components/console/Console';
import { Enrol } from './components/Enrol';
import { Home } from './components/home';
import type { DirectEntry } from './components/home';
import { Shell } from './components/Shell';
import type { Lens, Place } from './components/Shell';
import { DesignPlace } from './components/design/DesignPlace';
import { PopoverRow } from './components/shell/Popover';
import type { PathPart } from './components/shell/types';
import { SignIn } from './components/SignIn';
import { listKeySlots } from './crypto/keys';
import { initialsFromAddress } from './initials';
import { getSession, subscribe } from './state/sessionState';

/**
 * Which door an unsigned-in visitor is at. Two, and they are not the same
 * thing: `sign-in` uses a key this browser already holds, `enrol` puts one
 * here for the first time by redeeming an invitation. Nobody self-registers
 * (`docs/OPEN-QUESTIONS.md` B5), so neither door creates an account.
 */
type Door = 'sign-in' | 'enrol';

/**
 * Where a signed-in person is.
 *
 * **Home is not a place** — ADR-0047 §1 names exactly two, Racks and
 * Inventory, and Home is what you land on. That is why `Shell` is given
 * `place: null` here rather than a third value: on Home neither word in the
 * bar is marked, and the lens row and zoom are absent because Home is not
 * the camera.
 */
type View =
  | { kind: 'home' }
  | { kind: 'place'; place: Place; organisation: Organisation; design: DesignSummary };

export default function App() {
  const session = useSyncExternalStore(subscribe, getSession);
  const [door, setDoor] = useState<Door>('sign-in');
  const [view, setView] = useState<View>({ kind: 'home' });

  // A browser holding no key at all has nothing to sign in with, so it
  // starts at the enrolment door; one that holds a key starts at sign-in,
  // which lists it. Decided once, from storage, and never over a choice the
  // visitor has already made.
  useEffect(() => {
    let cancelled = false;
    listKeySlots()
      .then(({ enrolled, pending }) => {
        if (!cancelled && enrolled.length === 0 && pending.length === 0) {
          setDoor('enrol');
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The camera's state. It lives here rather than in `Shell` because the
  // drawing Session 4 builds will read it too, and two copies would drift.
  const [lens, setLens] = useState<Lens>('cables');
  const [zoom, setZoom] = useState(100);

  // The open organisation's scope tree and design list, for the bar's path
  // and tree pop-over (ADR-0047 §2, §4). Fetched here rather than read off
  // `Home` — Home's own fetch is scoped to its own render and is gone once
  // a place is open. `[]` on failure or before load: never a fabricated
  // scope or design.
  const openOrganisationId = view.kind === 'place' ? view.organisation.organisationId : null;
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [orgDesigns, setOrgDesigns] = useState<DesignSummary[]>([]);

  useEffect(() => {
    if (openOrganisationId === null) {
      setScopes([]);
      setOrgDesigns([]);
      return;
    }
    let cancelled = false;
    fetchScopes(openOrganisationId)
      .then((rows) => {
        if (!cancelled) setScopes(rows);
      })
      .catch(() => {
        if (!cancelled) setScopes([]);
      });
    fetchDesigns(openOrganisationId)
      .then((rows) => {
        if (!cancelled) setOrgDesigns(rows);
      })
      .catch(() => {
        if (!cancelled) setOrgDesigns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [openOrganisationId]);

  // The most recent design per scope — same ordering Home groups by
  // (`sortDesignsByRecency`) — so a tree row or path part naming a scope
  // can open "that scope's first design" (this task's brief) without
  // inventing which one that is.
  const firstDesignByScopeId = new Map<string, DesignSummary>();
  for (const design of sortDesignsByRecency(orgDesigns)) {
    if (!firstDesignByScopeId.has(design.scopeId)) {
      firstDesignByScopeId.set(design.scopeId, design);
    }
  }

  function selectScope(scopeId: string) {
    const design = firstDesignByScopeId.get(scopeId);
    if (!design) {
      // No design in this scope to switch to — the row/part still exists
      // (a closet can have nothing in it yet), but selecting it does
      // nothing visible, per this task's brief.
      return;
    }
    setView((current) => (current.kind === 'place' ? { ...current, design } : current));
  }

  const openIn = useCallback(
    (place: Place) => (organisation: Organisation, design: DesignSummary) =>
      setView({ kind: 'place', place, organisation, design }),
    [],
  );

  // ADR-0046 §3: "An account with exactly one place to go lands there
  // directly." `Home` decides whether that is true; this decides what it
  // means, which the component deliberately left to its caller. Racks,
  // because the drawing is the product and Inventory is the other way to
  // reach the same graph.
  const handleDirectEntry = useCallback(
    (entry: DirectEntry) =>
      setView({
        kind: 'place',
        place: 'racks',
        organisation: entry.organisation,
        design: entry.design,
      }),
    [],
  );

  if (!session) {
    return door === 'enrol' ? (
      <Enrol onUseExistingKey={() => setDoor('sign-in')} />
    ) : (
      <SignIn onRedeemInvitation={() => setDoor('enrol')} />
    );
  }

  const account = {
    // An operator id is a ulid, whose "initials" would be two digits: the
    // chip says what the session is instead.
    initials: session.kind === 'operator' ? 'OP' : initialsFromAddress(session.address),
    address: session.address,
  };

  // Everything the two views share. `canUndo`/`canRedo`/`onUndo`/`onRedo`
  // are a stub HERE — always present, always disabled — because Home has no
  // open design to undo anything in; `DesignPlace.tsx` overrides all four
  // with the live ones (ADR-0053 §1, off `document/undo.ts`'s `undoable`)
  // the moment a place actually renders, so the bar's chips are real
  // wherever a design is open.
  const common = {
    presence: [],
    canUndo: false,
    canRedo: false,
    onUndo: () => {},
    onRedo: () => {},
    account,
    editor: null,
    lens,
    onLensChange: setLens,
    zoom,
    onZoomIn: () => setZoom((z) => Math.min(400, z + 10)),
    onZoomOut: () => setZoom((z) => Math.max(10, z - 10)),
  };

  if (session.kind === 'operator') {
    // The operator plane has one surface, the console (`docs/UI-SPEC.md`:
    // "Site (operators only)"), and no camera: neither place is marked
    // and no design is ever open here, because none is reachable from an
    // operator session at all (`admin.rs`'s module header).
    return (
      <Shell
        {...common}
        place={null}
        path={[{ label: 'Site' }]}
        tree={null}
        onPlaceChange={() => {}}
      >
        <Console operatorId={session.address} />
      </Shell>
    );
  }

  if (view.kind === 'home') {
    return (
      <Shell
        {...common}
        place={null}
        path={[]}
        tree={null}
        onPlaceChange={() => {
          // Neither place is reachable from Home until something is chosen
          // to open: a place needs a design, and Home is where you pick one.
        }}
      >
        <Home
          address={session.address}
          onOpenRacks={openIn('racks')}
          onOpenInventory={openIn('inventory')}
          onDirectEntry={handleDirectEntry}
        />
      </Shell>
    );
  }

  // The path: the organisation, then the chain of scopes actually returned
  // for the open design's scope (`pathTo` — root-most first, stopping at
  // whatever ancestor came back, never inventing one it did not). Each
  // scope part is selectable: clicking it opens that scope's most recent
  // design in the place already open, mirroring the tree row below.
  const scopeChain = pathTo(scopes, view.design.scopeId);
  const path: PathPart[] = [
    { label: view.organisation.displayName },
    ...scopeChain.map((scope) => ({
      label: scope.displayName,
      onSelect: () => selectScope(scope.scopeId),
    })),
  ];

  // The tree: the forest built from every scope the caller may at least
  // read, one `PopoverRow` per scope, indented by how deep the row sits in
  // that forest (not the server's own `depth`, which would over-indent a
  // scope whose ancestors were withheld). The open design's own scope is
  // marked current.
  const forest = buildScopeForest(scopes);

  const shellPlaceProps = {
    ...common,
    place: view.place,
    path,
    tree: <ScopeTree nodes={forest} currentScopeId={view.design.scopeId} onSelectScope={selectScope} />,
    onPlaceChange: (place: Place) => setView({ ...view, place }),
  };

  // ADR-0046 §8: Inventory is basic-but-real now, not a placeholder — both
  // places are mounted beneath `DesignPlace`, which holds the one
  // `Document`/`SaveQueue` (`useDesignSession`) the two share, so choosing
  // between them here never reloads the design or drops a queued save.
  return (
    <DesignPlace
      {...shellPlaceProps}
      organisationId={view.organisation.organisationId}
      designId={view.design.designId}
      onZoomChange={setZoom}
      capability={view.design.capability}
    />
  );
}

interface ScopeTreeProps {
  nodes: ScopeTreeNode[];
  currentScopeId: string;
  onSelectScope: (scopeId: string) => void;
}

/**
 * The path's tree pop-over content: `buildScopeForest`'s forest, flattened
 * into `PopoverRow`s in forest order, indented per level. Several roots is
 * the ordinary case (an ancestor the caller may not read is simply absent —
 * `scopes.ts`'s own doc), so this walks every root, not one tree.
 */
function ScopeTree({ nodes, currentScopeId, onSelectScope }: ScopeTreeProps) {
  return <>{nodes.map((node) => <ScopeTreeRows key={node.scope.scopeId} node={node} depth={0} currentScopeId={currentScopeId} onSelectScope={onSelectScope} />)}</>;
}

interface ScopeTreeRowsProps {
  node: ScopeTreeNode;
  depth: number;
  currentScopeId: string;
  onSelectScope: (scopeId: string) => void;
}

function ScopeTreeRows({ node, depth, currentScopeId, onSelectScope }: ScopeTreeRowsProps) {
  return (
    <Fragment>
      <PopoverRow current={node.scope.scopeId === currentScopeId} onSelect={() => onSelectScope(node.scope.scopeId)}>
        <span style={{ paddingLeft: `${depth * 12}px` }}>{node.scope.displayName}</span>
      </PopoverRow>
      {node.children.map((child) => (
        <ScopeTreeRows
          key={child.scope.scopeId}
          node={child}
          depth={depth + 1}
          currentScopeId={currentScopeId}
          onSelectScope={onSelectScope}
        />
      ))}
    </Fragment>
  );
}
