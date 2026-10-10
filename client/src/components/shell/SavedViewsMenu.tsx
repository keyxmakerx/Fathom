import { useState, type FormEvent } from 'react';

import { LAYERS } from '../drawing/layers';
import { BAR_VIEWS, layersSummary, MAX_NAME, type SavedView } from '../drawing/savedViews';
import { Popover, usePopoverClose } from './Popover';
import '../../styles/views.css';

const LAYER_LABELS: Record<string, string> = Object.fromEntries(LAYERS.map((l) => [l.id, l.label]));

export interface SavedViewsMenuProps {
  views: readonly SavedView[];
  /** The saved view the drawing is showing right now, if it is showing one. */
  currentId?: string | null;
  /** Keeps the camera and Show layers as they are now under a name; a sentence if refused. */
  onSave: (name: string) => string | null;
  /** Goes to a saved view: glides the camera and sets its layers. */
  onGo: (view: SavedView) => void;
  onRename: (id: string, name: string) => string | null;
  onDelete: (id: string) => void;
}

/** The Views group in the bar, one segmented row: the Views button (the manage menu), a button for
 * each of the first few saved views, and "+" to keep the current view under a name. Yours, in this
 * browser. */
export function SavedViewsMenu(props: SavedViewsMenuProps) {
  const { views, currentId = null, onSave, onGo } = props;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const refused = onSave(name);
    setNote(refused);
    if (refused == null) {
      setName('');
      setAdding(false);
    }
  };
  const cancel = () => {
    setAdding(false);
    setName('');
    setNote(null);
  };

  return (
    <div className="vgroup" role="group" aria-label="Saved views">
      <Popover
        renderTrigger={({ open, triggerProps, triggerRef }) => (
          <button
            type="button"
            className={open ? 'vgroup__btn vgroup__btn--on' : 'vgroup__btn'}
            data-testid="shell-views"
            ref={(el) => {
              triggerRef.current = el;
            }}
            {...triggerProps}
          >
            <svg className="vgroup__eye" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" />
              <circle cx="8" cy="8" r="2" />
            </svg>
            Views
          </button>
        )}
      >
        <ViewsBody {...props} />
      </Popover>
      {views.slice(0, BAR_VIEWS).map((v) => (
        <button
          key={v.id}
          type="button"
          className={v.id === currentId ? 'vgroup__btn vgroup__btn--view vgroup__btn--current' : 'vgroup__btn vgroup__btn--view'}
          aria-pressed={v.id === currentId}
          data-testid="views-bar-go"
          title={`Go to ${v.name}`}
          onClick={() => onGo(v)}
        >
          {v.name}
        </button>
      ))}
      {adding ? (
        <form className="vgroup__add" onSubmit={submit}>
          <input
            autoFocus
            aria-label="Name this view"
            placeholder="Name this view"
            value={name}
            maxLength={MAX_NAME}
            data-testid="views-add-name"
            onChange={(e) => {
              setName(e.currentTarget.value);
              setNote(null);
            }}
            onBlur={() => name.trim() === '' && cancel()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                cancel();
              }
            }}
          />
          {note != null && (
            <p className="vgroup__note" role="alert">
              {note}
            </p>
          )}
        </form>
      ) : (
        <button type="button" className="vgroup__btn vgroup__btn--plus" aria-label="Save this view" title="Save this view" data-testid="views-add" onClick={() => setAdding(true)}>
          +
        </button>
      )}
    </div>
  );
}

/** The same manage list, for the bar's View menu when the bar is too narrow for the group. */
export function SavedViewsFolded(props: SavedViewsMenuProps) {
  return <ViewsBody {...props} />;
}

function ViewsBody({ views, currentId = null, onSave, onGo, onRename, onDelete }: SavedViewsMenuProps) {
  const close = usePopoverClose();
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const refused = onSave(name);
    setNote(refused);
    if (refused == null) setName('');
  };

  return (
    <div className="views" role="group" aria-label="Saved views">
      <div className="views__head">Saved views</div>
      {views.length === 0 ? (
        <p className="views__empty">
          Nothing saved yet. Set the camera and the Show layers how you want them, name the view below, and come back to it in one click.
        </p>
      ) : (
        <ul className="views__list">
          {views.map((v) =>
            renaming?.id === v.id ? (
              <li key={v.id} className="views__row">
                <form
                  className="views__rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const refused = onRename(v.id, renaming.text);
                    setNote(refused);
                    if (refused == null) setRenaming(null);
                  }}
                >
                  <input
                    autoFocus
                    aria-label={`New name for ${v.name}`}
                    value={renaming.text}
                    maxLength={MAX_NAME}
                    onChange={(e) => setRenaming({ id: v.id, text: e.currentTarget.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                  />
                  <button type="submit">Save</button>
                </form>
              </li>
            ) : (
              <li key={v.id} className="views__row">
                <button
                  type="button"
                  role="menuitem"
                  className={v.id === currentId ? 'views__go views__go--current' : 'views__go'}
                  data-testid="views-go"
                  title={`Go to ${v.name}`}
                  onClick={() => {
                    close();
                    onGo(v);
                  }}
                >
                  <span className="views__name">{v.name}</span>
                  <span className="views__what">
                    {v.look === 'diagram' ? 'Diagram' : 'Rack'} · {Math.round(v.camera.zoom * 100)}% · {layersSummary(v.layers, LAYER_LABELS)}
                  </span>
                </button>
                <button type="button" className="views__small" aria-label={`Rename ${v.name}`} onClick={() => setRenaming({ id: v.id, text: v.name })}>
                  Rename
                </button>
                <button type="button" className="views__small" aria-label={`Delete ${v.name}`} onClick={() => onDelete(v.id)}>
                  Delete
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      <form className="views__save" onSubmit={save}>
        <input
          aria-label="Name this view"
          placeholder="Core rack, VLANs on"
          value={name}
          maxLength={MAX_NAME}
          onChange={(e) => {
            setName(e.currentTarget.value);
            setNote(null);
          }}
        />
        <button type="submit" data-testid="views-save">
          Save this view
        </button>
      </form>
      {note != null && (
        <p className="views__note" role="alert">
          {note}
        </p>
      )}
      <p className="views__hint">Yours, in this browser, for this design.</p>
    </div>
  );
}
