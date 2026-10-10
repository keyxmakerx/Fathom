// "Edit models" on an image page: replaces the whole list of catalogue models the image is for
// (PUT .../firmware/{image}/models, steward). Checks the same rule the server does before sending.

import { useState } from 'react';

import { modelsProblem } from '../../api/firmware';
import type { FirmwareApi } from './context';
import './firmware.css';

export const splitModels = (text: string): string[] => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

export function ModelsEditor({ api, imageId, current, known }: { api: FirmwareApi; imageId: string; current: readonly string[]; known: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(current));
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = [...new Set([...known, ...current])];

  if (!open) {
    return (
      <button
        type="button"
        className="fw-btn fw-btn--quiet"
        onClick={() => {
          setPicked(new Set(current));
          setExtra('');
          setError(null);
          setOpen(true);
        }}
      >
        Edit models
      </button>
    );
  }

  const save = async () => {
    const models = [...new Set([...options.filter((m) => picked.has(m)), ...splitModels(extra)])];
    const problem = modelsProblem(models);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    const done = await api.setImageModels(imageId, models);
    setBusy(false);
    if ('refused' in done) setError(done.refused);
    else setOpen(false);
  };

  return (
    <form
      className="fw-models-edit"
      data-testid="firmware-models-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="fw-checks">
        {options.map((m) => (
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
      <input className="fw-input" value={extra} disabled={busy} placeholder="Other models, separated by commas" aria-label="Other models" onChange={(e) => setExtra(e.currentTarget.value)} />
      <div className="fw-toolbar">
        <button type="submit" className="fw-btn" disabled={busy}>
          {busy ? 'Saving…' : 'Save models'}
        </button>
        <button type="button" className="fw-btn fw-btn--quiet" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error ? (
        <p className="fw-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
