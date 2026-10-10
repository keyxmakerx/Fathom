// One row of the Firmware list opened: what Fathom holds for the image, the models it is for, and
// the one thing a person does with it, choose it for a model. A version typed with no image shows
// the same page without the file facts.

import { useMemo, useState } from 'react';

import { shortHash, sizeWords } from '../../api/firmware';
import { modelRows } from '../../document/firmware';
import type { FirmwareApi } from './context';
import { BADGE_WORD, imageRows, platformWords } from './images';
import { CopyButton, GetLink } from './parts';
import './firmware.css';

export function ImagePage({ api, rowKey, onOpenModel }: { api: FirmwareApi; rowKey: string; onOpenModel: (model: string) => void }) {
  const row = useMemo(() => imageRows({ doc: api.doc, images: api.server.images }).find((r) => r.key === rowKey) ?? null, [api.doc, api.server.images, rowKey]);
  const options = useMemo(() => modelRows(api.doc).map((r) => r.model), [api.doc]);
  const [model, setModel] = useState('');
  const [version, setVersion] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (row === null) return <p className="fw-empty">That image is not listed any more.</p>;
  const img = row.image;
  const free = options.filter((m) => !row.chosenModels.includes(m));
  const needsVersion = row.version === '';

  const choose = () => {
    if (model === '') {
      setError('Pick a model.');
      return;
    }
    const r = api.setTarget(model, {
      version: row.version || version,
      platform: row.platform || null,
      image: img ? img.imageId : null,
      imageSha256: img ? img.sha256 : null,
    });
    if (r) setError(r.refused);
    else {
      setError(null);
      setModel('');
    }
  };

  return (
    <div className="fw-page fw-page--narrow" data-testid="firmware-image">
      <h2 className="fw-title">
        <span className="fw-mono">{row.version || img?.filename || 'Image'}</span>
        <span className={`fw-badge fw-badge--${row.badge}`}>{BADGE_WORD[row.badge]}</span>
        <span className="fw-title__sub">{platformWords(row.platform)}</span>
      </h2>
      <dl className="fw-facts">
        {img ? (
          <>
            <dt>File</dt>
            <dd className="fw-mono">
              {img.filename} <span className="fw-muted">{sizeWords(img.byteLength)}</span>
            </dd>
            <dt>SHA-256</dt>
            <dd>
              <span className="fw-mono" title={img.sha256 ?? undefined}>
                {img.sha256 ?? 'not staged'}
              </span>{' '}
              {img.sha256 ? <CopyButton text={img.sha256} label="Copy" className="fw-btn fw-btn--quiet" /> : null}
              <div className="fw-muted">Fathom worked this out from the bytes it holds. Short form {shortHash(img.sha256)}.</div>
            </dd>
          </>
        ) : (
          <>
            <dt>Image</dt>
            <dd className="fw-muted">None. This version was typed on a model's page, so Fathom has no file to check or serve.</dd>
          </>
        )}
        <dt>Models</dt>
        <dd>
          {row.models.length === 0 ? (
            <span className="fw-muted">None yet. Choose it for a model below.</span>
          ) : (
            row.models.map((m) => (
              <div key={m}>
                <button type="button" className="fw-link" onClick={() => onOpenModel(m)}>
                  {m}
                </button>
                {row.chosenModels.includes(m) ? <span className="fw-muted"> · chosen</span> : null}
              </div>
            ))
          )}
        </dd>
        <dt>Running</dt>
        <dd>{row.running}</dd>
        {row.behind !== null ? (
          <>
            <dt>Behind</dt>
            <dd className={row.behind > 0 ? 'fw-amber' : undefined}>{row.behind}</dd>
          </>
        ) : null}
      </dl>

      {api.canEdit ? (
        <form
          className="fw-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            choose();
          }}
        >
          <select className="fw-input" value={model} aria-label="Model" onChange={(e) => setModel(e.currentTarget.value)}>
            <option value="">Choose this version for a model…</option>
            {free.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {needsVersion ? <input className="fw-input fw-input--mono" value={version} placeholder="Version" aria-label="Version" onChange={(e) => setVersion(e.currentTarget.value)} /> : null}
          <button type="submit" className="fw-btn">
            Choose
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="fw-error" role="alert">
          {error}
        </p>
      ) : null}

      {img && img.state === 'staged' && api.isSteward ? (
        <div>
          <div className="fw-label">One-time link</div>
          <GetLink api={api} imageId={img.imageId} />
        </div>
      ) : null}
      {img && img.state === 'failed' ? <p className="fw-error">This upload failed: {img.failedReason ?? 'unknown reason'}. Nothing was staged.</p> : null}
    </div>
  );
}
