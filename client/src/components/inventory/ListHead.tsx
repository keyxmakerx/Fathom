// The list's heading: kind (and view), how many of how many, and saving the line as a view.

import { useState } from 'react';

export interface ListHeadProps {
  title: string;
  shown: number;
  total: number;
  /** The line differs from the view it came from. */
  edited: boolean;
  /** The view is mine, so "Save" can overwrite it. */
  canUpdate: boolean;
  hasQuery: boolean;
  onUpdate: () => void;
  onSaveAs: (name: string) => void;
}

const fmt = (n: number): string => n.toLocaleString('en-GB');

export function ListHead(props: ListHeadProps) {
  const { title, shown, total, edited, canUpdate, hasQuery, onUpdate, onSaveAs } = props;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  return (
    <div className="inv-head">
      <div className="inv-head__row">
        <h2 className="inv-head__title">{title}</h2>
        <span className="inv-head__count">
          {fmt(shown)} of {fmt(total)}
          {edited ? ' · edited' : ''}
        </span>
        <span className="inv-head__grow" />
        {edited && canUpdate ? (
          <button type="button" onClick={onUpdate}>
            Save
          </button>
        ) : null}
        {hasQuery ? (
          <button type="button" aria-expanded={naming} onClick={() => setNaming(!naming)}>
            Save as a view
          </button>
        ) : null}
      </div>
      {naming ? (
        <form
          className="inv-head__save"
          onSubmit={(e) => {
            e.preventDefault();
            onSaveAs(name);
            setName('');
            setNaming(false);
          }}
        >
          <input aria-label="View name" placeholder="Name this view" value={name} onChange={(e) => setName(e.currentTarget.value)} autoFocus />
          <button type="submit">Save to my views</button>
          <span className="inv-head__hint">It appears under {title.split(' › ')[0]} with its count.</span>
        </form>
      ) : null}
    </div>
  );
}
