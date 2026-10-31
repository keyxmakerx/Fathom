// One row of the Firmware list opened: what Fathom holds for the image, the models it is for, and
// the one thing a person does with it, choose it for a model. A version typed with no image shows
// the same page without the file facts.

import { useMemo, useState } from 'react';

import { shortHash, sizeWords } from '../../api/firmware';
import { modelRows } from '../../document/firmware';
import type { FirmwareApi } from './context';
import { BADGE_WORD, imageRows, platformWords } from './images';
import { HowItGetsThere } from './ByHand';
import { ModelsEditor } from './ModelsEditor';
import { CopyButton, GetLink } from './parts';
import { FirmwareActivityList } from './Activity';
import './firmware.css';

/** A day as a person reads it, such as "31 Oct 2026". */
const dayWords = (unix: number): string => new Date(unix * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

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
              {img.sha256 ? <CopyButton text={img.sha256} label="Copy" className="fw-btn btn-quiet" /> : null}
              <div className="fw-muted">Fathom worked this out from the bytes it holds. Short form {shortHash(img.sha256)}.</div>
            </dd>
            {img.sha512 ? (
              <>
                <dt>SHA-512</dt>
                <dd>
                  <span className="fw-mono fw-hash-long" title={img.sha512}>
                    {img.sha512}
                  </span>{' '}
                  <CopyButton text={img.sha512} label="Copy" className="fw-btn btn-quiet" />
                  <div className="fw-muted">For vendors that publish a SHA-512, such as Cisco.</div>
                </dd>
              </>
            ) : null}
            {img.md5 ? (
              <>
                <dt>MD5</dt>
                <dd>
                  <span className="fw-mono" title={img.md5}>
                    {img.md5}
                  </span>{' '}
                  <CopyButton text={img.md5} label="Copy" className="fw-btn btn-quiet" />
                  <div className="fw-muted" data-testid="fw-md5-caveat">
                    Only for a vendor page that gives nothing better. MD5 is broken: a match rules out a damaged download, not a file someone swapped on purpose. Fathom checks the SHA-256.
                  </div>
                </dd>
              </>
            ) : null}
            {img.changedAtUnix !== null ? (
              <>
                <dt>Checked</dt>
                <dd>
                  <p className="fw-error" role="alert">
                    On {dayWords(img.changedAtUnix)} the file on the server no longer matched these hashes, or was gone. Fathom won't send it. Upload it again from the vendor's copy, and ask your admin to compare the firmware folder with a backup.
                  </p>
                </dd>
              </>
            ) : img.lastCheckedAtUnix !== null ? (
              <>
                <dt>Checked</dt>
                <dd className="fw-muted">Still matches, last checked {dayWords(img.lastCheckedAtUnix)}. Fathom checks every stored image once a week, and again before each download.</dd>
              </>
            ) : null}
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
            <span className="fw-muted">{api.canEdit ? 'None yet. Choose it for a model below.' : 'None yet.'}</span>
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
          {img && api.isSteward ? <ModelsEditor api={api} imageId={img.imageId} current={img.models} known={options} /> : null}
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
          <HowItGetsThere byHand={img.commands?.byHand}>
            <div className="fw-label">One-time link</div>
            <GetLink api={api} imageId={img.imageId} />
          </HowItGetsThere>
        </div>
      ) : null}
      {img && img.state === 'failed' ? <p className="fw-error">This upload failed: {img.failedReason ?? 'unknown reason'}. Nothing was staged.</p> : null}
      {img && api.isSteward ? <FirmwareActivityList api={api} imageIds={[img.imageId]} /> : null}
      {img && img.state === 'staged' && api.isSteward ? <RetireImage api={api} imageId={img.imageId} /> : null}
    </div>
  );
}

/** Retire: ask once, in words, then delete the file and keep the record (sign-off r62). */
function RetireImage({ api, imageId }: { api: FirmwareApi; imageId: string }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retire = async () => {
    setBusy(true);
    setError(null);
    const done = await api.retireImage(imageId);
    setBusy(false);
    if ('refused' in done) setError(done.refused);
    else setAsking(false);
  };
  return (
    <div className="fw-retire">
      {asking ? (
        <>
          <p className="fw-note">Delete this image's file from the server? It leaves this list, and its record and who fetched it stay in the organisation's history. Devices can't download it after this, and links already given stop working.</p>
          <button type="button" className="fw-btn" disabled={busy} onClick={() => void retire()}>
            {busy ? 'Retiring…' : 'Retire image'}
          </button>{' '}
          <button type="button" className="fw-btn btn-quiet" disabled={busy} onClick={() => setAsking(false)}>
            Keep it
          </button>
        </>
      ) : (
        <button type="button" className="fw-btn btn-quiet" onClick={() => setAsking(true)}>
          Retire image…
        </button>
      )}
      {error ? (
        <p className="fw-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
