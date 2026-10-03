import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { signOut } from '../../api/auth';
import {
  createDesign,
  designTitle,
  fetchDesigns,
  renameDesign,
  sortDesignsByRecency,
  UNTITLED_DESIGN,
  type DesignSummary,
} from '../../api/designs';
import { ApiRefusal } from '../../api/errors';
import { fetchOrganisations, type Organisation } from '../../api/organisations';
import { createScope, fetchScopes, type Scope } from '../../api/scopes';
import { emptyDocument } from '../../document/model';
import { writePlain } from '../../document/plain';
import { About } from '../about/About';
import { AwaitingSteward } from './AwaitingSteward';
import { type Loadable } from '../organisation/FoldersPanel';
import { OrganisationTab } from '../organisation/OrganisationTab';
import { canDrawFor } from '../design/useDesignSession';
import { canStewardFor } from './capabilities';
import { pickDirectEntry, type DirectEntry } from './directEntry';
import { groupDesignsByScope, scopesWithNoDesigns } from './groupByScope';
import { HomeTabs } from './HomeTabs';
import { homeTabs, type HomeTab } from './homeTabs';
import { newDesignTarget } from './newDesign';
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
  /** The tab to open on (ADR-0060 decision 7). The caller remembers the
   * last one chosen, so coming back from Admin lands where the person went. */
  initialTab?: HomeTab;
  onTabChange?: (tab: HomeTab) => void;
  /** Which tabs are shown, so the Admin view can draw the same row. */
  onTabsChange?: (tabs: HomeTab[]) => void;
  /** The Admin tab, present only where this browser may open the operator
   * console. Choosing the tab calls `onOpen`, which starts the operator
   * sign-in; `panel` is what the tab shows meanwhile. */
  admin?: { onOpen: () => void; panel: ReactNode };
}

/** The interface's names for the server's scope kinds (the owner, 2026-09-23). */
const LEVEL: Record<string, string> = { network: 'Site', building: 'Building', rack: 'Closet' };


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
/** The busy marker while the home screen's own New design is making a Site. */
const NEW_SITE_PENDING = 'new-site-pending';

