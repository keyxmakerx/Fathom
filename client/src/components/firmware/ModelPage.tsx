// A model's chosen version (mockup r14-b2). One choice per model; every device of the model is
// compared against it, and a device can be held back with a reason. A reader sees it all.

import { useMemo, useState } from 'react';

import type { FirmwareImage } from '../../api/firmware';
import { listTargets, modelRows, type FwDeviceLine, type FwState, type FwTarget } from '../../document/firmware';
import { listPlans, touchedBy } from '../../document/plans';
import type { FirmwareApi } from './context';
import { modelsOfImage, platformWords } from './images';
import { HoldForm, StateMark } from './parts';
import './firmware.css';

const TYPE_ANOTHER = '__type';
const NONE = '';

/** The words the model page uses for a device's state, and what it says beside it. */
export function statusWords(state: FwState, hold: string | null): { word: string; note: string } {
  switch (state) {
    case 'current':
      return { word: 'On chosen', note: hold ?? '' };
    case 'behind':
      return { word: 'Behind', note: '' };
    case 'held':
      return { word: 'Held', note: hold ?? '' };
    case 'not-recorded':
      return { word: 'No version yet', note: hold ?? 'paste a config to read it' };
    case 'unclear':
      return { word: 'Cannot compare', note: hold ?? 'Fathom cannot put these two version numbers in order' };
    default:
      return { word: 'No chosen version', note: hold ?? '' };
  }
}

interface Choice {
  value: string;
  label: string;
  image: FirmwareImage | null;
  version: string;
}

/** The versions the select offers: images that list the model, then the typed one if it is not among them. */
export function versionChoices(
  model: string,
  images: readonly FirmwareImage[],
  targets: readonly FwTarget[],
  current: { version: string; image: string } | null,
): Choice[] {
  const out: Choice[] = images
    .filter((i) => i.state === 'staged' && i.version !== null && modelsOfImage(i, targets).includes(model))
    .map((i) => ({ value: `img:${i.imageId}`, label: i.version!, image: i, version: i.version! }));
  if (current && !out.some((o) => o.version === current.version && (current.image === '' || o.image?.imageId === current.image))) {
    out.push({ value: `typed:${current.version}`, label: current.version, image: null, version: current.version });
  }
  return out;
}

