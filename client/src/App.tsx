import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';

import { beginSignIn, completeSignIn, isSecondFactorNeeded, type SignInChallenge } from './api/auth';
import { identityOfSlot, PRINCIPAL_KIND_OPERATOR } from './api/constants';
import { appCodeEnrolmentRequired } from './api/credentials';
import { ApiRefusal } from './api/errors';
import {
  beginOperatorBootstrap,
  completeOperatorBootstrap,
  useConsoleHost,
  type OperatorBootstrapChallenge,
} from './api/placement';
import { useSetupState } from './api/setup';
import type { OrganisationClaim } from './api/console';
import { fetchDesigns, sortDesignsByRecency, type DesignSummary } from './api/designs';
import type { Organisation } from './api/organisations';
import { buildScopeForest, fetchScopes, pathTo, type Scope, type ScopeTreeNode } from './api/scopes';
import { Account } from './components/Account';
import { ClaimOrganisation } from './components/claim';
import { Console } from './components/console/Console';
import { Enrol, invitationFromLocation } from './components/Enrol';
import { FirstRun } from './components/FirstRun';
import { Reset, tokenFromLocation } from './components/Reset';
import { Home } from './components/home';
import type { DirectEntry } from './components/home';
import { Shell } from './components/Shell';
import type { Lens, Place } from './components/Shell';
import { DesignPlace } from './components/design/DesignPlace';
import { LENSES_IN } from './components/shell/lens';
import { PopoverRow } from './components/shell/Popover';
import type { PathPart } from './components/shell/types';
import { SignIn } from './components/SignIn';
import { generateKeyPair, listKeySlots } from './crypto/keys';
import { initialsFromAddress } from './initials';
import {
  ACCOUNT_PLANE,
  getSession,
  getSessionOn,
  OPERATOR_PLANE,
  setPlane,
  setSession,
  subscribe,
  type ActiveSession,
} from './state/sessionState';

/**
 * Which door an unsigned-in visitor is at. Three since ADR-0056 decision 1
 * took the setup door away: `sign-in` takes an address and a password, and a
 * verification code when the server asks for one; `enrol` redeems an
 * invitation, which is still the key path and unchanged; `reset` is "forgot
 * my password" and the screen its link lands on. The first operator's setup
 * is no longer a door at all — the server says whether this deployment has
 * been set up, and while it has not, the first-run flow is the only screen
 * there is. Nobody self-registers (`docs/OPEN-QUESTIONS.md` B5), so no door
 * creates an account.
 */
type Door = 'sign-in' | 'enrol' | 'reset';

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

/**
 * An operator sign-in `enterConsole` is waiting on a verification code for
 * (ADR-0057 decision 2): which of the two ways in it was on, and the
 * unspent challenge to retry with.
 */
type OperatorSignInPending =
  | { kind: 'existing'; challenge: SignInChallenge }
  | { kind: 'bootstrap'; accountSession: ActiveSession; bootstrap: OperatorBootstrapChallenge };

