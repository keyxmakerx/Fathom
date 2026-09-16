import { useCallback, useState, useSyncExternalStore } from 'react';

import type { DesignSummary } from './api/designs';
import type { Organisation } from './api/organisations';
import { Enrol } from './components/Enrol';
import { Home } from './components/home';
import type { DirectEntry } from './components/home';
import { Shell } from './components/Shell';
import type { Lens, Place } from './components/Shell';
import { SignIn } from './components/SignIn';
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

  // The camera's state. It lives here rather than in `Shell` because the
  // drawing Session 4 builds will read it too, and two copies would drift.
  const [lens, setLens] = useState<Lens>('cables');
  const [zoom, setZoom] = useState(100);

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
    initials: initialsFromAddress(session.address),
    address: session.address,
  };

  // Everything the two views share. Undo and redo are always present and
  // always disabled in this build: nothing here changes the graph yet, and
  // a control that claims otherwise would be a lie about what is built.
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

  return (
    <Shell
      {...common}
      place={view.place}
      // The organisation is all this client can name today. A design has no
      // name of its own and nothing resolves its scope id to one — see
      // `docs/OPEN-QUESTIONS.md` D11, which is why the rest of the path is
      // missing rather than filled with an identifier nobody can read.
      path={[{ label: view.organisation.displayName }]}
      tree={null}
      onPlaceChange={(place) => setView({ ...view, place })}
    >
      <div className="app-placeholder">
        <p>
          {view.place === 'racks'
            ? 'The drawing is not built yet.'
            : 'The inventory is not built yet.'}
        </p>
        <button type="button" onClick={() => setView({ kind: 'home' })}>
          Back to home
        </button>
      </div>
    </Shell>
  );
}
