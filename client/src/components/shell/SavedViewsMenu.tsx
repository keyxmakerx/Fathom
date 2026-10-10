import { useState, type FormEvent } from 'react';

import { LAYERS } from '../drawing/layers';
import { layersSummary, MAX_NAME, type SavedView } from '../drawing/savedViews';
import { Popover, usePopoverClose } from './Popover';
import '../../styles/views.css';

const LAYER_LABELS: Record<string, string> = Object.fromEntries(LAYERS.map((l) => [l.id, l.label]));

export interface SavedViewsMenuProps {
  views: readonly SavedView[];
  /** Keeps the camera and Show layers as they are now under a name; a sentence if refused. */
  onSave: (name: string) => string | null;
  /** Goes to a saved view: glides the camera and sets its layers. */
  onGo: (view: SavedView) => void;
  onRename: (id: string, name: string) => string | null;
  onDelete: (id: string) => void;
}

/** The "Views" control beside Show: save the camera with its Show layers under a name, and come
 * back to it in one click. Yours, in this browser. */
export function SavedViewsMenu(props: SavedViewsMenuProps) {
  return (
    <Popover
      renderTrigger={({ open, triggerProps, triggerRef }) => (
        <button
          type="button"
          className={open ? 'shell-lens shell-lens--on' : 'shell-lens'}
          data-testid="shell-views"
          ref={(el) => {
            triggerRef.current = el;
          }}
          {...triggerProps}
        >
          Views ▾
        </button>
      )}
    >
      <ViewsBody {...props} />
    </Popover>
  );
}

function ViewsBody({ views, onSave, onGo, onRename, onDelete }: SavedViewsMenuProps) {
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
                  className="views__go"
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