export default function App() {
  const session = useSyncExternalStore(subscribe, getSession);
  // ADR-0055 client (a): a link carrying a reset token opens the reset
  // screen and nothing else. Read once, before the first render, so the
  // screen does not flash the ordinary door first.
  const [resetToken] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : tokenFromLocation(window.location),
  );
  // ADR-0056 decision 6: an invitation is redeemed at the address it
  // carries, `/invite#inv_…`, and the token is in the fragment so that it
  // never reaches a request line or a log. Read once, before the first
  // render, for the same reason the reset token is.
  const [invitationToken] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : invitationFromLocation(window.location),
  );
  const [door, setDoor] = useState<Door>(
    invitationToken ? 'enrol' : resetToken ? 'reset' : 'sign-in',
  );

  // The fragment is cleared from the address bar as soon as it has been
  // read, so a reload, a bookmark or a pasted URL does not carry a live
  // invitation token any further. `replaceState` leaves no history entry to
  // go back to.
  useEffect(() => {
    if (invitationToken === null || typeof window === 'undefined') return;
    window.history.replaceState(null, '', window.location.pathname);
  }, [invitationToken]);
  const [view, setView] = useState<View>({ kind: 'home' });

  // ADR-0055 client (a): what the sign-in door is told by whatever sent the
  // person back to it — a finished reset, or a first run that set the
  // password and could not sign in with it. (A finished first run lands on
  // Home instead: ADR-0056 decision 2 step 5.)
  const [signInAddress, setSignInAddress] = useState<string | undefined>(undefined);
  const [signInNotice, setSignInNotice] = useState<string | null>(null);

  // ADR-0055 client (a): the setup gate. `null` is "not asked yet"; `true`
  // is the server's own `set up an authenticator first` refusal, which is a
  // route to a screen and not a wall (`api/credentials.ts`, which also
  // matches the sentence a server from before ADR-0056 sends).
  const [appCodeNeeded, setAppCodeNeeded] = useState<boolean | null>(null);

  // ADR-0056 decision 1: the server's one bit about this deployment, asked
  // at boot beside the console-host flag. While it says `pending` the
  // first-run flow is the whole of what this client shows; `done` is the
  // sign-in door; an error is the sign-in door too, logged, because a server
  // that could not answer never said this deployment was unconfigured.
  const setupState = useSetupState();
  useEffect(() => {
    if (setupState.status === 'error') {
      console.error(`GET /setup/state: ${setupState.message}`);
    }
  }, [setupState]);

  // True once the first-run flow has finished, so that the bit above — read
  // once per page load, and still `pending` in this page's memory — does not
  // pull the person back to the start of the flow they have just completed.
  const [firstRunDone, setFirstRunDone] = useState(false);

  // ADR-0055 client (a): the account's own credential screen is open.
  const [accountOpen, setAccountOpen] = useState(false);

  // The organisation claim screen (ADR-0057 decision 5). `token`/`noticeAddress`
  // set: handed over from "Claim it now"; absent: Home's own "Claim an organisation".
  const [claiming, setClaiming] = useState<{ token?: Uint8Array; noticeAddress?: string } | null>(null);

  // Sign-out does not reload the page, so whatever was open belongs to the
  // session that ended: the next sign-in starts on Home.
  const accountSessionId = getSessionOn(ACCOUNT_PLANE)?.sessionId ?? null;
  useEffect(() => {
    setView({ kind: 'home' });
    setAccountOpen(false);
    setClaiming(null);
  }, [accountSessionId]);

  // The app-code gate, asked once per session: an account that holds the
  // operator custody and has no confirmed authenticator gets a session good for
  // `/credentials/*` alone, and the server says so with a typed refusal on
  // the first ordinary route. Asking one route on purpose puts the answer
  // here, where the screen can be chosen, rather than inside whichever
  // surface happened to fetch first.
  const sessionId = session?.sessionId ?? null;
  const sessionKind = session?.kind ?? null;
  const firstRun = setupState.status === 'ready' && setupState.state === 'pending' && !firstRunDone;
  useEffect(() => {
    if (sessionId === null || sessionKind !== 'steward' || firstRun) {
      setAppCodeNeeded(null);
      return;
    }
    let cancelled = false;
    appCodeEnrolmentRequired()
      .then((needed) => {
        if (!cancelled) setAppCodeNeeded(needed);
      })
      .catch(() => {
        if (!cancelled) setAppCodeNeeded(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, sessionKind, firstRun]);

  // ---------------------------------------------------------------------
  // ADR-0055 — the console entry (client streams (a) and (b), merged)
  //
  // The one block on the account side that leads to the operator side. It
  // asks the host whether the console lives here (`useConsoleHost()`), and
  // only then offers the Site entry at all. On any other host there is
  // nothing operator-side to hide, because nothing is rendered — decision 9:
  // *absent*, not hidden.
  //
  // **Pressing it is what asks whether this account holds the custody.** No
  // route reports that without acting on it: `POST /admin/operators/self/key`
  // registers the browser's key and answers with the operator id, or refuses.
  // So the entry is offered to a signed-in account on a console host, the
  // press runs `bootstrapOperatorSession`, and a refusal is shown in the
  // server's own words and takes the entry away for the rest of this session
  // rather than inviting a second press that would be refused the same way.
  //
  // **Both sessions stay live** (decision 1: one person, two custodies).
  // `setSession` files the operator session on the operator plane and brings
  // it into view; the account session is untouched on its own plane with its
  // own request counter, so Home is one press away and no sign-in happens in
  // between (`state/sessionState.ts`).
  // ---------------------------------------------------------------------
  const consoleHostState = useConsoleHost();
  const consoleHost = consoleHostState.status === 'ready' && consoleHostState.flag.consoleHost;
  const [enteringConsole, setEnteringConsole] = useState(false);
  const [consoleRefusal, setConsoleRefusal] = useState<string | null>(null);
  const [custodyRefused, setCustodyRefused] = useState(false);
  // ADR-0057 decision 2: the account session endorsing an operator sign-in
  // needs a fresh verification code when its own proof has gone stale. Held
  // here so the inline prompt below can retry with the SAME challenge —
  // `SecondFactorNeeded` is a rollback, and the nonce it left is still good.
  const [operatorCodePending, setOperatorCodePending] = useState<OperatorSignInPending | null>(null);
  const [operatorCode, setOperatorCode] = useState('');

  async function enterConsole() {
    const accountSession = getSessionOn(ACCOUNT_PLANE);
    if (!accountSession) return;
    // Already picked up in this browser: this is a change of plane, not a
    // second sign-in and not a second key registration.
    if (getSessionOn(OPERATOR_PLANE)) {
      setPlane(OPERATOR_PLANE);
      return;
    }
    setEnteringConsole(true);
    setConsoleRefusal(null);
    setOperatorCodePending(null);
    try {
      // **A key this browser already holds for an operator is the way in.**
      // The operator plane is still a key sign-in (decision 10's last line),
      // so a second visit signs in with the key the first visit filed and
      // registers nothing: `operator_keys.fpr` is UNIQUE, and a browser that
      // re-registered the same key on every page load would be refused by
      // the database rather than by any rule.
      const existing = await operatorSlotHeldHere();
      if (existing) {
        const challenge = await beginSignIn(existing, PRINCIPAL_KIND_OPERATOR);
        try {
          await completeSignIn(challenge);
          return;
        } catch (error) {
          if (isSecondFactorNeeded(error)) {
            // The SAME challenge, held: `SecondFactorNeeded` is a rollback
            // and leaves its nonce unspent, so the retry re-posts it rather
            // than asking for another.
            setOperatorCodePending({ kind: 'existing', challenge });
            return;
          }
          // The key this browser holds is not one the server will take —
          // retired, or from an install that has been rebuilt. Fall through
          // and pick the custody up again with a new one.
          console.error(error);
        }
      }
      // **A fresh keypair for the operator custody**, not the account's own.
      // Decision 6: any browser, no pairing; the server takes every live key
      // of the principal (`live_operator_keys`, the lead's resolution 1), so
      // one key per browser per custody is the shape, and reusing the
      // account's would collide with itself the next time this ran.
      const bootstrap = await beginOperatorBootstrap(accountSession, await generateKeyPair());
      try {
        const { session: operatorSession } = await completeOperatorBootstrap(accountSession, bootstrap);
        setSession(operatorSession);
      } catch (error) {
        if (isSecondFactorNeeded(error)) {
          setOperatorCodePending({ kind: 'bootstrap', accountSession, bootstrap });
          return;
        }
        throw error;
      }
    } catch (error) {
      console.error(error);
      const refusal = error instanceof ApiRefusal ? error.message : null;
      setConsoleRefusal(
        refusal ??
          'This browser could not open the operator console. Nothing was changed on the server.',
      );
      // 403 is the ordinary answer for an account that holds no operator
      // custody, and 404 is a host the console does not answer on. Neither
      // is worth a second press.
      if (error instanceof ApiRefusal && (error.status === 403 || error.status === 404)) {
        setCustodyRefused(true);
      }
    } finally {
      setEnteringConsole(false);
    }
  }

  /** Retry the pending operator sign-in with the verification code just
   * typed, over the same challenge (ADR-0057 decision 2). */
  async function submitOperatorCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!operatorCodePending) return;
    setEnteringConsole(true);
    setConsoleRefusal(null);
    try {
      if (operatorCodePending.kind === 'existing') {
        await completeSignIn(operatorCodePending.challenge, { verificationCode: operatorCode });
      } else {
        const { session: operatorSession } = await completeOperatorBootstrap(
          operatorCodePending.accountSession,
          operatorCodePending.bootstrap,
          operatorCode,
        );
        setSession(operatorSession);
      }
      setOperatorCodePending(null);
      setOperatorCode('');
    } catch (error) {
      console.error(error);
      setConsoleRefusal(error instanceof ApiRefusal ? error.message : 'That code was not accepted.');
      setOperatorCode('');
      // A wrong code spends the challenge's nonce like any refusal, so a
      // retry against it always fails — fetch a fresh one instead.
      try {
        if (operatorCodePending.kind === 'existing') {
          setOperatorCodePending({
            kind: 'existing',
            challenge: await beginSignIn(operatorCodePending.challenge.address, PRINCIPAL_KIND_OPERATOR),
          });
        } else {
          setOperatorCodePending({
            kind: 'bootstrap',
            accountSession: operatorCodePending.accountSession,
            bootstrap: await beginOperatorBootstrap(
              operatorCodePending.accountSession,
              await generateKeyPair(),
            ),
          });
        }
      } catch (refreshError) {
        console.error(refreshError);
        setOperatorCodePending(null);
      }
    } finally {
      setEnteringConsole(false);
    }
  }
  // --- end ADR-0055 console entry --------------------------------------

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
  //
  // Once per sign-in: after that, going back to Home must stay on Home.
  const [directEntrySession, setDirectEntrySession] = useState<string | null>(null);
  const handleDirectEntry = useCallback((entry: DirectEntry) => {
    setDirectEntrySession(getSessionOn(ACCOUNT_PLANE)?.sessionId ?? null);
    setView({
      kind: 'place',
      place: 'racks',
      organisation: entry.organisation,
      design: entry.design,
    });
  }, []);

  // ADR-0056 decisions 1 and 2: while the deployment is on its first run
  // this is the only screen, and it holds even once its own sign-in has made
  // a session — the password is set but the authenticator is not, and that
  // session may do nothing else until it is.
  //
  // **What lands on Home is the session its last step makes, not the one it
  // started with.** The mid-flow session is `A0`: a password and nothing
  // else, minted before the authenticator existed. Every ordinary route
  // takes it the moment the code is confirmed, because the setup gate reads
  // the account's live credentials on each request rather than the session's
  // assurance — but `POST /admin/operators/self/key` refuses `A0` outright
  // (`operators.rs`), which is the one press the Site entry below makes. So
  // the flow ends by signing in again with the code, and this lands on an
  // `A0T` session the console takes; the entry works on the first press
  // rather than taking itself away for the rest of the session.
  //
  // **And when it hands the person to the door** — the sign-in after the
  // password failed, or they took step 5's way out because their app was not
  // giving them a usable code: the token is spent and there is no step left
  // to show, so the door takes over with the address filled in and the
  // sentence the flow chose (`FirstRun.tsx`'s `PASSWORD_SET_NOTICE` or
  // `AUTHENTICATOR_SET_NOTICE`).
  //
  // **This gate is the state route's answer, freshly asked.** `firstRunDone`
  // below is not this page's guess: the flow asks `GET /setup/state` again
  // before it calls, and calls only when the server says `done` or does not
  // answer at all. A server still saying `pending` keeps the flow on screen
  // with its own sentence and never reaches here — which is the only way
  // this branch and the server can agree about which screen a deployment is
  // on. The bit read at boot still says `pending` in this page's memory, so
  // something has to carry the newer answer, and this is it.
  if (firstRun) {
    return (
      <FirstRun
        onDone={() => setFirstRunDone(true)}
        onUseTheDoor={(address, notice) => {
          setFirstRunDone(true);
          setSignInAddress(address);
          setSignInNotice(notice);
          setDoor('sign-in');
        }}
      />
    );
  }

  // Nothing is drawn until the server has said which of the two screens this
  // deployment is on. A door that appeared and was then replaced by the
  // first-run flow would be a door that existed.
  if (!session && setupState.status === 'loading') {
    return (
      <div className="signin">
        <div className="signin__card">
          <h1 className="signin__title">Fathom</h1>
          <p className="signin__subtitle">Asking the server whether this deployment is set up…</p>
        </div>
      </div>
    );
  }

  if (!session) {
    const toSignIn = (address?: string, notice?: string) => {
      setSignInAddress(address);
      setSignInNotice(notice ?? null);
      setDoor('sign-in');
    };
    if (door === 'enrol') {
      return (
        <Enrol
          initialToken={invitationToken ?? undefined}
          onUseExistingKey={() => setDoor('sign-in')}
        />
      );
    }
    if (door === 'reset') {
      return <Reset initialToken={resetToken ?? undefined} onUseSignIn={toSignIn} />;
    }
    // One link under the card (ADR-0056 decision 6): the reset door. The
    // invitation has its own address and the setup door is the server's call,
    // so neither is offered here.
    return (
      <SignIn
        onForgotPassword={() => setDoor('reset')}
        initialAddress={signInAddress}
        notice={signInNotice}
      />
    );
  }

  // ADR-0055 client (a): the account's own credential screen, opened from
  // Home. **Placement is this stream's own call and the shell's owner may
  // move it**: ADR-0055 gives every signed-in person a password and an app
  // code to manage and `docs/UI-SPEC.md` has no place for them yet, so the
  // way in is a text button above Home rather than a new region.
  if (accountOpen && session.kind === 'steward') {
    return <Account address={session.address} onClose={() => setAccountOpen(false)} />;
  }

  // The organisation claim screen (ADR-0057 decision 5). Needs a steward
  // session to redeem against, so it never renders for the operator plane.
  if (claiming !== null && session.kind === 'steward') {
    return (
      <ClaimOrganisation
        accountAddress={session.address}
        accountId={session.accountId}
        initialToken={claiming.token}
        initialNoticeAddress={claiming.noticeAddress}
        onDone={() => setClaiming(null)}
        onCancel={() => setClaiming(null)}
      />
    );
  }

  // ADR-0055 client (a): the typed refusal routes here, and nowhere else is
  // reachable from this session until the authenticator app is enrolled.
  if (appCodeNeeded === true) {
    return (
      <Account
        address={session.address}
        purpose="app-code"
        onDone={() => setAppCodeNeeded(false)}
      />
    );
  }

  const account = {
    // An operator id is a ulid, whose "initials" would be two digits: the
    // chip says what the session is instead.
    initials: session.kind === 'operator' ? 'OP' : initialsFromAddress(session.address),
    address: session.address,
  };

  // The account menu's own rows (ADR-0047 §3): each present only when it
  // acts. Site is offered only on a host the console answers on, and goes
  // once the server has said this account holds no operator custody.
  const accountSessionOpen = accountSessionId !== null;
  const backToHome = () => {
    setView({ kind: 'home' });
    setPlane(ACCOUNT_PLANE);
  };
  // "Claim it now" (ADR-0057 decision 5): switches to the account plane and
  // carries the freshly minted claim across so ClaimOrganisation needs no typing.
  const claimNow = (claim: OrganisationClaim) => {
    setView({ kind: 'home' });
    setPlane(ACCOUNT_PLANE);
    setClaiming({ token: claim.token, noticeAddress: claim.noticeAddress });
  };
  const menu =
    session.kind === 'operator' ? (
      <>
        {accountSessionOpen && (
          <PopoverRow testId="console-home" onSelect={backToHome}>
            Home
          </PopoverRow>
        )}
        <PopoverRow current>Site</PopoverRow>
      </>
    ) : (
      <>
        <PopoverRow onSelect={() => setAccountOpen(true)}>Password and authenticator</PopoverRow>
        {consoleHost && !custodyRefused && operatorCodePending && (
          // ADR-0057 decision 2: a live account session endorses Site, and
          // one whose own second-factor proof has gone stale needs a
          // current code beside it — asked right here, in the same place
          // Site is entered, rather than on a screen of its own.
          <form
            className="popover-row popover-row--form"
            data-testid="console-code-prompt"
            onSubmit={(event) => void submitOperatorCode(event)}
          >
            <label htmlFor="console-verification-code">Verification code</label>
            <input
              id="console-verification-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              value={operatorCode}
              onChange={(event) => setOperatorCode(event.target.value)}
              disabled={enteringConsole}
              required
            />
            <button type="submit" disabled={enteringConsole || operatorCode.trim().length === 0}>
              {enteringConsole ? 'Checking…' : 'Continue'}
            </button>
          </form>
        )}
        {consoleHost && !custodyRefused && !operatorCodePending && (
          <PopoverRow testId="console-entry" disabled={enteringConsole} onSelect={() => void enterConsole()}>
            {enteringConsole ? 'Opening Site…' : 'Site'}
          </PopoverRow>
        )}
      </>
    );

  // Everything the two views share. `canUndo`/`canRedo`/`onUndo`/`onRedo`
  // are a stub HERE — always present, always disabled — because Home has no
  // open design to undo anything in; `DesignPlace.tsx` overrides all four
  // with the live ones (ADR-0053 §1, off `document/undo.ts`'s `undoable`)
  // the moment a place actually renders, so the bar's chips are real
  // wherever a design is open.
  const common = {
    menu,
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
        // ADR-0055 decision 1: the account session did not end when this one
        // began, so Home is a change of plane, not a sign-in.
        onHome={accountSessionOpen ? backToHome : undefined}
      >
        <Console operatorId={session.address} onClaimNow={accountSessionOpen ? claimNow : undefined} />
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
          onDirectEntry={directEntrySession === accountSessionId ? undefined : handleDirectEntry}
          notice={consoleRefusal}
          onClaimOrganisation={() => setClaiming({})}
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
    onPlaceChange: (place: Place) => {
      if (!LENSES_IN[place].includes(lens)) setLens('cables');
      setView({ ...view, place });
    },
    onHome: () => setView({ kind: 'home' }),
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

/**
 * The operator this browser already holds a key for, or `null`.
 *
 * `crypto/keys.ts` files an operator's key under `operator:<id>`
 * (`api/constants.ts`'s `keySlot`), and IndexedDB is per origin, so the slots
 * this reads belong to this install and no other. `SignIn.tsx` reads the same
 * list to offer the identities this browser can prove.
 */
async function operatorSlotHeldHere(): Promise<string | null> {
  try {
    const { enrolled } = await listKeySlots();
    for (const slot of enrolled) {
      const who = identityOfSlot(slot);
      if (who.kind === PRINCIPAL_KIND_OPERATOR && who.id !== '?') {
        return who.id;
      }
    }
  } catch {
    // No storage, or a browser that refuses it: the bootstrap below is the
    // honest fallback, not an error worth showing.
  }
  return null;
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
