import { useEffect, useMemo, useState } from 'react';

import { designTitle, type DesignSummary } from '../../api/designs';
import type { Organisation } from '../../api/organisations';
import type { Scope } from '../../api/scopes';
import { getSession } from '../../state/sessionState';
import { whenLabel } from '../history/HistoryPanel';
import { loadRecent, pruneRecent, visibleRecent } from './recent';
import './recent.css';

export interface RecentRowProps {
  organisation: Organisation;
  /** The designs the server lists for this organisation: anything else recent is forgotten. */
  designs: readonly DesignSummary[];
  scopes: readonly Scope[];
  onOpenDesign: (organisation: Organisation, design: DesignSummary) => void;
  onOpenDevice?: (organisation: Organisation, design: DesignSummary, chassisId: string) => void;
}

/** The "Recent" row at the top of Home: what this person opened last on this browser. One click
 * opens it. Drawn only when there is something to show. */
export function RecentRow({ organisation, designs, scopes, onOpenDesign, onOpenDevice }: RecentRowProps) {
  const accountId = getSession()?.accountId ?? null;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    pruneRecent(accountId, organisation.organisationId, designs);
    setTick((n) => n + 1);
  }, [accountId, organisation.organisationId, designs]);
  const view = useMemo(
    () => visibleRecent(loadRecent(accountId), organisation.organisationId, designs),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` re-reads the store after it is pruned
    [accountId, organisation.organisationId, designs, tick],
  );
  const placeOf = (design: DesignSummary) => scopes.find((s) => s.scopeId === design.scopeId)?.displayName ?? organisation.displayName;
  const devices = onOpenDevice != null ? view.devices : [];
  if (view.designs.length === 0 && devices.length === 0) return null;

  return (
    <section className="home__section recent" aria-label="Recent" data-testid="home-recent">
      <div className="home__label">Recent</div>
      <ul className="recent__list">
        {view.designs.map(({ design, at }) => (
          <li key={design.designId}>
            <button type="button" className="recent__card" onClick={() => onOpenDesign(organisation, design)}>
              <span className="recent__name">{designTitle(design)}</span>
              <span className="recent__meta">
                {placeOf(design)} · {whenLabel(at)}
              </span>
            </button>
          </li>
        ))}
        {devices.map(({ design, device }) => (
          <li key={`${device.designId}:${device.chassisId}`}>
            <button type="button" className="recent__card recent__card--device" onClick={() => onOpenDevice?.(organisation, design, device.chassisId)}>
              <span className="recent__kind">Device</span>
              <span className="recent__name">{device.name === '' ? 'Unnamed device' : device.name}</span>
              <span className="recent__meta">
                {designTitle(design)} · {whenLabel(device.at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
