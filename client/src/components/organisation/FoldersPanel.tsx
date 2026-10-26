import { useState, type ReactNode } from 'react';

import type { Place, Scope } from '../../api/scopes';
import { canStewardFor } from '../home/capabilities';
import { EmptyState } from '../ui/EmptyState';
import { PLACE_ROLES, placeFormLabel, placeFormsFor, placeRoleLabel, takesRole } from './place';

/** The interface's names for the server's scope kinds (the owner, 2026-09-23). */
const LEVEL: Record<string, string> = { network: 'Site', building: 'Building', rack: 'Closet' };
/** What can be created under each kind (`child_kind_under` on the server). */
const CHILD_LEVEL: Record<string, string | null> = { network: 'building', building: 'closet', rack: null };

export type Loadable<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

export interface FoldersPanelProps {
  organisationName: string;
  scopes: Loadable<Scope[]>;
  /** ADR-0054 §3: opens the new-folder form under `parentId`, or at the top when `null`. */
  onCreateScope: (parentId: string | null, parentLabel: string, child: string) => void;
  /** The open new-folder form, if any. */
  scopeForm: ReactNode;
  /** ADR-0074: a steward sets what kind of place a folder is and its role. Absent, the
   * words are shown but cannot be changed here. */
  onSetPlace?: (scopeId: string, place: Place) => Promise<void>;
}

/** The organisation's folders: Sites, Buildings and Closets, and where to make more. */
export function FoldersPanel({ organisationName, scopes, onCreateScope, scopeForm, onSetPlace }: FoldersPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section className="home__section">
      <div className="home__section-head">
        <div className="home__label">Folders</div>
        <button type="button" className="home__btn home__btn--small" onClick={() => onCreateScope(null, organisationName, 'site')}>
          New site
        </button>
      </div>
      <p className="home__muted">
        Sites, Buildings and Closets sort designs, and say who may read, draw or look after them. None is needed to start one.
        Zoomed out, Fathom draws them as the map of your estate, with hubs in a double border.
      </p>
      {scopeForm}
      {scopes.status === 'loading' && <p className="home__muted">Loading…</p>}
      {scopes.status === 'error' && <p className="home__error">{scopes.message}</p>}
      {scopes.status === 'ready' && scopes.value.length === 0 && (
        <EmptyState
          title="No folders yet."
          compact
          action={{ label: 'New site', onClick: () => onCreateScope(null, organisationName, 'site') }}
        >
          A site is the first folder. Buildings and closets go inside it.
        </EmptyState>
      )}
      {scopes.status === 'ready' && scopes.value.length > 0 && (
        <ul className="home-folders">
          {scopes.value.map((scope) => {
            const child = CHILD_LEVEL[scope.kind];
            const steward = canStewardFor(scope.capability);
            const form = placeFormLabel(scope.kind, scope.placeForm);
            const role = takesRole(scope.kind) ? placeRoleLabel(scope.placeRole) : null;
            return (
              <li
                key={scope.scopeId}
                className="home-folders__row"
                style={{ paddingLeft: `calc(${Math.max(0, scope.depth - 1)} * var(--s4))` }}
              >
                <span className="home__scope-name">{scope.displayName}</span>
                <span className="home__scope-kind">{LEVEL[scope.kind] ?? scope.kind}</span>
                {form && <span className="home-folders__form">{form}</span>}
                {role && (
                  <span className={`home-folders__role${scope.placeRole === 'hub' ? ' home-folders__role--hub' : ''}`}>{role}</span>
                )}
                {steward && onSetPlace && editing !== scope.scopeId && (
                  <button type="button" className="home__btn home__btn--small home-folders__place-btn" onClick={() => setEditing(scope.scopeId)}>
                    {takesRole(scope.kind) ? 'Kind and role' : 'Kind of room'}
                  </button>
                )}
                {steward && child && (
                  <button
                    type="button"
                    className="home__btn home__btn--small"
                    onClick={() => onCreateScope(scope.scopeId, scope.displayName, child)}
                  >
                    New {child}
                  </button>
                )}
                {editing === scope.scopeId && onSetPlace && (
                  <PlaceEditor
                    scope={scope}
                    onCancel={() => setEditing(null)}
                    onSave={async (place) => {
                      await onSetPlace(scope.scopeId, place);
                      setEditing(null);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface PlaceFieldsProps {
  /** The server's kind of the folder: `network`, `building` or `rack`. */
  kind: string;
  place: Place;
  onChange: (place: Place) => void;
  /** Distinguishes the ids of two sets of fields on one page. */
  idPrefix: string;
}

/** ADR-0074's two words as selects, shared by the new-folder form and the row editor. */
export function PlaceFields({ kind, place, onChange, idPrefix }: PlaceFieldsProps) {
  return (
    <>
      <label className="home-folders__place-label" htmlFor={`${idPrefix}-form`}>
        {kind === 'rack' ? 'Kind of room' : 'Kind of place'}
      </label>
      <select
        id={`${idPrefix}-form`}
        className="home-folders__place-select"
        value={place.form ?? ''}
        onChange={(e) => onChange({ ...place, form: e.target.value || null })}
      >
        <option value="">Not said</option>
        {placeFormsFor(kind).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {takesRole(kind) && (
        <>
          <label className="home-folders__place-label" htmlFor={`${idPrefix}-role`}>
            Role
          </label>
          <select
            id={`${idPrefix}-role`}
            className="home-folders__place-select"
            value={place.role ?? ''}
            onChange={(e) => onChange({ ...place, role: e.target.value || null })}
          >
            <option value="">Not said</option>
            {PLACE_ROLES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      )}
    </>
  );
}

interface PlaceEditorProps {
  scope: Scope;
  onSave: (place: Place) => Promise<void>;
  onCancel: () => void;
}

function PlaceEditor({ scope, onSave, onCancel }: PlaceEditorProps) {
  const [place, setPlace] = useState<Place>({ form: scope.placeForm ?? null, role: scope.placeRole ?? null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="home-folders__place-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        onSave(place)
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false));
      }}
    >
      <PlaceFields kind={scope.kind} place={place} onChange={setPlace} idPrefix={`place-${scope.scopeId}`} />
      <button type="submit" className="home__btn home__btn--small" disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="home__btn home__btn--small" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      {takesRole(scope.kind) && <p className="home__muted home-folders__place-note">Fathom never decides a hub for you: it is what you set here.</p>}
      {error && <p className="home__error">{error}</p>}
    </form>
  );
}
