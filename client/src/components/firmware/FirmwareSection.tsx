// A device's firmware row group, in the editor on the canvas and on the Inventory page: what it
// runs (typed here, or read from a paste), the chosen version (its model's, or for a device with no
// model target, its own, schema 0.31), where that leaves it, a hold with its reason, a plan, and a
// one-time link for a steward.

import { useContext, useState } from 'react';

import { canSetVersionPlatform, chosenFor, deviceFirmware, stateOf } from '../../document/firmware';
import { FIRMWARE_PLATFORMS, VERSION_PLATFORMS } from '../../document/firmwareVersion';
import { listPlans } from '../../document/plans';
import { Fold } from '../drawing/Fold';
import { FirmwareContext } from './context';
import { KITS, KIT_CHOICES, kitFor, type KitId } from './kits';
import { statusWords } from './ModelPage';
import { GetLink, HoldForm, StateMark, VersionEdit } from './parts';
import './firmware.css';

/** The device panel's head (r31 pictures): what it runs and where that leaves it, as one chip. Nothing for a device
 * with no catalogue model and no version of its own. */
export function FirmwareChip({ deviceId }: { deviceId: string }) {
  const api = useContext(FirmwareContext);
  if (!api) return null;
  const device = deviceFirmware(api.doc, deviceId);
  if (!device) return null;
  const chosen = chosenFor(api.doc, device);
  if (device.models.length === 0 && chosen === null) return null;
  const state = stateOf(device, chosen);
  const { word } = statusWords(state, device.hold);
  const tone = state === 'current' ? 'ok' : state === 'behind' ? 'warn' : '';
  return (
    <span className={`dev-tag${tone ? ` dev-tag--${tone}` : ''}`} data-testid="firmware-chip">
      {tone ? <span className="dev-tag__dot" aria-hidden="true" /> : null}
      Firmware {device.osVersion ? `${device.osVersion} · ` : ''}{word}
    </span>
  );
}

