import { useEffect, useState } from 'react';

import { signOut } from '../../api/auth';
import { createDesign, fetchDesigns, sortDesignsByRecency, type DesignSummary } from '../../api/designs';
import { ApiRefusal } from '../../api/errors';
import { fetchOrganisations, type Organisation } from '../../api/organisations';
import { createScope, fetchScopes, type Scope } from '../../api/scopes';
import { emptyDocument } from '../../document/model';
import { writePlain } from '../../document/plain';
import { canDrawFor } from '../design/useDesignSession';
import { canStewardFor } from './capabilities';
import { pickDirectEntry, type DirectEntry } from './directEntry';
import { groupDesignsByScope, scopesWithNoDesigns } from './groupByScope';
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
   * component only ever computes and reports the fact. Omitted once it has
   * fired, so that returning to Home stays on Home.
   */
  onDirectEntry?: (entry: DirectEntry) => void;
  /** One sentence from elsewhere in the app that this person should read
   * here — today, the server's refusal to open the Site console. */
  notice?: string | null;
  /** Opens the claim screen for a token received from someone else. */
  onClaimOrganisation?: () => void;
}

/** The interface's names for the server's scope kinds (the owner, 2026-09-23). */
const LEVEL: Record<string, string> = { network: 'Site', building: 'Building', rack: 'Closet' };
/** What can be created under each kind (`child_kind_under` on the server). */
const CHILD_LEVEL: Record<string, string | null> = { network: 'building', building: 'closet', rack: null };

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
export function Home({
  address,
  onOpenRacks,
  onOpenInventory,
  onDirectEntry,
  notice,
  onClaimOrganisation,
}: HomeProps) {
  const [organisations, setOrganisations] = useState<Loadable<Organisation[]>>({ status: 'loading' });
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [designs, setDesigns] = useState<Loadable<DesignSummary[]>>({ status: 'loading' });
  const [scopes, setScopes] = useState<Loadable<Scope[]>>({ status: 'loading' });
  const [landed, setLanded] = useState(false);

  // "New design" (ADR-0054 §2, draw creates a design): which scope's button
  // is mid-request, and the last refusal, if any. Never more than one
  // in-flight scope at a time — the button that started it disables itself
  // (`busyScopeId === scope.scopeId`), so a second click cannot fire a
  // second create for the one this screen is already waiting on.
  const [newDesignBusyScopeId, setNewDesignBusyScopeId] = useState<string | null>(null);
  const [newDesignError, setNewDesignError] = useState<string | null>(null);

  // "New scope" (ADR-0054 §3): the one open form, naming the parent it will
  // create a child under (`null` — "of the organisation" — when Home opened
  // it from the section header rather than a scope heading), and that
  // form's own label input and refusal. One form at a time, closed on
  // success or cancel.
  const [scopeFormParent, setScopeFormParent] = useState<{ id: string | null; label: string; child: string } | null>(null);
  const [scopeLabelInput, setScopeLabelInput] = useState('');
  const [scopeFormBusy, setScopeFormBusy] = useState(false);
  const [scopeFormError, setScopeFormError] = useState<string | null>(null);

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
    if (landed || onDirectEntry === undefined || organisations.status !== 'ready') {
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

  /**
   * ADR-0054 §2: creates the design, then opens it in Racks the moment the
   * create answers — there is nothing on Home worth staying to look at, the
   * new design has no name yet (D11), and Racks is where a fresh document is
   * drawn into. A refusal leaves Home exactly where it was, the button live
   * again, the reason in `newDesignError`.
   */
  function handleCreateDesign(organisation: Organisation, scope: Scope) {
    setNewDesignError(null);
    setNewDesignBusyScopeId(scope.scopeId);
    createDesign(organisation.organisationId, scope.scopeId, writePlain(emptyDocument()))
      .then((design) => {
        onOpenRacks(organisation, design);
      })
      .catch((error: unknown) => {
        setNewDesignError(describeError(error));
        setNewDesignBusyScopeId(null);
      });
  }

  function openScopeForm(parentId: string | null, parentLabel: string, child: string) {
    setScopeFormParent({ id: parentId, label: parentLabel, child });
    setScopeLabelInput('');
    setScopeFormError(null);
  }

  function closeScopeForm() {
    setScopeFormParent(null);
    setScopeLabelInput('');
    setScopeFormError(null);
  }

  /**
   * ADR-0054 §3. On success the new scope is appended to the loaded list
   * in place — no refetch — so its heading (with "New design" already live
   * on it, `canDrawFor` fails open for a capability this client has never
   * seen) appears immediately without a round trip nobody asked for.
   */
  function submitScopeForm() {
    if (scopeFormParent === null || selectedOrgId === null) {
      return;
    }
    const label = scopeLabelInput.trim();
    if (label.length === 0) {
      setScopeFormError('A scope needs a label.');
      return;
    }
    setScopeFormBusy(true);
    setScopeFormError(null);
    createScope(selectedOrgId, scopeFormParent.id, label)
      .then((scope) => {
        setScopes((current) =>
          current.status === 'ready' ? { status: 'ready', value: [...current.value, scope] } : current,
        );
        setScopeFormBusy(false);
        closeScopeForm();
      })
      .catch((error: unknown) => {
        setScopeFormError(describeError(error));
        setScopeFormBusy(false);
      });
  }

  return (
    <div className="home">
      <aside className="home__rail">
        <div className="home__label">Your organisations</div>
        {organisations.status === 'loading' && <p className="home__muted">Loading…</p>}
        {organisations.status === 'error' && <p className="home__error">{organisations.message}</p>}
        {organisations.status === 'ready' && organisations.value.length === 0 && (
          <>
            <p className="home__muted">You belong to no organisations yet.</p>
            {onClaimOrganisation && (
              <button type="button" className="home__btn home__btn--small" onClick={onClaimOrganisation}>
                Claim an organisation
              </button>
            )}
          </>
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
        {notice && (
          <p className="home__error" role="alert">
            {notice}
          </p>
        )}
        <div className="home__title">{selectedOrganisation?.displayName ?? 'Home'}</div>

        <section className="home__section">
          <div className="home__section-head">
            <div className="home__label">Designs you may open</div>
            {/* ADR-0054 §3, "or of the organisation": the one scope-creation
                action that names no existing scope as its parent. Shown
                whenever an organisation is open — this screen has no
                capability to check it against, since there is no scope yet
                to hold one — and left to the server's own refusal,
                `describeError`, when the account is not in fact a steward
                of the organisation. */}
            {selectedOrganisation && (
              <button
                type="button"
                className="home__btn home__btn--small"
                onClick={() => openScopeForm(null, selectedOrganisation.displayName, 'site')}
              >
                New site
              </button>
            )}
          </div>
          {selectedOrgId === null && <p className="home__muted">No organisation selected.</p>}
          {selectedOrgId !== null && (designs.status === 'loading' || scopes.status === 'loading') && (
            <p className="home__muted">Loading…</p>
          )}
          {designs.status === 'error' && <p className="home__error">{designs.message}</p>}
          {designs.status !== 'error' && scopes.status === 'error' && (
            <p className="home__error">{scopes.message}</p>
          )}
          {newDesignError && <p className="home__error">{newDesignError}</p>}

          {scopeFormParent && (
            <ScopeForm
              parentLabel={scopeFormParent.label}
              child={scopeFormParent.child}
              value={scopeLabelInput}
              onChange={setScopeLabelInput}
              onSubmit={submitScopeForm}
              onCancel={closeScopeForm}
              busy={scopeFormBusy}
              error={scopeFormError}
            />
          )}

          {designs.status === 'ready' && scopes.status === 'ready' && selectedOrganisation && (
            <HomeDesigns
              designs={sortDesignsByRecency(designs.value)}
              scopes={scopes.value}
              organisation={selectedOrganisation}
              onOpenRacks={onOpenRacks}
              onOpenInventory={onOpenInventory}
              onCreateDesign={handleCreateDesign}
              onCreateScope={openScopeForm}
              busyScopeId={newDesignBusyScopeId}
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

interface HomeDesignsProps {
  designs: DesignSummary[];
  scopes: Scope[];
  organisation: Organisation;
  onOpenRacks: (organisation: Organisation, design: DesignSummary) => void;
  onOpenInventory: (organisation: Organisation, design: DesignSummary) => void;
  /** ADR-0054 §2 — creates a design in `scope` and opens it. */
  onCreateDesign: (organisation: Organisation, scope: Scope) => void;
  /** ADR-0054 §3 — opens the new-scope form with `scope` as the parent. */
  onCreateScope: (parentId: string, parentLabel: string, child: string) => void;
  /** The scope whose "New design" button is mid-request, or `null`. */
  busyScopeId: string | null;
}

/**
 * Everything Home shows about designs and where to start one, replacing the
 * old `ScopedDesignList`: the board grouped by closet (D11) when there is at
 * least one design, PLUS — this task's own brief — a list of every scope the
 * account may draw in that has none yet, so an organisation with zero
 * designs is never left with nothing to press. `scopesWithNoDesigns` is
 * itself capability-blind; the `canDrawFor` filter here is what actually
 * decides which of them get a "Start a design" row.
 */
function HomeDesigns({
  designs,
  scopes,
  organisation,
  onOpenRacks,
  onOpenInventory,
  onCreateDesign,
  onCreateScope,
  busyScopeId,
}: HomeDesignsProps) {
  const { groups, elsewhere } = groupDesignsByScope(designs, scopes);
  const startable = scopesWithNoDesigns(scopes, designs).filter((scope) => canDrawFor(scope.capability));

  return (
    <div className="home__scope-groups">
      {groups.map(({ scope, designs: scopeDesigns }) => (
        <div className="home__scope-group" key={scope.scopeId}>
          <ScopeHeading
            scope={scope}
            designCount={scopeDesigns.length}
            busy={busyScopeId === scope.scopeId}
            onCreateDesign={() => onCreateDesign(organisation, scope)}
            onCreateScope={() => onCreateScope(scope.scopeId, scope.displayName, CHILD_LEVEL[scope.kind] ?? '')}
          />
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

      {groups.length === 0 && elsewhere.length === 0 && (
        <p className="home__muted">No designs in this organisation yet.</p>
      )}

      {startable.length > 0 && (
        <div className="home__scope-group" key="startable">
          <div className="home__label">Start a design in…</div>
          {startable.map((scope) => (
            <div className="home__scope-heading" key={scope.scopeId}>
              <ScopeHeading
                scope={scope}
                designCount={0}
                busy={busyScopeId === scope.scopeId}
                onCreateDesign={() => onCreateDesign(organisation, scope)}
                onCreateScope={() => onCreateScope(scope.scopeId, scope.displayName, CHILD_LEVEL[scope.kind] ?? '')}
                bare
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ScopeHeadingProps {
  scope: Scope;
  designCount: number;
  busy: boolean;
  onCreateDesign: () => void;
  onCreateScope: () => void;
  /** `true` for a "Start a design" row, which is not inside its own
   * `.home__scope-heading` wrapper (its caller already provides one) —
   * avoids nesting that class inside itself. */
  bare?: boolean;
}

/**
 * One scope's name, kind and design count, plus the two actions this task's
 * brief adds: "New design" when `canDrawFor(scope.capability)` (ADR-0054
 * §2), "New scope" when `canStewardFor(scope.capability)` (ADR-0054 §3).
 * Shared between a scope that already has designs and one offered under
 * "Start a design in…" so the two lists behave identically.
 */
function ScopeHeading({ scope, designCount, busy, onCreateDesign, onCreateScope, bare }: ScopeHeadingProps) {
  const body = (
    <>
      <span className="home__scope-name">{scope.displayName}</span>
      <span className="home__scope-kind">{LEVEL[scope.kind] ?? scope.kind}</span>
      <span className="home__scope-count">
        {designCount} design{designCount === 1 ? '' : 's'}
      </span>
      <span className="home__scope-actions">
        {canDrawFor(scope.capability) && (
          <button type="button" className="home__btn home__btn--small" onClick={onCreateDesign} disabled={busy}>
            {busy ? 'Creating…' : 'New design'}
          </button>
        )}
        {canStewardFor(scope.capability) && CHILD_LEVEL[scope.kind] && (
          <button type="button" className="home__btn home__btn--small" onClick={onCreateScope}>
            New {CHILD_LEVEL[scope.kind]}
          </button>
        )}
      </span>
    </>
  );
  return bare ? body : <div className="home__scope-heading">{body}</div>;
}

interface ScopeFormProps {
  /** The parent scope's own name, or the organisation's, for the form's
   * own label — never invented, always the same string the button that
   * opened it was already showing. */
  parentLabel: string;
  /** The level being created: site, building or closet. */
  child: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}

/** ADR-0054 §3's label field, opened by any "New site/building/closet" button. */
function ScopeForm({ parentLabel, child, value, onChange, onSubmit, onCancel, busy, error }: ScopeFormProps) {
  return (
    <form
      className="home__scope-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="home__scope-form-label" htmlFor="home-new-scope-label">
        New {child} under {parentLabel}
      </label>
      <input
        id="home-new-scope-label"
        className="home__scope-form-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="label"
        autoFocus
      />
      <button type="submit" className="home__btn" disabled={busy}>
        {busy ? 'Creating…' : 'Create'}
      </button>
      <button type="button" className="home__btn" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      {error && <p className="home__error">{error}</p>}
    </form>
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
