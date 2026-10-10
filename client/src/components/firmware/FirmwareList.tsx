// Inventory > Firmware (mockup r14-b1): one row per image. Running, Behind and Plans each open the
// list behind the number. A reader sees all of it and changes nothing.

import { useMemo, useState } from 'react';

import { shortHash } from '../../api/firmware';
import { listPlans } from '../../document/plans';
import type { FirmwareApi } from './context';
import { BADGE_WORD, VENDOR_TABS, behindByModel, behindQuery, filterImageRows, imageRows, runningQuery, type FwImageRow, type Vendor } from './images';
import './firmware.css';

export const FIRMWARE_OFF_WORDS = 'Firmware is off on this server. Set FATHOM_FIRMWARE_FETCH_BASE_URL in .env to the address your switches can reach, then run docker compose up -d.';

export interface FirmwareListProps {
  api: FirmwareApi;
  onOpenImage: (rowKey: string) => void;
  onOpenModel: (model: string) => void;
  onOpenDevices: (query: string) => void;
  onUpload: () => void;
}

function PlansCell({ api, row }: { api: FirmwareApi; row: FwImageRow }) {
  const [open, setOpen] = useState(false);
  if (row.plans === 0) return <span className="fw-cell--num">0</span>;
  const titles = new Map(listPlans(api.doc).map((p) => [p.id, p.title]));
  return (
    <span>
      <button type="button" className="fw-link fw-link--num" aria-expanded={open} aria-label={`${row.plans} plans for ${row.version}`} onClick={() => setOpen(!open)}>
        {row.plans}
      </button>
      {open ? (
        <ul className="fw-pop" role="menu">
          {row.planIds.map((id) => (
            <li key={id} role="none">
              <button type="button" role="menuitem" className="fw-link" onClick={() => api.openPlan(id)}>
                {titles.get(id) ?? 'A plan'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}

function Count({ n, onOpen, label }: { n: number; onOpen: () => void; label: string }) {
  if (n === 0) return <span className="fw-cell--num">0</span>;
  return (
    <button type="button" className="fw-link fw-link--num" aria-label={label} onClick={onOpen}>
      {n}
    </button>
  );
}

export function FirmwareList({ api, onOpenImage, onOpenModel, onOpenDevices, onUpload }: FirmwareListProps) {
  const [text, setText] = useState('');
  const [vendor, setVendor] = useState<Vendor | 'all'>('all');
  const [pickModel, setPickModel] = useState(false);
  const all = useMemo(() => imageRows({ doc: api.doc, images: api.server.images }), [api.doc, api.server.images]);
  const rows = useMemo(() => filterImageRows(all, text, vendor), [all, text, vendor]);
  const behind = useMemo(() => behindByModel(api.doc), [api.doc]);
  const behindTotal = behind.reduce((n, b) => n + b.deviceIds.length, 0);
  const { status } = api.server;

  return (
    <div className="fw-page" data-testid="firmware-list">
      {status === 'off' ? (
        <p className="fw-note" role="status">
          {FIRMWARE_OFF_WORDS} Versions typed on a model's page still work.
        </p>
      ) : null}
      {status === 'error' ? (
        <p className="fw-error" role="alert">
          {api.server.error}{' '}
          <button type="button" className="fw-link" onClick={api.reload}>
            Try again
          </button>
        </p>
      ) : null}
      <div className="fw-toolbar">
        <input className="fw-input fw-toolbar__filter" type="search" placeholder="Filter images" aria-label="Filter images" value={text} onChange={(e) => setText(e.currentTarget.value)} />
        <div className="fw-tabs" role="group" aria-label="Vendor">
          {VENDOR_TABS.map((t) => (
            <button key={t.key} type="button" className="fw-tab" aria-pressed={vendor === t.key} onClick={() => setVendor(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="fw-toolbar__grow" />
        {api.canEdit && status !== 'off' ? (
          <button type="button" className="fw-btn" onClick={onUpload}>
            + Upload image
          </button>
        ) : null}
      </div>

      <div className="fw-table" role="table" aria-label="Firmware images">
        <div className="fw-row fw-row--head" role="row">
          <span role="columnheader">Version</span>
          <span role="columnheader">Models</span>
          <span role="columnheader">SHA-256</span>
          <span role="columnheader">Running</span>
          <span role="columnheader">Behind</span>
          <span role="columnheader">Plans</span>
          <span role="columnheader" />
        </div>
        {rows.map((r) => (
          <div key={r.key} className="fw-row" role="row" data-testid="firmware-row">
            <span role="cell">
              <button type="button" className="fw-link fw-mono" onClick={() => onOpenImage(r.key)}>
                {r.version || r.filename || 'no version'}
              </button>
            </span>
            <span role="cell" className="fw-models">
              {r.models.length === 0 ? (
                <span className="fw-muted">no models yet</span>
              ) : (
                r.models.map((m, i) => (
                  <span key={m}>
                    <button type="button" className="fw-link" onClick={() => onOpenModel(m)}>
                      {m}
                    </button>
                    {i < r.models.length - 1 ? ',' : ''}
                  </span>
                ))
              )}
            </span>
            <span role="cell" className="fw-mono fw-muted" title={r.sha256 || undefined}>
              {r.sha256 ? shortHash(r.sha256) : ''}
            </span>
            <span role="cell">
              <Count n={r.running} label={`${r.running} devices running ${r.version}`} onOpen={() => onOpenDevices(runningQuery(r))} />
            </span>
            <span role="cell">
              {r.behind === null ? (
                <span className="fw-dash" aria-label="not the chosen version">
                  —
                </span>
              ) : r.behind === 0 ? (
                <span className="fw-muted">0</span>
              ) : (
                <span className="fw-amber">
                  <Count n={r.behind} label={`${r.behind} devices behind`} onOpen={() => onOpenDevices(behindQuery(r))} />
                </span>
              )}
            </span>
            <span role="cell">
              <PlansCell api={api} row={r} />
            </span>
            <span role="cell" className={`fw-badge fw-badge--${r.badge}`}>
              {BADGE_WORD[r.badge]}
            </span>
          </div>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="fw-empty">
          {all.length === 0
            ? status === 'loading'
              ? 'Reading what the server holds…'
              : 'No images yet. Upload one, or choose a version on a model page.'
            : 'Nothing matches.'}
        </p>
      ) : null}

      <div className="fw-foot">
        <span>{behindTotal === 0 ? 'No device is behind its model’s chosen version.' : `${behindTotal} ${behindTotal === 1 ? 'device is' : 'devices are'} behind their model’s chosen version`}</span>
        {behindTotal > 0 && api.canEdit ? (
          <span style={{ position: 'relative' }}>
            <button
              type="button"
              className="fw-btn"
              onClick={() => {
                if (behind.length === 1) api.planUpgrade(behind[0]!.deviceIds);
                else setPickModel(!pickModel);
              }}
            >
              Plan an upgrade for them
            </button>
            {pickModel ? (
              <ul className="fw-pop" role="menu">
                {behind.map((b) => (
                  <li key={b.model} role="none">
                    <button type="button" role="menuitem" className="fw-link" onClick={() => api.planUpgrade(b.deviceIds)}>
                      {b.model} · {b.deviceIds.length}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}
