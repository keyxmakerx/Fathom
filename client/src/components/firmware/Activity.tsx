// The firmware activity list for Stewards (sign-off r62): uploads, links asked for (and any warnings
// passed), downloads with the address each went to, model changes and retirements, read from the
// organisation's sealed history. Shown on an image's page and under an upgrade plan. In a plan, a
// download from an address that is none of the plan's devices' management addresses is flagged: the
// server records the address it saw, and only the design knows which address each device has.

import { useEffect, useState } from 'react';

import type { FirmwareActivity } from '../../api/firmware';
import type { FirmwareApi } from './context';
import './firmware.css';

const WARNING_WORDS: Readonly<Record<string, string>> = {
  wrong_model: 'wrong model',
  downgrade: 'downgrade',
  not_chosen: 'not the chosen version',
};

const when = (unix: number): string =>
  new Date(unix * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** One line, in words. `expected` is the management addresses a download should come from, when known. */
export function activityWords(a: FirmwareActivity, expected: ReadonlySet<string> | null): { text: string; flag: string | null } {
  const by = a.byName ? ` by ${a.byName}` : '';
  switch (a.type) {
    case 'firmware_staged':
      return { text: `Uploaded${a.version ? ` (${a.version})` : ''}${by}`, flag: null };
    case 'firmware_fetch_issued': {
      const passed = a.warningsPassed.map((w) => WARNING_WORDS[w] ?? w);
      return { text: `One-time link asked for${by}`, flag: passed.length > 0 ? `went past: ${passed.join(', ')}` : null };
    }
    case 'firmware_fetch_redeemed': {
      const from = a.source ?? 'an address the server did not record';
      const off = expected !== null && expected.size > 0 && a.source !== null && !expected.has(a.source);
      return { text: `Downloaded from ${from}${a.byName ? `, link from ${a.byName}` : ''}`, flag: off ? "not the management address of any device in this plan" : null };
    }
    case 'firmware_models_changed':
      return { text: `Models changed to ${a.modelsAfter.length > 0 ? a.modelsAfter.join(', ') : 'none'}${by}`, flag: null };
    case 'firmware_retired':
      return { text: `Retired, file deleted${by}`, flag: null };
    default:
      return { text: a.type, flag: null };
  }
}

export function FirmwareActivityList({ api, imageIds, expected = null, title = 'Activity' }: { api: FirmwareApi; imageIds: readonly string[]; expected?: ReadonlySet<string> | null; title?: string }) {
  const [items, setItems] = useState<FirmwareActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = imageIds.join(',');
  useEffect(() => {
    let live = true;
    void api.loadActivity().then((got) => {
      if (!live) return;
      if ('refused' in got) setError(got.refused);
      else setItems(got);
    });
    return () => {
      live = false;
    };
    // `api` changes on every edit to the design; the history only needs reading once per image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!api.isSteward) return null;
  const mine = items?.filter((a) => imageIds.includes(a.imageId)) ?? [];
  return (
    <div className="fw-activity" data-testid="fw-activity">
      <div className="fw-label">{title}</div>
      {error ? (
        <p className="fw-error" role="alert">
          {error}
        </p>
      ) : items === null ? (
        <p className="fw-muted">Reading the history…</p>
      ) : mine.length === 0 ? (
        <p className="fw-muted">Nothing yet.</p>
      ) : (
        <ul className="fw-activity__list">
          {mine.map((a) => {
            const w = activityWords(a, expected);
            return (
              <li key={a.seq}>
                <span className="fw-muted">{when(a.atUnix)}</span> {w.text}
                {w.flag ? <span className="fw-amber"> · {w.flag}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
