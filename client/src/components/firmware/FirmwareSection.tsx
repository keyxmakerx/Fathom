// A device's firmware row group, in the editor on the canvas and on the Inventory page: what it
// runs, the model's chosen version, where that leaves it, a hold with its reason, a plan, and a
// one-time link for a steward. Shows nothing for a device with no catalogue model.

import { useContext, useState } from 'react';

import { deviceFirmware, stateOf, targetOfDevice } from '../../document/firmware';
import { FirmwareContext } from './context';
import { statusWords } from './ModelPage';
import { GetLink, HoldForm, StateMark } from './parts';
import './firmware.css';

export function FirmwareSection({ deviceId }: { deviceId: string }) {
  const api = useContext(FirmwareContext);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!api) return null;
  const device = deviceFirmware(api.doc, deviceId);
  if (!device || device.models.length === 0) return null;
  const target = targetOfDevice(api.doc, device);
  const state = stateOf(device, target);
  const { word } = statusWords(state, device.hold);
  const image = target ? (api.server.images.find((i) => i.imageId === target.image && i.state === 'staged') ?? null) : null;
  const model = target?.model ?? device.models[0]!;

  return (
    <div className="drawing-editor__field fw-section" data-testid="firmware-section">
      <div className="drawing-editor__group">Firmware</div>
      <div className="fw-section__row">
        <span className="drawing-editor__field-label">Running</span>
        <span className={device.osVersion ? 'fw-mono' : 'fw-muted'}>{device.osVersion || 'not recorded'}</span>
      </div>
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
                className="fw-btn fw-btn--quiet"
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
          <button type="button" className="fw-btn fw-btn--quiet" onClick={() => setHolding(true)}>
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
      <div className="fw-section__actions">
        {api.canEdit ? (
          <button type="button" className="fw-btn" onClick={() => api.planUpgrade([deviceId])}>
            {target ? 'Plan a firmware upgrade' : 'Choose a version first'}
          </button>
        ) : null}
        <button type="button" className="fw-btn fw-btn--quiet" onClick={() => api.openModel(model)}>
          Firmware page
        </button>
      </div>
      {image && api.isSteward ? <GetLink api={api} imageId={image.imageId} /> : null}
    </div>
  );
}
