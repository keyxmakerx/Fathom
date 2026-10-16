import { useContext, useEffect, useId, useRef, useState } from 'react';
import { DocsContext } from './context';
import './docs.css';

/** Round 15 (r15-qol), device photo: what the box really looks like, on its panel. The picture is
 * the newest image on the device's own docs (a doc called "Photo" first). Dropping or choosing one
 * adds it to that doc. A photo cannot be checked for passwords, so the person says it shows none. */
export function DevicePhoto({ ownerId, name }: { ownerId: string; name: string }) {
  const api = useContext(DocsContext);
  const photo = api?.photoOf(ownerId) ?? null;
  const [url, setUrl] = useState<{ fileId: string; url: string } | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();

  const fileId = photo?.fileId ?? null;
  useEffect(() => {
    if (!api || !photo) return;
    let live = true;
    void api.readImage(photo).then((r) => {
      if (!live) return;
      if ('url' in r) setUrl({ fileId: photo.fileId, url: r.url });
      else setMessage({ text: r.refused, bad: true });
    });
    return () => {
      live = false;
    };
    // Read again only when the picture itself changes, not on every edit to the design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  if (!api || (!photo && !api.canEdit)) return null;

  async function add(file: File | undefined, confirmed = false) {
    if (!api || !file || busy) return;
    setBusy(true);
    setMessage(null);
    setPending(null);
    const r = await api.addPhoto(ownerId, file, confirmed);
    setBusy(false);
    if (input.current) input.current.value = '';
    if ('confirm' in r) setPending(file);
    else setMessage('refused' in r ? { text: r.refused, bad: true } : { text: r.note, bad: false });
  }

  const shown = photo && url?.fileId === photo.fileId ? url.url : null;
  return (
    <div className="drawing-editor__field device-photo" data-testid="device-photo">
      <div className="drawing-editor__field-label">Photo</div>
      {photo ? (
        shown ? (
          <img className="device-photo__img" src={shown} alt={`Photo of ${name}`} />
        ) : (
          <div className="device-photo__drop" role="status">
            Loading the photo…
          </div>
        )
      ) : (
        <div
          className={`device-photo__drop${over ? ' device-photo__drop--over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void add(e.dataTransfer.files[0]);
          }}
        >
          Drop a photo · shown on the device panel
        </div>
      )}
      {api.canEdit ? (
        <div className="device-photo__pick">
          <button type="button" className="docs-link" disabled={busy} aria-describedby={hintId} onClick={() => input.current?.click()}>
            {photo ? 'Replace the photo' : 'Choose a photo'}
          </button>
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            aria-label="Choose a photo"
            onChange={(e) => void add(e.target.files?.[0])}
          />
          <p className="docs-note" id={hintId}>
            {photo ? 'Not checked for passwords. Older photos stay in the Photo doc.' : "Handy when you're standing in front of the rack."}
          </p>
        </div>
      ) : null}
      {pending ? (
        <div role="group" aria-label={`Add ${pending.name}?`} className="device-photo__confirm">
          <p className="docs-note">Fathom can't check a photo for passwords. A sticker with a Wi-Fi key or an admin password counts.</p>
          <button type="button" onClick={() => void add(pending, true)}>
            Add it, it shows no passwords
          </button>
          <button type="button" className="docs-link" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {busy ? (
        <p className="docs-note" role="status">
          Uploading…
        </p>
      ) : null}
      {message ? (
        <p className={message.bad ? 'docs-problem' : 'docs-note'} role={message.bad ? 'alert' : 'status'}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
