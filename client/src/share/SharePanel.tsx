import { useCallback, useEffect, useState } from 'react';

import { fetchAccess, setShare } from '../api/share';
import type { AccessPerson, ShareChoice, Standing } from '../api/share';
import './share.css';

const LABEL: Record<'steward' | 'draw' | 'read', string> = { steward: 'Steward', draw: 'Draw', read: 'View' };

/** The select's value for a person, or `null` when this panel does not set it
 * (a steward, you, or a standing that comes from above this scope). */
export function choiceFor(person: AccessPerson): ShareChoice | null {
  if (person.you || person.standing === 'steward' || person.inherited) return null;
  return person.standing === 'read' || person.standing === 'draw' ? person.standing : 'none';
}

function standingText(standing: Standing, inherited: boolean): string {
  if (standing == null) return 'No access';
  return inherited && standing !== 'steward' ? `${LABEL[standing]} · inherited` : LABEL[standing];
}

export interface AccessTableProps {
  people: AccessPerson[];
  busy: string | null;
  onChoose: (person: AccessPerson, choice: ShareChoice) => void;
}

/** PERSON / CAN, one row each. */
export function AccessTable({ people, busy, onChoose }: AccessTableProps) {
  return (
    <table className="share-panel__table">
      <thead>
        <tr>
          <th>Person</th>
          <th>Can</th>
        </tr>
      </thead>
      <tbody>
        {people.map((person) => {
          const choice = choiceFor(person);
          return (
            <tr key={person.account}>
              <td>
                {person.name || person.email}
                {person.you ? ' · you' : ''}
              </td>
              <td>
                {choice == null ? (
                  standingText(person.standing, person.inherited)
                ) : (
                  <select
                    value={choice}
                    disabled={busy != null}
                    aria-label={`What ${person.name || person.email} can do`}
                    onChange={(e) => onChoose(person, e.target.value as ShareChoice)}
                  >
                    <option value="none">No access</option>
                    <option value="read">View</option>
                    <option value="draw">Draw</option>
                  </select>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface SharePanelProps {
  organisationId: string;
  scopeId: string;
  /** The scope's name, e.g. "Office network". */
  title: string;
  onClose: () => void;
}

/** Share a scope with people already in the organisation. Stewards only; the
 * server decides, this just doesn't offer it to anyone else. */
export function SharePanel({ organisationId, scopeId, title, onClose }: SharePanelProps) {
  const [people, setPeople] = useState<AccessPerson[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPeople(await fetchAccess(organisationId, scopeId));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not load who can see this.');
    }
  }, [organisationId, scopeId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  async function choose(person: AccessPerson, choice: ShareChoice) {
    setBusy(person.account);
    setProblem(null);
    try {
      await setShare(organisationId, scopeId, person, choice);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That did not go through.');
    }
    await load();
    setBusy(null);
  }

  return (
    <div className="share-panel" role="dialog" aria-label={`Share ${title}`} data-testid="share-panel">
      <div className="share-panel__head">
        <span>Share {title}</span>
        <button type="button" className="share-panel__close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>
      {people == null ? (
        <p className="share-panel__note">{problem ?? 'Loading…'}</p>
      ) : (
        <AccessTable people={people} busy={busy} onChoose={(p, c) => void choose(p, c)} />
      )}
      {people != null && problem != null && (
        <p className="share-panel__problem" role="alert">
          {problem}
        </p>
      )}
      <p className="share-panel__note">
        View: see everything, change nothing. Draw: edit. Only people already in your organisation can be added; they need to be in it first.
      </p>
    </div>
  );
}
