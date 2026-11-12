// Inventory › Tags (sign-offs r111, from r110 item C): every tag in the design, how many things carry
// it, and the two design-wide tag actions ADR-0059 decision 8 names, rename and remove. Removing asks
// once, saying how many things lose the tag, and is one undoable change (`removeTag`). Tags nothing
// carries are listed last, marked "Not used", because this is the one place they can still be seen
// and deleted (`listTags`' own doc). Read sees the list; Draw renames and deletes.

import { useState } from 'react';

import type { Document } from '../../document/model';
import { TagRefusalError, listTags, removeTag, renameTag, type TagSummary } from '../../document/tags';
import { getSession } from '../../state/sessionState';
import './tagsPanel.css';

function actorOpts(): { actor: string } | undefined {
  const s = getSession();
  return s ? { actor: s.accountId } : undefined;
}

/** "12 things", "1 thing": the words the confirm uses. */
export function thingsWord(n: number): string {
  return n === 1 ? '1 thing' : `${n.toLocaleString('en-GB')} things`;
}

/** Used tags by name, then the ones nothing carries, by name. */
export function tagsPanelRows(doc: Document): TagSummary[] {
  const all = listTags(doc, { includeEmpty: true });
  return [...all.filter((t) => t.count > 0), ...all.filter((t) => t.count === 0)];
}

export interface TagsPanelProps {
  doc: Document | null;
  canDraw: boolean;
  applyDocChange: (next: Document) => void;
}

export function TagsPanel({ doc, canDraw, applyDocChange }: TagsPanelProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!doc) return <p className="inventory-place__muted">No design is open.</p>;
  const rows = tagsPanelRows(doc);

  function run(make: () => Document, done: string | null) {
    try {
      const next = make();
      if (next !== doc) applyDocChange(next);
      setRefusal(null);
      setNotice(done);
    } catch (e) {
      if (e instanceof TagRefusalError) setRefusal(e.message);
      else throw e;
    }
  }

  function commitRename() {
    if (!renaming || !doc) return;
    const draft = renaming.draft.trim();
    if (draft === '') {
      setRenaming(null);
      return;
    }
    let ok = true;
    try {
      const next = renameTag(doc, renaming.id, draft, actorOpts());
      if (next !== doc) applyDocChange(next);
      setRefusal(null);
    } catch (e) {
      if (!(e instanceof TagRefusalError)) throw e;
      setRefusal(e.message);
      ok = false;
    }
    if (ok) setRenaming(null);
  }

  return (
    <div className="tags-panel">
      <div className="tags-panel__head">
        <h2 className="tags-panel__title">Tags</h2>
        <p className="tags-panel__lede">
          Every tag in this design. Add a tag from any device, port, cable, rack or network.
          {canDraw ? ' Deleting a tag takes it off everything that carries it; Undo puts it back.' : ''}
        </p>
      </div>
      {refusal ? (
        <p className="tags-panel__refusal" role="alert">
          {refusal}
        </p>
      ) : null}
      {notice ? (
        <p className="tags-panel__notice" role="status">
          {notice}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="inventory-place__muted">No tags yet.</p>
      ) : (
        <table className="tags-panel__table">
          <thead>
            <tr>
              <th scope="col">Tag</th>
              <th scope="col" className="tags-panel__num">
                Used on
              </th>
              {canDraw ? <th scope="col" aria-label="Actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} data-empty={t.count === 0 ? 'yes' : undefined}>
                <td>
                  {renaming?.id === t.id ? (
                    <input
                      autoFocus
                      className="tags-panel__input"
                      aria-label={`Rename tag ${t.name}`}
                      value={renaming.draft}
                      onChange={(e) => setRenaming({ id: t.id, draft: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        else if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <span className="tags-panel__chip">{t.name}</span>
                  )}
                </td>
                <td className="tags-panel__num">
                  {t.count === 0 ? (
                    <span className="tags-panel__unused">Not used</span>
                  ) : (
                    thingsWord(t.count)
                  )}
                </td>
                {canDraw ? (
                  <td className="tags-panel__acts">
                    {confirming === t.id ? (
                      <span className="tags-panel__confirm" role="group" aria-label={`Delete tag ${t.name}?`}>
                        <span>{t.count === 0 ? `Delete “${t.name}”?` : `Delete “${t.name}” from ${thingsWord(t.count)}?`}</span>
                        <button
                          type="button"
                          className="btn-danger btn-small"
                          onClick={() => {
                            setConfirming(null);
                            run(() => removeTag(doc, t.id, actorOpts()), `Deleted “${t.name}”. Undo puts it back.`);
                          }}
                        >
                          Delete tag
                        </button>
                        <button type="button" className="btn-small" onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <>
                        <button type="button" className="btn-quiet btn-small" onClick={() => setRenaming({ id: t.id, draft: t.name })} aria-label={`Rename tag ${t.name}`}>
                          Rename
                        </button>
                        <button
                          type="button"
                          className="btn-danger btn-small"
                          aria-label={`Delete tag ${t.name}`}
                          onClick={() => {
                            setNotice(null);
                            setConfirming(t.id);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