/** `folded`: the canvas panel shows it as one line (r30-device), what it runs and where that leaves it. */
export function FirmwareSection({ deviceId, folded = false }: { deviceId: string; folded?: boolean }) {
  const api = useContext(FirmwareContext);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kit, setKit] = useState<KitId | null>(null);
  const [into, setInto] = useState(false);
  if (!api) return null;
  const device = deviceFirmware(api.doc, deviceId);
  if (!device) return null;
  const chosen = chosenFor(api.doc, device);
  const target = chosen?.target ?? null;
  const state = stateOf(device, chosen);
  const { word } = statusWords(state, device.hold);
  const image = target ? (api.server.images.find((i) => i.imageId === target.image && i.state === 'staged') ?? null) : null;
  const model = target?.model ?? device.models[0] ?? null;
  // Written steps stand in for an image Fathom does not have.
  const steps: KitId = kit ?? kitFor(device.platform || target?.platform || '');
  // A model on an image platform keeps the image plan ("stage the image first") instead.
  const showSteps = chosen !== null && image === null && (target === null || !FIRMWARE_PLATFORMS.some((p) => p.id === (device.platform || target.platform)));
  const open = listPlans(api.doc).filter((p) => p.stage === 'planned');
  const how = showSteps ? { kit: steps } : {};
  const said = (r: { refused: string } | void): string | void => (r ? r.refused : undefined);

  const body = (
    <div className="drawing-editor__field fw-section" data-testid="firmware-section">
      {folded ? null : <div className="drawing-editor__group">Firmware</div>}
      <div className="fw-section__row">
        <span className="drawing-editor__field-label">Running</span>
        <VersionEdit value={device.osVersion} empty="not recorded" label="Running version" canEdit={api.canEdit} testId="fw-running" onSave={(v) => said(api.setRunning(deviceId, v))} />
      </div>
      {canSetVersionPlatform(device) && api.canEdit ? (
        <div className="fw-section__row">
          <span className="drawing-editor__field-label">Numbering</span>
          <select
            className="fw-input"
            aria-label="How its versions are numbered"
            value={device.platform}
            onChange={(e) => {
              const r = api.setVersionPlatform(deviceId, e.currentTarget.value === '' ? null : e.currentTarget.value);
              setError(r ? r.refused : null);
            }}
          >
            <option value="">Not set: Fathom cannot compare</option>
            {VERSION_PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {model !== null ? (
        <div className="fw-section__row">
          <span className="drawing-editor__field-label">Chosen for {model}</span>
          {target ? (
            <span className="fw-mono">{target.version}</span>
          ) : (
            <button type="button" className="fw-link" onClick={() => api.openModel(model)}>
              none chosen yet
            </button>
          )}
        </div>
      ) : null}
      {target === null ? (
        <div className="fw-section__row">
          <span className="drawing-editor__field-label">{model !== null ? 'Or for this device' : 'Chosen for this device'}</span>
          <VersionEdit value={device.ownTarget} empty="none chosen yet" label="Version chosen for this device" canEdit={api.canEdit} testId="fw-own-target" onSave={(v) => said(api.setDeviceTarget(deviceId, v))} />
        </div>
      ) : null}
      <div className="fw-section__row">
        <span className="drawing-editor__field-label">State</span>
        <StateMark state={state} word={word} />
      </div>
      <div className="fw-section__row">
        <span className="drawing-editor__field-label">Hold</span>
        {device.hold !== null ? (
          <span>
            {device.hold}{' '}
            {api.canEdit ? (
              <button
                type="button"
                className="fw-btn btn-quiet"
                onClick={() => {
                  const r = api.setHold(deviceId, null);
                  setError(r ? r.refused : null);
                }}
              >
                Release
              </button>
            ) : null}
          </span>
        ) : api.canEdit && !holding ? (
          <button type="button" className="fw-btn btn-quiet" onClick={() => setHolding(true)}>
            Hold
          </button>
        ) : (
          <span className="fw-muted">{holding ? '' : 'not held'}</span>
        )}
      </div>
      {holding ? (
        <HoldForm
          onHold={(reason) => {
            const r = api.setHold(deviceId, reason);
            if (r) return r.refused;
            setHolding(false);
          }}
          onCancel={() => setHolding(false)}
        />
      ) : null}
      {error ? (
        <p className="fw-error" role="alert">
          {error}
        </p>
      ) : null}
      {showSteps && api.canEdit ? (
        <div className="fw-section__row">
          <span className="drawing-editor__field-label">Steps for</span>
          <select className="fw-input" aria-label="Written steps for" value={steps} onChange={(e) => setKit(e.currentTarget.value as KitId)}>
            {KIT_CHOICES.map((k) => (
              <option key={k} value={k}>
                {KITS[k].label}
                {KITS[k].checked ? '' : ' (not checked against the vendor)'}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="fw-section__actions">
        {api.canEdit ? (
          <button type="button" className="fw-btn" disabled={chosen === null && model === null} onClick={() => api.planUpgrade([deviceId], how)}>
            {chosen ? 'Plan a firmware upgrade' : 'Choose a version first'}
          </button>
        ) : null}
        {api.canEdit && chosen !== null && open.length > 0 ? (
          <span style={{ position: 'relative' }}>
            <button type="button" className="fw-btn btn-quiet" aria-expanded={into} onClick={() => setInto(!into)}>
              Add to an existing plan…
            </button>
            {into ? (
              <ul className="fw-pop" role="menu" data-testid="fw-into-plan">
                {open.map((p) => (
                  <li key={p.id} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="fw-link"
                      onClick={() => {
                        setInto(false);
                        api.planUpgrade([deviceId], { ...how, intoPlan: p.id });
                      }}
                    >
                      {p.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </span>
        ) : null}
        {model !== null ? (
          <button type="button" className="fw-btn btn-quiet" onClick={() => api.openModel(model)}>
            Firmware page
          </button>
        ) : null}
      </div>
      {image && api.isSteward ? <GetLink api={api} imageId={image.imageId} /> : null}
    </div>
  );
  if (!folded) return body;
  return (
    <Fold title="Firmware" summary={`${device.osVersion || 'not recorded'} · ${word}`} testId="firmware-fold">
      {body}
    </Fold>
  );
}
