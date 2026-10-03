import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import {
  MAX_BODY,
  MAX_FILES,
  MAX_LINKS,
  MAX_TITLE,
  safeUrl,
  type DocFileView,
  type DocTarget,
  type DocView,
} from '../../document/docs';
import { DocsContext, type DocsApi, type DocsView } from './context';
import { Markdown } from './markdown';
import './docs.css';

const TYPED_SENTENCE = 'Stored as typed. Fathom does not redact what you type, only what you paste.';

function when(ms: number): string {
  return ms > 0
    ? new Date(ms).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      })
    : '';
}

function about(api: DocsApi, d: DocView): string {
  if (d.model) return `Model ${d.model}`;
  if (d.ownerId) return d.ownerGone ? 'A removed item' : api.label(d.ownerId);
  return 'The design';
}

/** The docs list and one doc's page, over the design. Esc or Close goes back to the drawing. */
export function DocsOverlay({
  view,
  onView,
  onClose,
}: {
  view: DocsView;
  onView: (v: DocsView) => void;
  onClose: () => void;
}) {
  const api = useContext(DocsContext);
  const ref = useRef<HTMLDivElement>(null);
  // Set by the add and edit forms while they hold text that is not saved.
  const dirty = useRef(new Set<string>());
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const guard = (go: () => void) => () => {
    if (dirty.current.size > 0 && !window.confirm('Discard what you typed?')) return;
    dirty.current.clear();
    go();
  };
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    // On the document, not the dialog: a disabled field drops focus to the page, and Esc must still close.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.stopPropagation();
      guard(() => closeRef.current())();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      back?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only; onClose is a plain closer
  }, []);
  if (!api) return null;
  return (
    <DirtyContext.Provider value={dirty}>
      <div className="docs-overlay" role="dialog" aria-modal="true" aria-label="Docs" tabIndex={-1} ref={ref}>
        <div className="docs-overlay__head">
          {view.kind !== 'list' && view.from === 'list' ? (
            <button type="button" className="docs-link" onClick={guard(() => onView({ kind: 'list' }))}>
              ← All docs
            </button>
          ) : (
            <span>Docs</span>
          )}
          <button type="button" className="docs-overlay__close" aria-label="Close docs" onClick={guard(onClose)}>
            ×
          </button>
        </div>
        {view.kind === 'list' ? <DocsList api={api} onView={onView} /> : null}
        {view.kind === 'doc' ? (
          <DocPage key={view.id} api={api} id={view.id} onView={onView} onClose={onClose} from={view.from} />
        ) : null}
        {view.kind === 'new' ? <NewDoc api={api} view={view} onView={onView} onClose={onClose} /> : null}
      </div>
    </DirtyContext.Provider>
  );
}

const DirtyContext = createContext<{ current: Set<string> }>({ current: new Set() });

/** Tells the overlay this form holds unsaved text. */
function useDirty(isDirty: boolean) {
  const dirty = useContext(DirtyContext);
  const id = useId();
  useEffect(() => {
    if (isDirty) dirty.current.add(id);
    else dirty.current.delete(id);
    return () => {
      dirty.current.delete(id);
    };
  }, [dirty, id, isDirty]);
}

function DocsList({ api, onView }: { api: DocsApi; onView: (v: DocsView) => void }) {
  const rows = api.all().sort((a, b) => b.when - a.when);
  return (
    <div className="docs-overlay__body">
      <table className="docs-table">
        <thead>
          <tr>
            <th>Doc</th>
            <th>About</th>
            <th>Edited</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>
                <button
                  type="button"
                  className="docs-link"
                  onClick={() => onView({ kind: 'doc', id: d.id, from: 'list' })}
                >
                  {d.title}
                </button>
              </td>
              <td>{about(api, d)}</td>
              <td className="docs-table__when">{when(d.when)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="docs-note">No docs yet.</p> : null}
      <p className="docs-note">Docs about one thing also show in that thing's panel under Docs.</p>
      {api.canEdit ? (
        <button type="button" className="docs-link" onClick={() => onView({ kind: 'new', from: 'list' })}>
          + Add doc
        </button>
      ) : null}
    </div>
  );
}

