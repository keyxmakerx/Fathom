import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  cancelInvitation,
  describeError,
  fetchWaiting,
  issueInvitation,
  proposeConfirm,
  refuseInvitation,
  signAndConfirm,
  type Asked,
  type IssuedInvitation,
  type Waiting,
} from '../../api/invitations';
import type { Organisation } from '../../api/organisations';
import { fetchPeople, removeAccess, secondSteward, type AccessRow, type People } from '../../api/people';
import type { Scope } from '../../api/scopes';
import { shareWith } from '../../api/share';
import { canStewardFor } from '../home/capabilities';
import { FoldersPanel, type Loadable } from './FoldersPanel';
import { InviteForm, LinkCard } from './InvitePanel';
import { accessWords, dateTimeLabel } from './model';
import { PeopleList, PersonPage } from './PeoplePanel';
import { WaitingPanel } from './WaitingPanel';
import './organisation.css';

type Page = { kind: 'people' } | { kind: 'person'; account: string } | { kind: 'invite' } | { kind: 'link'; issued: IssuedInvitation; name: string; access: string } | { kind: 'waiting' } | { kind: 'folders' };

export interface OrganisationTabProps {
  organisation: Organisation;
  scopes: Loadable<Scope[]>;
  onCreateScope: (parentId: string | null, parentLabel: string, child: string) => void;
  scopeForm: ReactNode;
}


/**
 * The Organisation tab (ADR-0060 decision 7): People, Waiting for you and
 * Folders in a rail on the left. People and Waiting are for stewards: the
 * server refuses anyone else before it reads a row, and this tab then shows
 * that refusal in place of the list, with no Waiting entry and no emails.
 */
