import { useEffect, useState } from 'react';

import { signOut } from '../../api/auth';
import { fetchDesigns, sortDesignsByRecency, type DesignSummary } from '../../api/designs';
import { ApiRefusal } from '../../api/errors';
import { fetchOrganisations, type Organisation } from '../../api/organisations';
import { pickDirectEntry, type DirectEntry } from './directEntry';
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
          {designs.status === 'loading' && selectedOrgId !== null && (
            <p className="home__muted">Loading…</p>
          )}
          {designs.status === 'error' && <p className="home__error">{designs.message}</p>}
          {selectedOrgId === null && <p className="home__muted">No organisation selected.</p>}
          {designs.status === 'ready' && designs.value.length === 0 && (
            <p className="home__muted">No designs in this organisation yet.</p>
          )}
          {designs.status === 'ready' && designs.value.length > 0 && selectedOrganisation && (
            <ul className="home__design-list">
              {sortDesignsByRecency(designs.value).map((design) => (
                <li key={design.designId} className="home__design-row">
                  <span className="home__design-id m">{design.designId}</span>
                  <span className="home__design-meta">
                    scope <span className="m">{design.scopeId}</span>
                  </span>
                  <span className="home__design-meta">v{design.latestVersion}</span>
                  <span className="home__design-meta">{design.capability}</span>
                  <span className="home__design-meta">
                    {formatCreatedAt(design.createdAtUnix)} · {design.createdBy}
                  </span>
                  <span className="home__design-actions">
                    <button
                      type="button"
                      className="home__btn"
                      onClick={() => onOpenRacks(selectedOrganisation, design)}
                    >
                      Racks
                    </button>
                    <button
                      type="button"
                      className="home__btn"
                      onClick={() => onOpenInventory(selectedOrganisation, design)}
                    >
                      Inventory
                    </button>
                  </span>
                </li>
              ))}
            </ul>
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