/** A textarea or input that remembers a paste happened in it. */
function usePaste() {
  const [pasted, setPasted] = useState(false);
  return {
    pasted,
    onPaste: () => setPasted(true),
    reset: () => setPasted(false),
  };
}

function NewDoc({
  api,
  view,
  onView,
  onClose,
}: {
  api: DocsApi;
  view: Extract<DocsView, { kind: 'new' }>;
  onView: (v: DocsView) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [aboutKind, setAboutKind] = useState<'thing' | 'model' | 'design'>(view.ownerId ? 'thing' : 'design');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const paste = usePaste();
  useDirty(title.trim() !== '' || body !== '');
  const titlePaste = usePaste();

  async function save() {
    if (busy) return;
    const target: DocTarget =
      aboutKind === 'thing' && view.ownerId
        ? { kind: 'thing', id: view.ownerId }
        : aboutKind === 'model' && view.model
          ? { kind: 'model', model: view.model }
          : { kind: 'design' };
    setBusy(true);
    const r = await api.create(target, {
      title,
      body,
      pasted: paste.pasted || titlePaste.pasted,
    });
    setBusy(false);
    if ('refused' in r) setRefusal(r.refused);
    else onView({ kind: 'doc', id: r.id, from: view.from });
  }

  return (
    <div className="docs-overlay__body">
      <h1 className="docs-title">New doc</h1>
      {view.ownerId || view.model ? (
        <fieldset className="docs-about">
          <legend>About</legend>
          {view.ownerId ? (
            <label>
              <input
                type="radio"
                name="docs-about"
                checked={aboutKind === 'thing'}
                onChange={() => setAboutKind('thing')}
              />{' '}
              {api.label(view.ownerId)}
            </label>
          ) : null}
          {view.model ? (
            <label>
              <input
                type="radio"
                name="docs-about"
                checked={aboutKind === 'model'}
                onChange={() => setAboutKind('model')}
              />{' '}
              Every {view.model}
            </label>
          ) : null}
          <label>
            <input
              type="radio"
              name="docs-about"
              checked={aboutKind === 'design'}
              onChange={() => setAboutKind('design')}
            />{' '}
            The design
          </label>
        </fieldset>
      ) : null}
      <label className="docs-field">
        <span>Title</span>
        <input
          value={title}
          maxLength={MAX_TITLE}
          onChange={(e) => setTitle(e.target.value)}
          onPaste={titlePaste.onPaste}
          onDrop={titlePaste.onPaste}
          disabled={busy}
        />
      </label>
      <label className="docs-field">
        <span>Text (Markdown)</span>
        <textarea
          value={body}
          rows={12}
          maxLength={MAX_BODY}
          onChange={(e) => setBody(e.target.value)}
          onPaste={paste.onPaste}
          onDrop={paste.onPaste}
          disabled={busy}
        />
      </label>
      <p className="docs-note">{TYPED_SENTENCE}</p>
      {refusal != null ? <p className="docs-problem">{refusal}</p> : null}
      <div className="docs-actions">
        <button type="button" disabled={busy || title.trim() === ''} onClick={() => void save()}>
          Save doc
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => (view.from === 'list' ? onView({ kind: 'list' }) : onClose())}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function DocPage({
  api,
  id,
  onView,
  onClose,
  from,
}: {
  api: DocsApi;
  id: string;
  onView: (v: DocsView) => void;
  onClose: () => void;
  from?: 'list';
}) {
  const d = api.get(id);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const paste = usePaste();
  useDirty(editing && (title !== (d?.title ?? '') || body !== (d?.body ?? '')));
  const titlePaste = usePaste();
  if (!d) {
    return (
      <div className="docs-overlay__body">
        <p className="docs-note">This doc is gone.</p>
      </div>
    );
  }

  const start = () => {
    setTitle(d.title);
    setBody(d.body);
    setRefusal(null);
    setEditing(true);
  };
  async function save() {
    if (busy) return;
    setBusy(true);
    const r = await api.update(id, {
      title,
      body,
      pasted: paste.pasted || titlePaste.pasted,
    });
    setBusy(false);
    if (r?.refused) {
      setRefusal(r.refused);
      return;
    }
    paste.reset();
    titlePaste.reset();
    setEditing(false);
  }
  function remove() {
    const r = api.remove(id);
    if (r?.refused) setRefusal(r.refused);
    else if (from === 'list') onView({ kind: 'list' });
    else onClose();
  }

  const meta = [
    'Doc',
    d.model
      ? `on the model ${d.model}`
      : d.ownerId
        ? `on ${d.ownerGone ? 'a removed item' : api.label(d.ownerId)}`
        : 'about the design',
    `edited ${when(d.when)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="docs-overlay__body">
      <div className="docs-page__head">
        {editing ? (
          <label className="docs-field docs-field--grow">
            <span>Title</span>
            <input
              value={title}
              maxLength={MAX_TITLE}
              onChange={(e) => setTitle(e.target.value)}
              onPaste={titlePaste.onPaste}
              onDrop={titlePaste.onPaste}
              disabled={busy}
            />
          </label>
        ) : (
          <h1 className="docs-title">{d.title}</h1>
        )}
        {api.canEdit && !editing ? (
          <button type="button" onClick={start}>
            Edit
          </button>
        ) : null}
      </div>
      <p className="docs-meta">{meta}</p>
      {editing ? (
        <>
          <label className="docs-field">
            <span>Text (Markdown)</span>
            <textarea
              value={body}
              rows={14}
              maxLength={MAX_BODY}
              onChange={(e) => setBody(e.target.value)}
              onPaste={paste.onPaste}
              onDrop={paste.onPaste}
              disabled={busy}
            />
          </label>
          <p className="docs-note">{TYPED_SENTENCE}</p>
          {refusal != null ? <p className="docs-problem">{refusal}</p> : null}
          <div className="docs-actions">
            <button type="button" disabled={busy || title.trim() === ''} onClick={() => void save()}>
              Save
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
            {confirmRemove ? (
              <button type="button" className="docs-danger" onClick={remove}>
                Really remove this doc?
              </button>
            ) : (
              <button type="button" onClick={() => setConfirmRemove(true)}>
                Remove doc
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <Markdown source={d.body} />
          {d.how === 'typed' ? null : <p className="docs-note">Pasted text. Passwords were removed at the gate.</p>}
        </>
      )}
      <LinksBlock api={api} d={d} />
      <FilesBlock api={api} d={d} />
    </div>
  );
}

function LinksBlock({ api, d }: { api: DocsApi; d: DocView }) {
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paste = usePaste();
  useDirty(title.trim() !== '' || url.trim() !== '');

  async function add() {
    if (busy) return;
    setBusy(true);
    const r = await api.addLink(d.id, { title, url, pasted: paste.pasted });
    setBusy(false);
    if (r?.refused) {
      setRefusal(r.refused);
      return;
    }
    setRefusal(null);
    setTitle('');
    setUrl('');
    paste.reset();
  }

  return (
    <section className="docs-links" aria-label="Links">
      <h2>Links</h2>
      {d.links.length === 0 ? <p className="docs-note">None.</p> : null}
      <ul>
        {d.links.map((l) => {
          const safe = safeUrl(l.url);
          return (
            <li key={l.id}>
              {safe ? (
                <a href={safe.href} target="_blank" rel="noopener noreferrer">
                  {l.title}
                </a>
              ) : (
                <span>{l.title}</span>
              )}
              <span className="docs-links__host"> {safe ? safe.host : 'not a web address'}</span>
              {api.canEdit ? (
                <button
                  type="button"
                  className="docs-link"
                  onClick={() => api.removeLink(l.id)}
                  aria-label={`Remove link ${l.title}`}
                >
                  {' '}
                  remove
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {api.canEdit && d.links.length < MAX_LINKS ? (
        <div className="docs-links__add">
          <input
            aria-label="Link title"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onPaste={paste.onPaste}
            onDrop={paste.onPaste}
            disabled={busy}
          />
          <input
            aria-label="Link address"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPaste={paste.onPaste}
            onDrop={paste.onPaste}
            disabled={busy}
          />
          <button type="button" disabled={busy || url.trim() === ''} onClick={() => void add()}>
            + Add link
          </button>
          {refusal != null ? <p className="docs-problem">{refusal}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function checkedWords(f: DocFileView): string {
  if (f.checked === 'clean') return 'No passwords found';
  if (f.checked === 'removed') return `${f.removed} password${f.removed === 1 ? '' : 's'} removed`;
  return f.media === 'image' ? 'Not checked · image' : f.media === 'pdf' ? 'Not checked · PDF' : 'Not checked';
}

function FilesBlock({ api, d }: { api: DocsApi; d: DocView }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());

  async function pick(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setMessage(null);
    const r = await api.addFile(d.id, file);
    setBusy(false);
    if (input.current) input.current.value = '';
    setMessage('refused' in r ? { text: r.refused, bad: true } : { text: r.note, bad: false });
  }
  async function get(f: DocFileView) {
    setMessage(null);
    const r = await api.download(f);
    if (r?.refused) setMessage({ text: r.refused, bad: true });
  }

  async function erase(f: DocFileView) {
    const r = await api.deleteFileForGood(f);
    setConfirming(null);
    if (r?.refused) {
      setMessage({ text: r.refused, bad: true });
      return;
    }
    setGone((g) => new Set(g).add(f.fileId));
    setMessage({ text: `${f.name} was deleted for good. Its name, size and hash stay in the history.`, bad: false });
  }
  const deleteControl = (f: DocFileView) =>
    !api.canEdit || gone.has(f.fileId) ? (
      gone.has(f.fileId) ? (
        <span className="docs-note"> Deleted for good</span>
      ) : null
    ) : confirming === f.id ? (
      <span role="group" aria-label={`Delete ${f.name} for good?`}>
        {' '}
        <button type="button" className="docs-link" onClick={() => void erase(f)}>
          Really delete {f.name} for good
        </button>{' '}
        <button type="button" className="docs-link" onClick={() => setConfirming(null)}>
          Keep
        </button>
      </span>
    ) : (
      <button
        type="button"
        className="docs-link"
        onClick={() => setConfirming(f.id)}
        aria-label={`Delete ${f.name} for good`}
      >
        {' '}
        delete for good
      </button>
    );

  return (
    <section className="docs-links docs-files" aria-label="Files">
      <h2>Files</h2>
      {d.files.length === 0 ? <p className="docs-note">None.</p> : null}
      {d.files.length > 0 ? (
        <table className="docs-files__table">
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              <th>Checked</th>
              <th>
                <span className="docs-sr">Download</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {d.files.map((f) => (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td>{size(f.size)}</td>
                <td>{checkedWords(f)}</td>
                <td>
                  <button
                    type="button"
                    className="docs-link"
                    onClick={() => void get(f)}
                    aria-label={`Download ${f.name}`}
                  >
                    Download
                  </button>
                  {api.canEdit ? (
                    <button
                      type="button"
                      className="docs-link"
                      onClick={() => {
                        const r = api.removeFile(f.id);
                        if (r?.refused) setMessage({ text: r.refused, bad: true });
                      }}
                      aria-label={`Remove file ${f.name}`}
                    >
                      {' '}
                      remove
                    </button>
                  ) : null}
                  {deleteControl(f)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {api.canEdit && d.files.length < MAX_FILES ? (
        <div className="docs-links__add">
          <input
            ref={input}
            type="file"
            aria-label="Add a file"
            aria-describedby={hintId}
            disabled={busy}
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          <p className="docs-note" id={hintId}>
            PDF, image or text, up to 25 MB. Text is checked for passwords before upload. Images and PDFs are not
            checked yet. Files open as downloads, never inside Fathom.
          </p>
        </div>
      ) : null}
      {d.removedFiles.length > 0 ? (
        <div className="docs-files__removed">
          <h3>Removed files</h3>
          <ul>
            {d.removedFiles.map((f) => (
              <li key={f.id}>
                {f.name} <span className="docs-links__host">{size(f.size)}</span>
                {deleteControl(f)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {busy ? (
        <p className="docs-note" role="status">
          Checking and uploading…
        </p>
      ) : null}
      {message != null ? (
        <p className={message.bad ? 'docs-problem' : 'docs-note'} role={message.bad ? 'alert' : 'status'}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