function Chooser({ api, model }: { api: FirmwareApi; model: string }) {
  const target = useMemo(() => listTargets(api.doc).find((t) => t.model === model) ?? null, [api.doc, model]);
  const choices = useMemo(() => versionChoices(model, api.server.images, listTargets(api.doc), target ? { version: target.version, image: target.image } : null), [model, api.server.images, api.doc, target]);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const current = target === null ? NONE : (choices.find((c) => (target.image !== '' ? c.image?.imageId === target.image : c.image === null && c.version === target.version) || c.version === target.version)?.value ?? NONE);

  const pick = (value: string) => {
    setError(null);
    if (value === TYPE_ANOTHER) {
      setTyping(true);
      return;
    }
    setTyping(false);
    if (value === NONE) {
      api.clearTarget(model);
      return;
    }
    const c = choices.find((x) => x.value === value);
    if (!c) return;
    const r = api.setTarget(model, c.image ? { version: c.version, image: c.image.imageId, imageSha256: c.image.sha256, platform: c.image.platform } : { version: c.version });
    if (r) setError(r.refused);
  };

  return (
    <div className="fw-chosen">
      <label className="fw-label" htmlFor="fw-chosen">
        Chosen version
      </label>
      {api.canEdit ? (
        <select id="fw-chosen" className="fw-input fw-input--mono" value={typing ? TYPE_ANOTHER : current} onChange={(e) => pick(e.currentTarget.value)}>
          <option value={NONE}>No version chosen</option>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
              {c.image ? '' : ' (typed)'}
            </option>
          ))}
          <option value={TYPE_ANOTHER}>Type a version…</option>
        </select>
      ) : (
        <span className="fw-mono">{target?.version ?? 'none chosen'}</span>
      )}
      {typing && api.canEdit ? (
        <form
          className="fw-chosen"
          onSubmit={(e) => {
            e.preventDefault();
            const r = api.setTarget(model, { version: typed, image: null, imageSha256: null });
            if (r) setError(r.refused);
            else {
              setTyping(false);
              setTyped('');
            }
          }}
        >
          <input className="fw-input fw-input--mono" value={typed} placeholder="as the vendor writes it" aria-label="Version" autoFocus onChange={(e) => setTyped(e.currentTarget.value)} />
          <button type="submit" className="fw-btn">
            Set
          </button>
        </form>
      ) : null}
      {error ? (
        <span className="fw-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function DeviceRow({ api, line, onOpenDevice }: { api: FirmwareApi; line: FwDeviceLine; onOpenDevice: (chassisId: string) => void }) {
  const { device, state } = line;
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { word, note } = statusWords(state, device.hold);
  return (
    <div className="fw-row" role="row" data-testid="firmware-device">
      <span role="cell">
        {device.chassisIds[0] ? (
          <button type="button" className="fw-link" onClick={() => onOpenDevice(device.chassisIds[0]!)}>
            {device.hostname || 'unnamed'}
          </button>
        ) : (
          device.hostname || 'unnamed'
        )}
      </span>
      <span role="cell" className={device.osVersion ? 'fw-mono' : 'fw-muted'}>
        {device.osVersion || 'unknown'}
      </span>
      <span role="cell">
        <StateMark state={state} word={word} />
      </span>
      {holding ? (
        <HoldForm
          onHold={(reason) => {
            const r = api.setHold(device.deviceId, reason);
            if (r) return r.refused;
            setHolding(false);
          }}
          onCancel={() => setHolding(false)}
        />
      ) : (
        <>
          <span role="cell" className={device.hold === null ? 'fw-muted' : undefined}>
            {error ?? note}
          </span>
          <span role="cell" className="fw-act">
            {api.canEdit ? (
              device.hold !== null ? (
                <button
                  type="button"
                  className="fw-btn fw-btn--quiet"
                  onClick={() => {
                    const r = api.setHold(device.deviceId, null);
                    setError(r ? r.refused : null);
                  }}
                >
                  Release
                </button>
              ) : (
                <button type="button" className="fw-btn fw-btn--quiet" onClick={() => setHolding(true)}>
                  Hold
                </button>
              )
            ) : null}
          </span>
        </>
      )}
    </div>
  );
}

export function ModelPage({ api, model, onOpenDevice }: { api: FirmwareApi; model: string; onOpenDevice: (chassisId: string) => void }) {
  const row = useMemo(() => modelRows(api.doc).find((r) => r.model === model) ?? null, [api.doc, model]);
  const plans = useMemo(() => {
    const mine = new Set((row?.devices ?? []).map((l) => l.device.deviceId));
    return listPlans(api.doc).filter((p) => touchedBy(p).some((id) => mine.has(id)));
  }, [api.doc, row]);
  if (row === null) return <p className="fw-empty">No device and no chosen version for {model}.</p>;
  const platform = row.target?.platform || row.devices[0]?.device.platform || '';
  const n = row.devices.length;
  const sub = [platformWords(platform), `${n} ${n === 1 ? 'device' : 'devices'}`].filter(Boolean).join(' · ');
  const behind = row.devices.filter((l) => l.state === 'behind').map((l) => l.device.deviceId);

  return (
    <div className="fw-page fw-page--narrow" data-testid="firmware-model">
      <h2 className="fw-title">
        {model} <span className="fw-title__sub">{sub}</span>
      </h2>
      <Chooser api={api} model={model} />
      <p className="fw-muted">Pick the version once per model. Every device of that model is compared against it. Hold a device back with a reason and Checks stops flagging it.</p>
      <div className="fw-table fw-device-table" role="table" aria-label={`Devices of ${model}`}>
        <div className="fw-row fw-row--head" role="row">
          <span role="columnheader">Device</span>
          <span role="columnheader">Running</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Note</span>
          <span role="columnheader" />
        </div>
        {row.devices.map((l) => (
          <DeviceRow key={l.device.deviceId} api={api} line={l} onOpenDevice={onOpenDevice} />
        ))}
      </div>
      {n === 0 ? <p className="fw-empty">No device of this model is in the design yet.</p> : null}
      {plans.length > 0 ? (
        <div>
          <div className="fw-label">Plans touching these devices</div>
          <ul className="fw-plan__devices">
            {plans.map((p) => (
              <li key={p.id}>
                <button type="button" className="fw-link" onClick={() => api.openPlan(p.id)}>
                  {p.title}
                </button>
                <span className="fw-muted">{p.stage}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="fw-foot">
        <span>{behind.length === 0 ? 'No device is behind.' : `${behind.length} ${behind.length === 1 ? 'device is' : 'devices are'} behind the chosen version`}</span>
        {behind.length > 0 && api.canEdit ? (
          <button type="button" className="fw-btn" onClick={() => api.planUpgrade(behind)}>
            Plan an upgrade for them
          </button>
        ) : null}
      </div>
    </div>
  );
}
