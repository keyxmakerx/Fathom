// Upload image: pick the file, say what it is for and paste the hash the vendor publishes. Fathom
// works out the hash of what arrives and refuses the image when they differ. The browser sends the
// file as it reads it; a 1 to 2 GB image is never held in memory.

import { useMemo, useRef, useState } from 'react';

import { sizeWords } from '../../api/firmware';
import { modelRows } from '../../document/firmware';
import { FIRMWARE_PLATFORMS } from '../../document/firmwareVersion';
import type { FirmwareApi } from './context';
import { checkUpload } from './uploadCheck';
import './firmware.css';

export function UploadForm({ api, onDone, onCancel }: { api: FirmwareApi; onDone: (imageId: string) => void; onCancel: () => void }) {
  const known = useMemo(() => modelRows(api.doc).map((r) => r.model), [api.doc]);
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState('');
  const [version, setVersion] = useState('');
  const [sha, setSha] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [extra, setExtra] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ sent: number; total: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = sent !== null;

  const models = useMemo(() => [...new Set([...picked, ...extra.split(/[\s,]+/).filter(Boolean)])], [picked, extra]);

  const submit = async () => {
    if (!file || busy) return;
    const checked = checkUpload({ filename: file.name, size: file.size, platform, version, sha256: sha });
    if ('problem' in checked) {
      setError(checked.problem);
      return;
    }
    setError(null);
    setSent({ sent: 0, total: file.size });
    abort.current = new AbortController();
    const result = await api.upload({ file, platform, version, sha256: sha, models }, (s, t) => setSent({ sent: s, total: t }), abort.current.signal);
    abort.current = null;
    setSent(null);
    if ('refused' in result) setError(result.refused);
    else onDone(result.imageId);
  };

  const pct = sent && sent.total > 0 ? Math.min(100, Math.round((sent.sent / sent.total) * 100)) : 0;

  return (
    <div className="fw-page fw-page--narrow" data-testid="firmware-upload">
      <h2 className="fw-title">Upload image</h2>
      <p className="fw-muted">
        Paste the SHA-256 from the vendor's download page. Fathom works out the hash of what you send and refuses the image if the two differ, so a cut-off or swapped file never reaches a switch.
      </p>
      <form
        className="fw-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="fw-label" htmlFor="fw-file">
          File
        </label>
        <div>
          <input id="fw-file" type="file" disabled={busy} onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
          {file ? <span className="fw-muted"> {sizeWords(file.size)}</span> : null}
        </div>

        <label className="fw-label" htmlFor="fw-platform">
          Platform
        </label>
        <select id="fw-platform" className="fw-input" value={platform} disabled={busy} onChange={(e) => setPlatform(e.currentTarget.value)}>
          <option value="">Choose</option>
          {FIRMWARE_PLATFORMS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        <label className="fw-label" htmlFor="fw-version">
          Version
        </label>
        <input id="fw-version" className="fw-input fw-input--mono" value={version} disabled={busy} placeholder="as the vendor writes it, e.g. 23.4R2" onChange={(e) => setVersion(e.currentTarget.value)} />

        <label className="fw-label" htmlFor="fw-sha">
          Vendor's SHA-256
        </label>
        <input id="fw-sha" className="fw-input fw-input--mono" value={sha} disabled={busy} placeholder="64 hexadecimal characters" spellCheck={false} autoComplete="off" onChange={(e) => setSha(e.currentTarget.value)} />

        <span className="fw-label">Models</span>
        <div>
          {known.length > 0 ? (
            <div className="fw-checks">
              {known.map((m) => (
                <label key={m}>
                  <input
                    type="checkbox"
                    checked={picked.has(m)}
                    disabled={busy}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.currentTarget.checked) next.add(m);
                      else next.delete(m);
                      setPicked(next);
                    }}
                  />
                  {m}
                </label>
              ))}
            </div>
          ) : null}
          <input className="fw-input" style={{ marginTop: known.length > 0 ? 8 : 0, width: '100%' }} value={extra} disabled={busy} placeholder="Other models, separated by commas" aria-label="Other models" onChange={(e) => setExtra(e.currentTarget.value)} />
        </div>

        {busy ? (
          <div className="fw-form__full" role="status" aria-live="polite">
            <div className="fw-bar" aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </div>
            <p className="fw-muted">
              {pct >= 100 ? 'Checking it against the vendor hash…' : `Sending ${sizeWords(sent!.sent)} of ${sizeWords(sent!.total)}`}
            </p>
          </div>
        ) : null}
        {error ? (
          <p className="fw-error fw-form__full" role="alert">
            {error}
          </p>
        ) : null}
        <div className="fw-form__full fw-toolbar">
          <button type="submit" className="fw-btn fw-btn--solid" disabled={busy || file === null}>
            Upload
          </button>
          <button
            type="button"
            className="fw-btn"
            onClick={() => {
              abort.current?.abort();
              onCancel();
            }}
          >
            {busy ? 'Stop' : 'Cancel'}
          </button>
        </div>
      </form>
    </div>
  );
}
