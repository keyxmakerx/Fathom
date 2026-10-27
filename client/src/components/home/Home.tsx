import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { signOut } from '../../api/auth';
import {
  createDesign,
  designTitle,
  fetchDesigns,
  moveDesign,
  renameDesign,
  sortDesignsByRecency,
  UNTITLED_DESIGN,
  type DesignSummary,
} from '../../api/designs';
import { ApiRefusal } from '../../api/errors';
import { fetchOrganisations, type Organisation } from '../../api/organisations';
import { createScope, fetchScopes, setScopePlace, type Place, type Scope } from '../../api/scopes';
import { openDesign } from '../../api/payload';
import { publishedLesson } from '../../document/lessons';
import { emptyDocument } from '../../document/model';
import { readPlain, writePlain } from '../../document/plain';
import { About } from '../about/About';
import { ACCOUNT_PLANE, getSessionOn } from '../../state/sessionState';
import { clearJoinedFromInvitation, stillWaitingInvitee, wasJoinedFromInvitation } from '../../state/waitingInvitee';
import { AwaitingSteward } from './AwaitingSteward';
import { PracticeWelcome, type PracticeOffer } from './PracticeWelcome';
import { PlaceFields, type Loadable } from '../organisation/FoldersPanel';
import { kindForLevel } from '../organisation/place';
import { fetchAi } from '../../api/ai';
import { OrganisationTab } from '../organisation/OrganisationTab';
import { PasswordsPage } from '../vault/Screens';
import { canDrawFor } from '../design/useDesignSession';
import { canStewardFor } from './capabilities';
import { pickDirectEntry, type DirectEntry } from './directEntry';
import { groupDesignsByScope, scopesWithNoDesigns } from './groupByScope';
import { HomeTabs } from './HomeTabs';
import { homeTabs, type HomeTab } from './homeTabs';
import { newDesignTarget } from './newDesign';
import { RecentRow } from './RecentRow';
import { whenLabel } from '../history/HistoryPanel';
import { loadFirstSteps, rememberSample, setFirstStepsHidden, type FirstStepsState } from './firstSteps';
import { GettingStarted, SampleCard } from './GettingStarted';
import { HOME_SAMPLE, modelsFor } from './sampleModels';
import { buildSample, sample, sampleModels, type SamplePaste, type SampleSpec } from './sampleNetwork';
import { LessonsList } from '../lessons/LessonsList';
import { lessons, loadRuns, publishedLessonDesigns, saveRun, type Lesson, type LessonRun, type WrittenLesson } from '../lessons/lessonModel';
import { bootLessonMirror } from '../lessons/useLessonChecks';
import './home.css';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';

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
  /** Open a device recently opened in `design`, on the rack. Absent: Recent shows designs only. */
  onOpenDevice?: (organisation: Organisation, design: DesignSummary, chassisId: string) => void;
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
  /** The tab shown (ADR-0060 decision 7). The caller holds it, so the Admin
   * pill can choose a tab and leaving Admin lands where the person went. */
  tab: HomeTab;
  onTabChange: (tab: HomeTab) => void;
  /** The Admin tab, present only where this browser may open the operator
   * console. Choosing the tab calls `onOpen`, which starts the operator
   * sign-in; `panel` is what the tab shows: the sign-in meanwhile, the
   * console itself once the operator session is in view. */
  admin?: { onOpen: () => void; panel: ReactNode };
  /** ADR-0069: a practice space of their own, offered to the person who runs the server (present with `admin`). */
  practice?: PracticeOffer;
  /** Told whether the person joined from an invitation and still waits, so the
   * caller can leave out what would send them the wrong way (the Admin pill). */
  onWaitingInviteeChange?: (waiting: boolean) => void;
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

/** The same network with mistakes planted for Checks (card nu-why A); `corpus/samples/practice-lab.json`. */
const PRACTICE_SAMPLE = 'practice-lab';

