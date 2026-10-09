import type { ReactNode } from 'react';

import type { Scope } from '../../api/scopes';
import { canStewardFor } from '../home/capabilities';

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
}

/** The organisation's folders: Sites, Buildings and Closets, and where to make more. */
export function FoldersPanel({ organisationName, scopes, onCreateScope, scopeForm }: FoldersPanelProps) {
  return (
    <section className="home__section">
      <div className="home__section-head">
        <div className="home__label">Folders</div>
        <button type="button" className="home__btn home__btn--small" onClick={() => onCreateScope(null, organisationName, 'site')}>
          New site
        </button>
      </div>
      <p className="home__muted">Sites, Buildings and Closets sort designs. None is needed to start one.</p>
      {scopeForm}
      {scopes.status === 'loading' && <p className="home__muted">Loading…</p>}
      {scopes.status === 'error' && <p className="home__error">{scopes.message}</p>}
      {scopes.status === 'ready' && scopes.value.length === 0 && <p className="home__muted">No folders yet.</p>}
      {scopes.status === 'ready' && scopes.value.length > 0 && (
        <ul className="home-folders">
          {scopes.value.map((scope) => {
            const child = CHILD_LEVEL[scope.kind];
            return (
              <li
                key={scope.scopeId}
                className="home-folders__row"
                style={{ paddingLeft: `calc(${Math.max(0, scope.depth - 1)} * var(--s4))` }}
              >
                <span className="home__scope-name">{scope.displayName}</span>
                <span className="home__scope-kind">{LEVEL[scope.kind] ?? scope.kind}</span>
                {canStewardFor(scope.capability) && child && (
                  <button
                    type="button"
                    className="home__btn home__btn--small"
                    onClick={() => onCreateScope(scope.scopeId, scope.displayName, child)}
                  >
                    New {child}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
