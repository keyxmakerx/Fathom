import { useEffect, useState } from 'react';

import { signOut } from '../../api/auth';
import { fetchDesigns, sortDesignsByRecency, type DesignSummary } from '../../api/designs';
import { ApiRefusal } from '../../api/errors';
import { fetchOrganisations, type Organisation } from '../../api/organisations';
import { fetchScopes, type Scope } from '../../api/scopes';
import { pickDirectEntry, type DirectEntry } from './directEntry';
import { groupDesignsByScope } from './groupByScope';
import './home.css';

export interface HomeProps {
  /** The signed-in account's address, exactly as `Shell`/`Masthead` already
   * receive it from `App.tsx`'s `session.address` — Home does not read
   * `sessionState` itself. */
  address: string;
  /** Open `design` (within `organisation`) in the Racks place. Home does
   * not navigate on its own — it is a body the caller places below its own
   * bar, per this task's brief — so opening a place is always handed back
   * through a prop. */
  onOpenRacks: (organisation: Organisation, design: DesignSummary) => void;
  /** Open `design` (within `organisation`) in the Inventory place. */
  onOpenInventory: (organisation: Organisation, design: DesignSummary) => void;
  /**
   * ADR-0046 §3: "An account with exactly one place to go lands there
   * directly." `directEntry.ts` decides WHETHER that is true; this is the
   * one call site in the component that acts on it, firing at most once per
   * mount. What "lands there directly" means in practice — which place a
   * landed account opens in — is the caller's to decide once notified; this
   * component only ever computes and reports the fact.
   */
  onDirectEntry: (entry: DirectEntry) => void;
}

type Loadable<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

/**
 * Home: what you see after sign-in. `docs/decisions/adr-0046-two-places-one-editor-and-an-undo-that-records.md`
 * §3 — the organisations you belong to, the closets and designs you may
 * open, and what changed recently. Renders its own rail, centre and right
 * panel (`docs/decisions/adr-0047-the-shell-four-kinds-of-thing.md` §3:
 * "Home keeps its own internal layout... because Home is not the camera")
 * below whatever bar its caller supplies. No bar of its own.
 *
 * Two of the approved board's blocks are not built here: "Needs you"
 * (steward-appointment seconding) and "Recent changes". Neither endpoint
 * exists yet — see this slice's report — and rendering either block with
 * invented content would be exactly the "plausible-looking figure" this
 * project's rules forbid, so they are left off rather than faked empty.
 */