export function Home({
  address,
  onOpenRacks,
  onOpenInventory,
  onOpenDevice,
  onDirectEntry,
  notice,
  onClaimOrganisation,
  tab,
  onTabChange,
  admin,
  practice,
  onWaitingInviteeChange,
}: HomeProps) {
  const [organisations, setOrganisations] = useState<Loadable<Organisation[]>>({ status: 'loading' });
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [designs, setDesigns] = useState<Loadable<DesignSummary[]>>({ status: 'loading' });
  const [scopes, setScopes] = useState<Loadable<Scope[]>>({ status: 'loading' });
  const [landed, setLanded] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // Home is the account's, even while Admin's operator session is in view.
  const accountId = getSessionOn(ACCOUNT_PLANE)?.accountId ?? null;
  const [firstSteps, setFirstSteps] = useState<FirstStepsState>(() => loadFirstSteps(accountId));
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [lessonRuns, setLessonRuns] = useState<LessonRun[]>(() => loadRuns(accountId));
  const [lessonBusy, setLessonBusy] = useState<string | null>(null);
  const [lessonError, setLessonError] = useState<string | null>(null);

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
  const [scopeFormPlace, setScopeFormPlace] = useState<Place>({ form: null, role: null });
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

  // ADR-0069: a practice space just made opens straight onto the home lab, the way Open sample does. Making it went
  // through Admin's sign-in, so this Home may be a fresh one: it fetches the list again if the space is not in it yet.
  const justMade = practice?.justMade ?? null;
  const [refetchedFor, setRefetchedFor] = useState<string | null>(null);
  useEffect(() => {
    if (justMade === null || organisations.status !== 'ready') return;
    const org = organisations.value.find((o) => o.organisationId === justMade);
    if (!org) {
      if (refetchedFor === justMade) return;
      setRefetchedFor(justMade);
      fetchOrganisations().then(
        (orgs) => setOrganisations({ status: 'ready', value: orgs }),
        (error: unknown) => setOrganisations({ status: 'error', message: describeError(error) }),
      );
      return;
    }
    if (selectedOrgId !== justMade) {
      setSelectedOrgId(justMade);
      return;
    }
    if (scopes.status !== 'ready') return;
    practice?.onOpened();
    void openSample(org);
    // `openSample` and `practice` are read, not watched: the list, the selection and the folders decide when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justMade, organisations, selectedOrgId, scopes, refetchedFor]);

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

  // Joined from an invitation, no organisation yet: the person waits for a steward.
  // Admin, Claim an organisation and the Designs tab would each send them the wrong
  // way. The note is dropped once an organisation appears.
  const organisationCount = organisations.status === 'ready' ? organisations.value.length : null;
  const waitingInvitee = stillWaitingInvitee(organisationCount, wasJoinedFromInvitation(address));
  // ADR-0069: the practice space is listed apart, as practice, never as an organisation to run.
  const realOrganisations = organisations.status === 'ready' ? organisations.value.filter((o) => !o.practice) : [];
  const practiceOrganisations = organisations.status === 'ready' ? organisations.value.filter((o) => o.practice) : [];
  useEffect(() => {
    if (organisationCount !== null && organisationCount > 0) clearJoinedFromInvitation(address);
  }, [organisationCount, address]);
  useEffect(() => {
    onWaitingInviteeChange?.(waitingInvitee);
  }, [waitingInvitee, onWaitingInviteeChange]);

  // ADR-0060 decision 7: each tab only for someone who may use it. A tab that
  // goes (another organisation chosen, Admin refused) falls back to Designs.
  // An admin, or anyone who stewards a folder: People and Waiting are theirs.
  const organisationAdmin =
    (organisations.status === 'ready' &&
      organisations.value.some((org) => org.organisationId === selectedOrgId && org.role === 'admin')) ||
    (scopes.status === 'ready' && scopes.value.some((scope) => canStewardFor(scope.capability)));
  // ADR-0072: someone a Steward named to connect AI apps, who stewards nothing, gets an AI
  // tab, so their connections have a home without People, Waiting and Folders.
  const [aiMaker, setAiMaker] = useState(false);
  useEffect(() => {
    setAiMaker(false);
    if (organisationAdmin || selectedOrgId === null) return;
    let cancelled = false;
    fetchAi(selectedOrgId).then(
      (o) => {
        if (!cancelled) setAiMaker(o.canMake || o.keys.some((k) => k.mine));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [organisationAdmin, selectedOrgId]);
  const member =
    organisations.status === 'ready' && organisations.value.some((org) => org.organisationId === selectedOrgId && !org.practice);
  const tabs = homeTabs({ organisationAdmin, aiMaker, admin: admin !== undefined, waitingInvitee, member });
  const shownTab: HomeTab = tabs.includes(tab) ? tab : 'designs';

  function selectTab(next: HomeTab) {
    onTabChange(next);
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

  /**
   * r15-start: a fresh copy of the sample, made as a design of the person's own in the same place New design puts
   * one, named after the sample, then opened. Nothing else is touched; wrecking it costs nothing.
   */
  async function openSample(organisation: Organisation, sampleId: string = HOME_SAMPLE) {
    if (scopes.status !== 'ready') return;
    setSampleError(null);
    setSampleBusy(true);
    try {
      const spec = sample(sampleId);
      const named = await copySample(organisation, spec, spec.name);
      rememberSample(accountId, named.designId, sampleId);
      onOpenRacks(organisation, named);
    } catch (error: unknown) {
      setSampleError(describeError(error));
      setSampleBusy(false);
    }
  }

  /** A fresh copy of a sample as a design of the person's own, in the place New design puts one, named `name`. */
  async function copySample(organisation: Organisation, spec: SampleSpec, name: string): Promise<DesignSummary> {
    if (scopes.status !== 'ready') throw new Error('The folders have not loaded yet.');
    const target = newDesignTarget(scopes.value);
    let scope: Scope;
    if (target.kind === 'scope') {
      scope = target.scope;
    } else {
      scope = await createScope(organisation.organisationId, null, organisation.displayName);
      setScopes((current) => (current.status === 'ready' ? { status: 'ready', value: [...current.value, scope] } : current));
    }
    const actor = accountId != null ? { actor: accountId } : undefined;
    // A sample with a pasted config goes through the redaction gate in the engine, the way a person's paste does.
    const mirror = (spec.configs ?? []).length > 0 ? await bootLessonMirror() : null;
    const paste: SamplePaste | undefined =
      mirror == null
        ? undefined
        : (doc, deviceId, text, platform) => {
            mirror.load(doc);
            return mirror.pasteInto(deviceId, text, platform).doc;
          };
    const built = buildSample(spec, await modelsFor(sampleModels(spec)), actor, paste);
    const design = await createDesign(organisation.organisationId, scope.scopeId, writePlain(built.doc));
    // The name is a nicety; a refused rename still opens the copy, untitled.
    return renameDesign(organisation.organisationId, design.designId, name).then(
      () => ({ ...design, name }),
      () => design,
    );
  }

  /** Round 10 lessons B: every start is a new copy of the lesson's sample, so a lesson never touches a real design. */
  async function startLesson(organisation: Organisation, lesson: Lesson) {
    setLessonError(null);
    setLessonBusy(lesson.id);
    try {
      const named = await copySample(organisation, sample(lesson.sample), `Practice: ${lesson.title}`);
      setLessonRuns(saveRun(accountId, { lessonId: lesson.id, designId: named.designId, step: 0 }));
      onOpenRacks(organisation, named);
    } catch (error: unknown) {
      setLessonError(describeError(error));
      setLessonBusy(null);
    }
  }

  /** A lesson someone published (ADR-0066 §2): every start is a new copy of the published design, named Practice. */
  async function startWrittenLesson(organisation: Organisation, written: WrittenLesson) {
    if (scopes.status !== 'ready') return;
    setLessonError(null);
    setLessonBusy(written.lessonId);
    try {
      const opened = await openDesign(organisation.organisationId, written.designId);
      const doc = readPlain(opened.bytes);
      const lesson = publishedLesson(doc);
      if (lesson == null) throw new Error('That design holds no published lesson.');
      const target = newDesignTarget(scopes.value);
      const scope = target.kind === 'scope' ? target.scope : await createScope(organisation.organisationId, null, organisation.displayName);
      const design = await createDesign(organisation.organisationId, scope.scopeId, writePlain(doc));
      const name = `Practice: ${lesson.title}`;
      const named = await renameDesign(organisation.organisationId, design.designId, name).then(
        () => ({ ...design, name }),
        () => design,
      );
      setLessonRuns(saveRun(accountId, { lessonId: written.lessonId, designId: named.designId, step: 0, of: lesson.steps.length }));
      onOpenRacks(organisation, named);
    } catch (error: unknown) {
      setLessonError(describeError(error));
      setLessonBusy(null);
    }
  }

  function continueLesson(organisation: Organisation, run: LessonRun) {
    if (designs.status !== 'ready') return;
    const design = designs.value.find((d) => d.designId === run.designId);
    if (design != null) onOpenRacks(organisation, design);
  }

  function hideFirstSteps(hidden: boolean) {
    setFirstSteps(setFirstStepsHidden(accountId, hidden));
  }

  function openScopeForm(parentId: string | null, parentLabel: string, child: string) {
    setScopeFormParent({ id: parentId, label: parentLabel, child });
    setScopeLabelInput('');
    setScopeFormPlace({ form: null, role: null });
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
    const place = scopeFormPlace.form || scopeFormPlace.role ? scopeFormPlace : undefined;
    createScope(selectedOrgId, scopeFormParent.id, label, place)
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

  /** ADR-0074: a steward changed a folder's kind of place or role; the answer replaces
   * the folder in the loaded list. A refusal is thrown in words for the row to show. */
  async function setPlace(scopeId: string, place: Place) {
    if (selectedOrgId === null) return;
    let scope: Scope;
    try {
      scope = await setScopePlace(selectedOrgId, scopeId, place);
    } catch (error: unknown) {
      throw new Error(describeError(error));
    }
    setScopes((current) =>
      current.status === 'ready'
        ? { status: 'ready', value: current.value.map((s) => (s.scopeId === scopeId ? scope : s)) }
        : current,
    );
  }

  // **Home waits while it may be about to leave.** Until the direct-entry rule
  // can decide, drawing Home's loading rows would show a page the person is
  // then carried away from in the same breath (owner, 2026-10-26: loading
  // "feels weird"). An empty frame, then wherever they land.
  const decidingDirectEntry =
    onDirectEntry !== undefined &&
    (landed ||
      organisations.status === 'loading' ||
      (organisations.status === 'ready' && organisations.value.length === 1 && designs.status === 'loading'));
  if (decidingDirectEntry) {
    return <div className="home" aria-busy="true" />;
  }

  return (
    <div className="home">
      <aside className="home__rail">
        <div className="home__label">Your organisations</div>
        {organisations.status === 'loading' && <SkeletonRows rows={2} />}
        {organisations.status === 'error' && <p className="home__error">{organisations.message}</p>}
        {organisations.status === 'ready' && realOrganisations.length === 0 && (
          <>
            <p className="home__muted">
              {practice
                ? "None. That's fine: you look after the server, and organisations look after their own designs."
                : 'You belong to no organisations yet.'}
            </p>
            {onClaimOrganisation && !waitingInvitee && !practice && (
              <button type="button" className="home__btn home__btn--small" onClick={onClaimOrganisation}>
                Claim an organisation
              </button>
            )}
          </>
        )}
        {organisations.status === 'ready' && realOrganisations.length > 0 && (
          <ul className="home__org-list">
            {realOrganisations.map((org) => (
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
        {practiceOrganisations.length > 0 && (
          <>
            <div className="home__label home__label--spaced">Practice</div>
            <ul className="home__org-list">
              {practiceOrganisations.map((org) => (
                <li key={org.organisationId}>
                  <button
                    type="button"
                    className={org.organisationId === selectedOrgId ? 'home__org-row home__org-row--current' : 'home__org-row'}
                    onClick={() => setSelectedOrgId(org.organisationId)}
                  >
                    {org.displayName}
                  </button>
                </li>
              ))}
            </ul>
            <p className="home__muted home__org-note">Only you see it.</p>
          </>
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
        {shownTab === 'designs' && organisations.status === 'ready' && organisations.value.length === 0 && practice && !waitingInvitee && (
          <PracticeWelcome address={address} offer={practice} onOpen={() => void practice.onMake()} />
        )}
        {organisations.status === 'ready' && organisations.value.length === 0 && waitingInvitee && <AwaitingSteward address={address} />}
        <HomeTabs tabs={tabs} current={shownTab} onSelect={selectTab} testIds={{ designs: 'home-designs', admin: 'console-entry' }} />

        {(shownTab === 'organisation' || shownTab === 'ai') && selectedOrganisation && (
          <OrganisationTab
            organisation={selectedOrganisation}
            aiOnly={!organisationAdmin}
            scopes={scopes}
            onCreateScope={openScopeForm}
            onSetPlace={setPlace}
            estate={{
              organisationId: selectedOrganisation.organisationId,
              designScopeIds: designs.status === 'ready' ? designs.value.map((d) => d.scopeId) : [],
              onImported: (made) => {
                setScopes((current) => (current.status === 'ready' ? { status: 'ready', value: [...current.value, ...made.scopes] } : current));
                setDesigns((current) => (current.status === 'ready' ? { status: 'ready', value: [...current.value, ...made.designs] } : current));
              },
            }}
            scopeForm={
              scopeFormParent && (
                <ScopeForm
                  parentLabel={scopeFormParent.label}
                  child={scopeFormParent.child}
                  value={scopeLabelInput}
                  onChange={setScopeLabelInput}
                  place={scopeFormPlace}
                  onPlaceChange={setScopeFormPlace}
                  onSubmit={submitScopeForm}
                  onCancel={closeScopeForm}
                  busy={scopeFormBusy}
                  error={scopeFormError}
                />
              )
            }
          />
        )}

        {shownTab === 'passwords' && selectedOrganisation && (
          <section className="home__section">
            <PasswordsPage organisation={selectedOrganisation.organisationId} organisationName={selectedOrganisation.displayName} mode="mine" />
          </section>
        )}

        {shownTab === 'admin' && admin && <section className="home__section">{admin.panel}</section>}

        {shownTab === 'designs' && !waitingInvitee && !firstSteps.hidden && selectedOrganisation && (
          <SampleCard
            summary={sample(HOME_SAMPLE).summary}
            busy={sampleBusy}
            disabled={scopes.status !== 'ready'}
            error={sampleError}
            onOpen={() => void openSample(selectedOrganisation)}
            practice={{ summary: sample(PRACTICE_SAMPLE).summary, onOpen: () => void openSample(selectedOrganisation, PRACTICE_SAMPLE) }}
          />
        )}

        {shownTab === 'designs' && !waitingInvitee && designs.status === 'ready' && scopes.status === 'ready' && selectedOrganisation && (
          <RecentRow
            organisation={selectedOrganisation}
            designs={designs.value}
            scopes={scopes.value}
            onOpenDesign={onOpenRacks}
            onOpenDevice={onOpenDevice}
          />
        )}

        {shownTab === 'designs' && !waitingInvitee && !(practice && organisations.status === 'ready' && organisations.value.length === 0) && (
        <section className="home__section">
          <div className="home__section-head">
            <div className="home__label">Designs you may open</div>
            {/* With no designs yet, the empty state's own New design is the one button (r30-small). */}
            {selectedOrganisation && !(designs.status === 'ready' && designs.value.length === 0) && (
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
            <SkeletonRows rows={5} />
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
              onNewDesign={() => handleNewDesign(selectedOrganisation)}
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
              onMoved={(designId, scopeId) =>
                setDesigns((current) =>
                  current.status === 'ready'
                    ? {
                        status: 'ready',
                        value: current.value.map((row) => (row.designId === designId ? { ...row, scopeId } : row)),
                      }
                    : current,
                )
              }
            />
          )}
        </section>
        )}

        {shownTab === 'designs' && !waitingInvitee && selectedOrganisation && (
          <LessonsList
            lessons={lessons()}
            written={designs.status === 'ready' ? publishedLessonDesigns(designs.value, lessonRuns) : []}
            onStartWritten={(w) => void startWrittenLesson(selectedOrganisation, w)}
            runs={lessonRuns}
            openable={new Set(designs.status === 'ready' ? designs.value.map((d) => d.designId) : [])}
            busyId={lessonBusy}
            error={lessonError}
            disabled={scopes.status !== 'ready' || designs.status !== 'ready'}
            onStart={(lesson) => void startLesson(selectedOrganisation, lesson)}
            onContinue={(run) => continueLesson(selectedOrganisation, run)}
          />
        )}
      </main>
      )}

      <aside className="home__panel">
        {!firstSteps.hidden && !waitingInvitee && (
          <GettingStarted done={firstSteps.done} onHide={() => hideFirstSteps(true)} />
        )}
        <div className="home__label">You</div>
        <div className="home__you-address m">{address}</div>
        <button type="button" className="home__btn" onClick={() => void signOut()}>
          Sign out
        </button>
        <div className="home__label home__help">Help</div>
        {firstSteps.hidden && (
          <button type="button" className="about-link" onClick={() => hideFirstSteps(false)}>
            Getting started
          </button>
        )}
        {firstSteps.hidden && selectedOrganisation && !waitingInvitee && (
          <button
            type="button"
            className="about-link"
            disabled={sampleBusy || scopes.status !== 'ready'}
            onClick={() => void openSample(selectedOrganisation)}
          >
            {sampleBusy ? 'Opening the sample…' : 'Open the sample home lab'}
          </button>
        )}
        {firstSteps.hidden && selectedOrganisation && !waitingInvitee && (
          <button
            type="button"
            className="about-link"
            disabled={sampleBusy || scopes.status !== 'ready'}
            onClick={() => void openSample(selectedOrganisation, PRACTICE_SAMPLE)}
          >
            Open the practice home lab
          </button>
        )}
        {firstSteps.hidden && sampleError && <p className="home__error">{sampleError}</p>}
        {practice && organisations.status === 'ready' && organisations.value.length > 0 && practiceOrganisations.length === 0 && (
          <>
            <button type="button" className="about-link" disabled={practice.busy} onClick={() => void practice.onMake()}>
              {practice.busy ? 'Making your practice space…' : 'Make a practice space'}
            </button>
            {practice.codePrompt}
            {practice.error && <p className="home__error">{practice.error}</p>}
          </>
        )}
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
  /** ADR-0074: a move into another folder was saved. */
  onMoved: (designId: string, scopeId: string) => void;
  /** The same New design the section header offers, for the empty state. */
  onNewDesign?: () => void;
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
  onMoved,
  onNewDesign,
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
                folders={scopes}
                onMoved={onMoved}
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
                folders={scopes}
                onMoved={onMoved}
              />
            ))}
          </ul>
        </div>
      )}

      {groups.length === 0 && elsewhere.length === 0 && (
        <EmptyState
          title="No designs in this organisation yet."
          compact
          action={onNewDesign ? { label: 'New design', onClick: onNewDesign, disabled: busyScopeId !== null } : undefined}
        >
          A design holds your racks, devices and cables. Start one and draw into it.
        </EmptyState>
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
  /** ADR-0074: the new folder's kind of place and role, both optional. */
  place: Place;
  onPlaceChange: (place: Place) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}

/** ADR-0054 §3's label field, opened by any "New site/building/closet" button. */
function ScopeForm({ parentLabel, child, value, onChange, place, onPlaceChange, onSubmit, onCancel, busy, error }: ScopeFormProps) {
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
      <PlaceFields kind={kindForLevel(child)} place={place} onChange={onPlaceChange} idPrefix="home-new-scope" />
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
  /** Every folder the person may see; a steward moves the design into one they look after. */
  folders: readonly Scope[];
  onMoved: (designId: string, scopeId: string) => void;
}

const FOLDER_LEVEL: Record<string, string> = { network: 'Site', building: 'Building', rack: 'Closet' };

function DesignRow({ design, organisation, onOpenRacks, onOpenInventory, onRenamed, folders, onMoved }: DesignRowProps) {
  const [editing, setEditing] = useState(false);
  // ADR-0074: a steward of the design's folder moves it into another folder they look after.
  const targets = canStewardFor(design.capability)
    ? folders.filter((f) => f.scopeId !== design.scopeId && canStewardFor(f.capability))
    : [];
  const [moving, setMoving] = useState(false);
  const [moveTo, setMoveTo] = useState('');
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
        <button type="button" className="home__design-name" onClick={() => onOpenRacks(organisation, design)}>
          {designTitle(design)}
        </button>
      )}
      <span className="home__design-meta">
        v{design.latestVersion} · {design.capability} · started {whenLabel(design.createdAtUnix).toLowerCase()}
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
        {targets.length > 0 && !editing && !moving && (
          <button
            type="button"
            className="home__btn"
            onClick={() => {
              setMoveTo(targets[0].scopeId);
              setError(null);
              setMoving(true);
            }}
          >
            Move
          </button>
        )}
        <button type="button" className="home__btn" onClick={() => onOpenRacks(organisation, design)}>
          Canvas
        </button>
        <button type="button" className="home__btn" onClick={() => onOpenInventory(organisation, design)}>
          Inventory
        </button>
      </span>
      {moving && (
        <form
          className="home__design-move"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            moveDesign(organisation.organisationId, design.designId, moveTo)
              .then(() => {
                onMoved(design.designId, moveTo);
                setMoving(false);
              })
              .catch((err: unknown) => setError(describeError(err)))
              .finally(() => setBusy(false));
          }}
        >
          <label htmlFor={`move-${design.designId}`} className="home__muted">
            Move to
          </label>
          <select id={`move-${design.designId}`} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            {targets.map((f) => (
              <option key={f.scopeId} value={f.scopeId}>
                {f.displayName} ({FOLDER_LEVEL[f.kind] ?? f.kind})
              </option>
            ))}
          </select>
          <button type="submit" className="home__btn" disabled={busy}>
            {busy ? 'Moving…' : 'Move'}
          </button>
          <button type="button" className="home__btn" disabled={busy} onClick={() => setMoving(false)}>
            Cancel
          </button>
          <span className="home__muted">Who may read and draw it changes to the new folder's people.</span>
          {error && <span className="home__error">{error}</span>}
        </form>
      )}
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