export function OrganisationTab({ organisation, scopes, onCreateScope, scopeForm }: OrganisationTabProps) {
  const org = organisation.organisationId;
  const [page, setPage] = useState<Page>({ kind: 'people' });
  const [people, setPeople] = useState<Loadable<People>>({ status: 'loading' });
  const [waiting, setWaiting] = useState<Loadable<Waiting>>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchPeople(org).then(
      (value) => setPeople({ status: 'ready', value }),
      (e: unknown) => setPeople({ status: 'error', message: describeError(e) }),
    );
    fetchWaiting(org).then(
      (value) => setWaiting({ status: 'ready', value }),
      (e: unknown) => setWaiting({ status: 'error', message: describeError(e) }),
    );
  }, [org]);

  useEffect(() => {
    setPeople({ status: 'loading' });
    setWaiting({ status: 'loading' });
    setPage({ kind: 'people' });
    reload();
  }, [reload]);

  const folders = scopes.status === 'ready' ? scopes.value.filter((s) => canStewardFor(s.capability)) : [];
  const waitingReady = waiting.status === 'ready';
  const needs = waitingReady ? waiting.value.waitingCount + waiting.value.seconding.length : 0;

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function go(next: Page) {
    setError(null);
    setNotice(null);
    setPage(next);
  }

  const peopleView = () => {
    if (people.status === 'loading') return <p className="home__muted">Loading…</p>;
    if (people.status === 'error') {
      return (
        <section className="org-page">
          <div className="org-page__title">People</div>
          <p className="home__error" role="alert" data-testid="people-refused">
            {people.message}
          </p>
          <p className="home__muted">
            Only stewards see who is in an organisation and what they can do. A steward can give you that.
          </p>
        </section>
      );
    }
    const joined = waitingReady
      ? waiting.value.invitations
          .filter((i) => i.canConfirm)
          .map((i) => ({ name: i.displayName, asked: accessWords(i.capabilityAsked, i.scopeId, i.scopeLabel) }))
      : [];
    const seconding = waitingReady
      ? waiting.value.seconding.map((s) => ({ granter: s.granterName, subject: s.subjectName, where: s.scopeId === null ? 'the whole organisation' : s.scopeLabel }))
      : [];
    return (
      <PeopleList
        people={people.value}
        needsYou={{ joined, seconding }}
        onOpenPerson={(account) => go({ kind: 'person', account })}
        onInvite={() => go({ kind: 'invite' })}
        onOpenWaiting={() => go({ kind: 'waiting' })}
      />
    );
  };

  function content() {
    if (page.kind === 'folders') {
      return <FoldersPanel organisationName={organisation.displayName} scopes={scopes} onCreateScope={onCreateScope} scopeForm={scopeForm} />;
    }
    if (page.kind === 'invite') {
      return (
        <InviteForm
          folders={folders}
          organisationName={organisation.displayName}
          busy={busy}
          error={error}
          onCancel={() => go({ kind: 'people' })}
          onSubmit={(request) =>
            void act(async () => {
              const issued = await issueInvitation(org, request);
              const label = request.scopeId === null ? organisation.displayName : (folders.find((f) => f.scopeId === request.scopeId)?.displayName ?? '');
              setPage({ kind: 'link', issued, name: request.name, access: accessWords(request.capability as Asked, request.scopeId, label) });
              reload();
            })
          }
        />
      );
    }
    if (page.kind === 'link') {
      return (
        <LinkCard
          invitation={page.issued}
          name={page.name}
          access={page.access}
          origin={typeof window === 'undefined' ? '' : window.location.origin}
          onDone={() => go({ kind: 'people' })}
          onAnother={() => go({ kind: 'invite' })}
        />
      );
    }
    if (page.kind === 'waiting') {
      if (waiting.status === 'loading') return <p className="home__muted">Loading…</p>;
      if (waiting.status === 'error') {
        return (
          <section className="org-page">
            <div className="org-page__title">Waiting for you</div>
            <p className="home__error" role="alert" data-testid="waiting-refused">
              {waiting.message}
            </p>
          </section>
        );
      }
      return (
        <WaitingPanel
          waiting={waiting.value}
          folders={folders}
          organisationName={organisation.displayName}
          describeError={describeError}
          onPropose={(rows, expiry) => proposeConfirm(org, rows, expiry)}
          onSign={signAndConfirm}
          onRefuse={(id) => refuseInvitation(org, id)}
          onApprove={(item) => secondSteward(org, item)}
          onChanged={reload}
        />
      );
    }
    if (page.kind === 'person') {
      if (people.status !== 'ready') return peopleView();
      const person = people.value.people.find((p) => p.account === page.account);
      if (!person) return peopleView();
      return (
        <PersonPage
          person={person}
          folders={folders}
          busy={busy}
          error={error}
          notice={notice}
          onBack={() => go({ kind: 'people' })}
          onOpenWaiting={() => go({ kind: 'waiting' })}
          onRemove={(row: AccessRow) =>
            void act(async () => {
              const result = await removeAccess(org, row);
              setNotice(
                result.delayed && result.takesEffectAtUnix !== null
                  ? `Signed. This steward keeps their access until ${dateTimeLabel(result.takesEffectAtUnix)}, 24 hours after you signed.`
                  : 'Removed and signed. It is in the organisation’s history.',
              );
              reload();
            })
          }
          onGive={(capability, scopeId) =>
            void act(async () => {
              await shareWith(org, scopeId, person.account, capability);
              setNotice('Signed. They have that access now.');
              reload();
            })
          }
          onWithdraw={() =>
            void act(async () => {
              if (person.invitation) await cancelInvitation(org, person.invitation);
              setPage({ kind: 'people' });
              reload();
            })
          }
        />
      );
    }
    return peopleView();
  }

  const current = page.kind === 'person' || page.kind === 'invite' || page.kind === 'link' ? 'people' : page.kind;

  return (
    <div className="org">
      <nav className="org-rail" aria-label="Organisation">
        <button type="button" className={current === 'people' ? 'org-rail__item org-rail__item--on' : 'org-rail__item'} aria-current={current === 'people' ? 'page' : undefined} onClick={() => go({ kind: 'people' })}>
          People
        </button>
        {waitingReady && (
          <button type="button" className={current === 'waiting' ? 'org-rail__item org-rail__item--on' : 'org-rail__item'} data-testid="rail-waiting" aria-current={current === 'waiting' ? 'page' : undefined} onClick={() => go({ kind: 'waiting' })}>
            Waiting for you{needs > 0 ? ` (${needs})` : ''}
          </button>
        )}
        <button type="button" className={current === 'folders' ? 'org-rail__item org-rail__item--on' : 'org-rail__item'} aria-current={current === 'folders' ? 'page' : undefined} onClick={() => go({ kind: 'folders' })}>
          Folders
        </button>
      </nav>
      <div className="org__body">{content()}</div>
    </div>
  );
}