export function Home({
  address,
  onOpenRacks,
  onOpenInventory,
  onDirectEntry,
  notice,
  onClaimOrganisation,
  initialTab,
  onTabChange,
  onTabsChange,
  admin,
}: HomeProps) {
  const [organisations, setOrganisations] = useState<Loadable<Organisation[]>>({ status: 'loading' });
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [designs, setDesigns] = useState<Loadable<DesignSummary[]>>({ status: 'loading' });
  const [scopes, setScopes] = useState<Loadable<Scope[]>>({ status: 'loading' });
  const [landed, setLanded] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [tab, setTab] = useState<HomeTab>(initialTab ?? 'designs');

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

  // ADR-0060 decision 7: each tab only for someone who may use it. A tab that
  // goes (another organisation chosen, Admin refused) falls back to Designs.
  // An admin, or anyone who stewards a folder: People and Waiting are theirs.
  const organisationAdmin =
    (organisations.status === 'ready' &&
      organisations.value.some((org) => org.organisationId === selectedOrgId && org.role === 'admin')) ||
    (scopes.status === 'ready' && scopes.value.some((scope) => canStewardFor(scope.capability)));
  const tabs = homeTabs({ organisationAdmin, admin: admin !== undefined });
  const shownTab: HomeTab = tabs.includes(tab) ? tab : 'designs';
  const tabsKey = tabs.join(' ');
  useEffect(() => {
    onTabsChange?.(tabsKey.split(' ') as HomeTab[]);
  }, [tabsKey, onTabsChange]);

  function selectTab(next: HomeTab) {
    setTab(next);
    onTabChange?.(next);
    if (next === 'admin') admin?.onOpen();
  }

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

  /**
   * The home screen's own "New design" (ADR-0060 decision 6): into the first
   * Site the person may draw in, or into a new Site named after the
   * organisation when there is none, so nobody has to make a Site first.
   */
  function handleNewDesign(organisation: Organisation) {
    if (scopes.status !== 'ready') return;
    const target = newDesignTarget(scopes.value);
    if (target.kind === 'scope') {
      handleCreateDesign(organisation, target.scope);
      return;
    }
    setNewDesignError(null);
    setNewDesignBusyScopeId(NEW_SITE_PENDING);
    createScope(organisation.organisationId, null, organisation.displayName)
      .then((site) => {
        setScopes((current) => (current.status === 'ready' ? { status: 'ready', value: [...current.value, site] } : current));
        handleCreateDesign(organisation, site);
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
      setScopeFormError('A folder needs a name.');
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

      {aboutOpen ? (
        <main className="home__centre">
          <About onBack={() => setAboutOpen(false)} />
        </main>
      ) : (
      <main className="home__centre">
        {notice && (
          <p className="home__error" role="alert">
            {notice}
          </p>
        )}
        <div className="home__title">{selectedOrganisation?.displayName ?? 'Home'}</div>
        {organisations.status === 'ready' && organisations.value.length === 0 && <AwaitingSteward address={address} />}
        <HomeTabs tabs={tabs} current={shownTab} onSelect={selectTab} testIds={{ admin: 'console-entry' }} />

        {shownTab === 'organisation' && selectedOrganisation && (
          <OrganisationTab
            organisation={selectedOrganisation}
            scopes={scopes}
            onCreateScope={openScopeForm}
            scopeForm={
              scopeFormParent && (
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
              )
            }
          />
        )}

        {shownTab === 'admin' && admin && <section className="home__section">{admin.panel}</section>}

        {shownTab === 'designs' && (
        <section className="home__section">
          <div className="home__section-head">
            <div className="home__label">Designs you may open</div>
            {selectedOrganisation && (
              <button
                type="button"
                className="home__btn home__btn--small"
                disabled={newDesignBusyScopeId !== null || scopes.status !== 'ready'}
                onClick={() => handleNewDesign(selectedOrganisation)}
              >
                {newDesignBusyScopeId !== null ? 'Creating…' : 'New design'}
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

          {designs.status === 'ready' && scopes.status === 'ready' && selectedOrganisation && (
            <HomeDesigns
              designs={sortDesignsByRecency(designs.value)}
              scopes={scopes.value}
              organisation={selectedOrganisation}
              onOpenRacks={onOpenRacks}
              onOpenInventory={onOpenInventory}
              onCreateDesign={handleCreateDesign}
              busyScopeId={newDesignBusyScopeId}
              onRenamed={(designId, name) =>
                setDesigns((current) =>
                  current.status === 'ready'
                    ? {
                        status: 'ready',
                        value: current.value.map((row) => (row.designId === designId ? { ...row, name } : row)),
                      }
                    : current,
                )
              }
            />
          )}
        </section>
        )}
      </main>
      )}

      <aside className="home__panel">
        <div className="home__label">You</div>
        <div className="home__you-address m">{address}</div>
        <button type="button" className="home__btn" onClick={() => void signOut()}>
          Sign out
        </button>
        <button type="button" className="about-link" onClick={() => setAboutOpen(true)}>
          About Fathom
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
  /** The scope whose "New design" button is mid-request, or `null`. */
  busyScopeId: string | null;
  /** A rename was saved; `name` is `null` when it was cleared. */
  onRenamed: (designId: string, name: string | null) => void;
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
  busyScopeId,
  onRenamed,
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
          />
          <ul className="home__design-list">
            {scopeDesigns.map((design) => (
              <DesignRow
                key={design.designId}
                design={design}
                organisation={organisation}
                onOpenRacks={onOpenRacks}
                onOpenInventory={onOpenInventory}
                onRenamed={onRenamed}
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
                onRenamed={onRenamed}
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
  /** `true` for a "Start a design" row, which is not inside its own
   * `.home__scope-heading` wrapper (its caller already provides one) —
   * avoids nesting that class inside itself. */
  bare?: boolean;
}

/**
 * One scope's name, kind and design count, plus "New design" when
 * `canDrawFor(scope.capability)` (ADR-0054 §2). Making a scope beneath it is
 * the Organisation tab's (ADR-0060 decision 7). Shared between a scope that
 * already has designs and one offered under "Start a design in…" so the two
 * lists behave identically.
 */
function ScopeHeading({ scope, designCount, busy, onCreateDesign, bare }: ScopeHeadingProps) {
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
  onRenamed: (designId: string, name: string | null) => void;
}

function DesignRow({ design, organisation, onOpenRacks, onOpenInventory, onRenamed }: DesignRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draft.trim();
    setBusy(true);
    setError(null);
    renameDesign(organisation.organisationId, design.designId, name)
      .then(() => {
        onRenamed(design.designId, name === '' ? null : name);
        setEditing(false);
      })
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setBusy(false));
  }

  return (
    <li className="home__design-row">
      {editing ? (
        <form className="home__design-rename" onSubmit={save}>
          <input
            className="home__input"
            aria-label="Design name"
            value={draft}
            maxLength={100}
            placeholder={UNTITLED_DESIGN}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="home__btn" disabled={busy}>
            Save
          </button>
          <button type="button" className="home__btn" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
          {error && <span className="home__error">{error}</span>}
        </form>
      ) : (
        <span className="home__design-name" title={design.designId}>
          {designTitle(design)}
        </span>
      )}
      <span className="home__design-meta">v{design.latestVersion}</span>
      <span className="home__design-meta">{design.capability}</span>
      <span className="home__design-meta">
        {formatCreatedAt(design.createdAtUnix)} · {design.createdBy}
      </span>
      <span className="home__design-actions">
        {canDrawFor(design.capability) && !editing && (
          <button
            type="button"
            className="home__btn"
            onClick={() => {
              setDraft(design.name ?? '');
              setError(null);
              setEditing(true);
            }}
          >
            Rename
          </button>
        )}
        <button type="button" className="home__btn" onClick={() => onOpenRacks(organisation, design)}>
          Canvas
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
