import { useState } from 'react';

import type { DesignSummary } from '../../api/designs';
import type { Scope } from '../../api/scopes';
import { placeFormLabel, placeRoleLabel, takesRole } from '../organisation/place';
import { BuildingPlan } from './BuildingPlan';
import { mapView, stopInside, type MapBox, type UpperStop } from './placesMap';
import './places.css';

/** What a box is called in the counts under it. */
const INSIDE_WORD: Record<string, [string, string]> = {
  network: ['building', 'buildings'],
  building: ['closet', 'closets'],
  rack: ['folder', 'folders'],
};
const LEVEL: Record<string, string> = { network: 'Site', building: 'Building', rack: 'Closet' };
const STOP_LABEL: Record<UpperStop, string> = { building: 'Building', site: 'Site', estate: 'Every site' };

export interface PlacesMapProps {
  scopes: readonly Scope[];
  /** The folder of the open design. */
  currentScopeId: string;
  stop: UpperStop;
  /** The building or site this stop is about; ignored at the estate. */
  focusId: string | null;
  designScopeIds: readonly string[];
  /** Move the camera to another upper stop. */
  onGo: (stop: UpperStop, focusId: string | null) => void;
  /** Open the latest design in a folder; absent where the folder has none. */
  onOpenScope: (scopeId: string) => void;
  /** Back down to the open design's closet. */
  onBack: () => void;
  /** ADR-0051: what the building stop's floor plan needs. Absent, no plan is drawn. */
  floorPlan?: {
    organisationId: string;
    designs: readonly DesignSummary[];
    onDesignMade: (design: DesignSummary) => void;
  };
}

/**
 * ADR-0074: the building, site and estate stops, drawn from the folders. A box opens one level
 * in; a closet opens its design. A hub has a double border, and many small sites fold into a
 * counted stack that unfolds on a click.
 */
export function PlacesMap({ scopes, currentScopeId, stop, focusId, designScopeIds, onGo, onOpenScope, onBack, floorPlan }: PlacesMapProps) {
  const view = mapView(scopes, stop, focusId, currentScopeId, designScopeIds);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const inside = stopInside(stop);

  const site = view.place?.kind === 'network' ? view.place : view.place ? scopes.find((s) => s.scopeId === view.place?.parentScopeId) : undefined;

  function open(box: MapBox) {
    if (inside) return onGo(inside, box.scope.scopeId);
    if (box.scope.scopeId === currentScopeId) return onBack();
    if (box.designs > 0) onOpenScope(box.scope.scopeId);
  }

  const shown = [...view.boxes, ...view.stacks.filter((s) => unfolded.has(s.role)).flatMap((s) => s.boxes)];

  return (
    <section className="places-map" aria-label={`${STOP_LABEL[stop]} stop`} data-testid="places-map" data-stop={stop}>
      <header className="places-map__head">
        <nav className="places-map__crumbs" aria-label="Where this is">
          <button type="button" className="places-map__crumb" aria-current={stop === 'estate' ? 'page' : undefined} onClick={() => onGo('estate', null)}>
            Every site
          </button>
          {site && (
            <>
              <span aria-hidden="true">›</span>
              <button type="button" className="places-map__crumb" aria-current={stop === 'site' ? 'page' : undefined} onClick={() => onGo('site', site.scopeId)}>
                {site.displayName}
              </button>
            </>
          )}
          {view.place?.kind === 'building' && (
            <>
              <span aria-hidden="true">›</span>
              <span className="places-map__crumb" aria-current="page">
                {view.place.displayName}
              </span>
            </>
          )}
        </nav>
        {view.place && <PlaceWords scope={view.place} />}
        <button type="button" className="places-map__back" onClick={onBack}>
          Back to the closet
        </button>
      </header>

      {shown.length === 0 && view.stacks.length === 0 ? (
        <p className="places-map__empty">
          {stop === 'estate'
            ? 'No sites you can see yet. A steward makes them in Home › Steward › Folders.'
            : `Nothing inside ${view.place?.displayName ?? 'this folder'} that you can see yet. A steward adds ${stop === 'site' ? 'buildings' : 'closets'} in Home › Steward › Folders.`}
        </p>
      ) : (
        <ul className="places-map__boxes">
          {shown.map((box) => (
            <li key={box.scope.scopeId}>
              <PlaceBox box={box} opens={inside != null || box.here || box.designs > 0} onOpen={() => open(box)} />
            </li>
          ))}
          {view.stacks
            .filter((s) => !unfolded.has(s.role))
            .map((s) => (
              <li key={`stack-${s.role}`}>
                <button
                  type="button"
                  className="places-map__stack"
                  data-testid="places-stack"
                  onClick={() => setUnfolded((cur) => new Set([...cur, s.role]))}
                  title="Show each one"
                >
                  <span className="places-map__stack-count">+{s.boxes.length}</span>
                  <span>{placeRoleLabel(s.role)} sites</span>
                </button>
              </li>
            ))}
        </ul>
      )}

      {stop === 'building' && view.place?.kind === 'building' && floorPlan && (
        <BuildingPlan
          key={view.place.scopeId}
          organisationId={floorPlan.organisationId}
          building={view.place}
          closets={scopes.filter((s) => s.parentScopeId === view.place?.scopeId && s.kind === 'rack')}
          designs={floorPlan.designs}
          onDesignMade={floorPlan.onDesignMade}
          onOpenCloset={(scopeId) => (scopeId === currentScopeId ? onBack() : onOpenScope(scopeId))}
        />
      )}
    </section>
  );
}

function PlaceWords({ scope }: { scope: Scope }) {
  const level = LEVEL[scope.kind] ?? scope.kind;
  const formLabel = placeFormLabel(scope.kind, scope.placeForm);
  // "Closet" twice says nothing: the kind shows only where it adds to the level.
  const form = formLabel === level ? null : formLabel;
  const role = takesRole(scope.kind) ? placeRoleLabel(scope.placeRole) : null;
  return (
    <span className="places-map__words">
      <span className="places-map__level">{level}</span>
      {form && <span>{form}</span>}
      {role && <span className={`places-map__role${scope.placeRole === 'hub' ? ' places-map__role--hub' : ''}`}>{role}</span>}
    </span>
  );
}

function PlaceBox({ box, opens, onOpen }: { box: MapBox; opens: boolean; onOpen: () => void }) {
  const { scope } = box;
  const words = INSIDE_WORD[scope.kind] ?? ['folder', 'folders'];
  const counts = [
    scope.kind !== 'rack' ? `${box.inside} ${box.inside === 1 ? words[0] : words[1]}` : null,
    box.designs === 0 ? 'no design yet' : `${box.designs} ${box.designs === 1 ? 'design' : 'designs'}`,
  ].filter(Boolean);
  const hub = scope.placeRole === 'hub' && takesRole(scope.kind);
  return (
    <button
      type="button"
      className={`places-box${hub ? ' places-box--hub' : ''}${box.here ? ' places-box--here' : ''}`}
      data-testid="places-box"
      disabled={!opens}
      onClick={onOpen}
    >
      <span className="places-box__name">{scope.displayName}</span>
      <PlaceWords scope={scope} />
      <span className="places-box__counts">{counts.join(' · ')}</span>
      {box.here && <span className="places-box__here">You are here</span>}
    </button>
  );
}