export function Home({ address, onOpenRacks, onOpenInventory, onDirectEntry }: HomeProps) {
  const [organisations, setOrganisations] = useState<Loadable<Organisation[]>>({ status: 'loading' });
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [designs, setDesigns] = useState<Loadable<DesignSummary[]>>({ status: 'loading' });
  const [scopes, setScopes] = useState<Loadable<Scope[]>>({ status: 'loading' });
  const [landed, setLanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchOrganisations()
      .then((orgs) => {
        if (cancelled) return;
        setOrganisations({ status: 'ready', value: orgs });
        setSelectedOrgId((current) => current ?? orgs[0]?.organisationId ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setOrganisations({ status: 'error', message: describeError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedOrgId === null) {
      return;
    }
    let cancelled = false;
    setDesigns({ status: 'loading' });
    fetchDesigns(selectedOrgId)
      .then((rows) => {
        if (cancelled) return;
        setDesigns({ status: 'ready', value: rows });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDesigns({ status: 'error', message: describeError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOrgId]);

  // Every design's row name comes from the scope it hangs under (D11), so
  // Home needs the scope tree for the same organisation it has designs for
  // — fetched alongside, not derived from anything typed here.
  useEffect(() => {
    if (selectedOrgId === null) {
      return;
    }
    let cancelled = false;
    setScopes({ status: 'loading' });
    fetchScopes(selectedOrgId)
      .then((rows) => {
        if (cancelled) return;
        setScopes({ status: 'ready', value: rows });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setScopes({ status: 'error', message: describeError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOrgId]);

  // The "exactly one place to go" rule (ADR-0046 §3). Only decidable once
  // organisations have loaded and, for a sole organisation, its designs
  // have too -- `pickDirectEntry` treats "not yet loaded" as "not one",
  // never as zero, so this cannot misfire mid-load. `landed` latches it so
  // a later reselection or refetch never fires it twice.
  useEffect(() => {
    if (landed || organisations.status !== 'ready') {
      return;
    }
    const soleOrgDesigns =
      organisations.value.length === 1 && designs.status === 'ready' ? designs.value : null;
    const entry = pickDirectEntry(organisations.value, soleOrgDesigns);
    if (entry) {
      setLanded(true);
      onDirectEntry(entry);
    }
  }, [organisations, designs, landed, onDirectEntry]);

  if (landed) {
    return (
      <div className="home home--landing">
        <p>Opening the one design you may open…</p>
      </div>
    );
  }

  const selectedOrganisation =
    organisations.status === 'ready'
      ? organisations.value.find((org) => org.organisationId === selectedOrgId) ?? null
      : null;

  return (
    <div className="home">
      <aside className="home__rail">
        <div className="home__label">Your organisations</div>
        {organisations.status === 'loading' && <p className="home__muted">Loading…</p>}
        {organisations.status === 'error' && <p className="home__error">{organisations.message}</p>}
        {organisations.status === 'ready' && organisations.value.length === 0 && (
          <p className="home__muted">You belong to no organisations yet.</p>
        )}
        {organisations.status === 'ready' && organisations.value.length > 0 && (
          <ul className="home__org-list">
            {organisations.value.map((org) => (
              <li key={org.organisationId}>
                <button
                  type="button"
                  className={
                    org.organisationId === selectedOrgId
                      ? 'home__org-row home__org-row--current'
                      : 'home__org-row'
                  }
                  onClick={() => setSelectedOrgId(org.organisationId)}
                >
                  {org.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main className="home__centre">
        <div className="home__title">{selectedOrganisation?.displayName ?? 'Home'}</div>

        <section className="home__section">
          <div className="home__label">Designs you may open</div>
          {selectedOrgId === null && <p className="home__muted">No organisation selected.</p>}
          {selectedOrgId !== null && (designs.status === 'loading' || scopes.status === 'loading') && (
            <p className="home__muted">Loading…</p>
          )}
          {designs.status === 'error' && <p className="home__error">{designs.message}</p>}
          {designs.status !== 'error' && scopes.status === 'error' && (
            <p className="home__error">{scopes.message}</p>
          )}
          {designs.status === 'ready' && designs.value.length === 0 && (
            <p className="home__muted">No designs in this organisation yet.</p>
          )}
          {designs.status === 'ready' && scopes.status === 'ready' && designs.value.length > 0 && selectedOrganisation && (
            <ScopedDesignList
              designs={sortDesignsByRecency(designs.value)}
              scopes={scopes.value}
              organisation={selectedOrganisation}
              onOpenRacks={onOpenRacks}
              onOpenInventory={onOpenInventory}
            />
          )}
        </section>
      </main>

      <aside className="home__panel">
        <div className="home__label">You</div>
        <div className="home__you-address m">{address}</div>
        <button type="button" className="home__btn" onClick={() => void signOut()}>
          Sign out
        </button>
      </aside>
    </div>
  );
}

interface ScopedDesignListProps {
  designs: DesignSummary[];
  scopes: Scope[];
  organisation: Organisation;
  onOpenRacks: (organisation: Organisation, design: DesignSummary) => void;
  onOpenInventory: (organisation: Organisation, design: DesignSummary) => void;
}

/**
 * The board grouped by closet (D11: a design's scope is its name). One
 * block per scope that has at least one open-able design — the scope's own
 * `display_name` as the block's name, its `kind` as a small label beside
 * it, and a design count that is always read off `designs.length`, never
 * typed. A design whose scope did not come back from `/scopes` (the
 * caller may open it but may not read its closet) is listed last, under
 * "Elsewhere" — an honest heading, not an invented closet.
 */
function ScopedDesignList({ designs, scopes, organisation, onOpenRacks, onOpenInventory }: ScopedDesignListProps) {
  const { groups, elsewhere } = groupDesignsByScope(designs, scopes);

  return (
    <div className="home__scope-groups">
      {groups.map(({ scope, designs: scopeDesigns }) => (
        <div className="home__scope-group" key={scope.scopeId}>
          <div className="home__scope-heading">
            <span className="home__scope-name">{scope.displayName}</span>
            <span className="home__scope-kind">{scope.kind}</span>
            <span className="home__scope-count">
              {scopeDesigns.length} design{scopeDesigns.length === 1 ? '' : 's'}
            </span>
          </div>
          <ul className="home__design-list">
            {scopeDesigns.map((design) => (
              <DesignRow
                key={design.designId}
                design={design}
                organisation={organisation}
                onOpenRacks={onOpenRacks}
                onOpenInventory={onOpenInventory}
              />
            ))}
          </ul>
        </div>
      ))}

      {elsewhere.length > 0 && (
        <div className="home__scope-group" key="elsewhere">
          <div className="home__scope-heading">
            <span className="home__scope-name">Elsewhere</span>
            <span className="home__scope-count">
              {elsewhere.length} design{elsewhere.length === 1 ? '' : 's'}
            </span>
          </div>
          <ul className="home__design-list">
            {elsewhere.map((design) => (
              <DesignRow
                key={design.designId}
                design={design}
                organisation={organisation}
                onOpenRacks={onOpenRacks}
                onOpenInventory={onOpenInventory}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface DesignRowProps {
  design: DesignSummary;
  organisation: Organisation;
  onOpenRacks: (organisation: Organisation, design: DesignSummary) => void;
  onOpenInventory: (organisation: Organisation, design: DesignSummary) => void;
}

function DesignRow({ design, organisation, onOpenRacks, onOpenInventory }: DesignRowProps) {
  return (
    <li className="home__design-row">
      <span className="home__design-id m">{design.designId}</span>
      <span className="home__design-meta">v{design.latestVersion}</span>
      <span className="home__design-meta">{design.capability}</span>
      <span className="home__design-meta">
        {formatCreatedAt(design.createdAtUnix)} · {design.createdBy}
      </span>
      <span className="home__design-actions">
        <button type="button" className="home__btn" onClick={() => onOpenRacks(organisation, design)}>
          Racks
        </button>
        <button type="button" className="home__btn" onClick={() => onOpenInventory(organisation, design)}>
          Inventory
        </button>
      </span>
    </li>
  );
}

/** The server's own wording where the failure was a refusal it sent
 * (`ApiRefusal`, `errors.ts`); this client's own honest statement where it
 * was not. Never a guess at which check failed. */
function describeError(error: unknown): string {
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'That request did not complete.';
}

function formatCreatedAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}
