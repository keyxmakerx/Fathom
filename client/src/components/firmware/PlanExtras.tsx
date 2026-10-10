// What a firmware upgrade plan adds to the plan panel (mockup r14-b3): the devices with
// "running to target", and the one-time link for the image. The panel is a narrow dock, so these sit
// under the steps rather than beside them. The link is held here, in memory, for the life of the open
// plan: it is never written to the design, it works once, and it ends in 15 minutes.

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import type { FetchLink } from '../../api/firmware';
import { deviceFirmware, targetOfDevice } from '../../document/firmware';
import { touchedBy, type Plan, type PlanStep } from '../../document/plans';
import { FirmwareContext } from './context';
import { CommandNotes, CopyButton, copyText } from './parts';
import { LINK_PLACEHOLDER, commandWithLink, maskedLink, parseUpgradeTitle } from './upgradePlan';
import './firmware.css';

interface LinkState {
  imageId: string | null;
  link: FetchLink | null;
  busy: boolean;
  error: string | null;
  issue(): Promise<FetchLink | null>;
}

const LinkScope = createContext<LinkState | null>(null);

/** Gives a firmware upgrade plan's panel one link to share between its steps and its link box. */
export function UpgradeLinkScope({ plan, children }: { plan: Plan; children: ReactNode }) {
  const api = useContext(FirmwareContext);
  const [link, setLink] = useState<FetchLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upgrade = parseUpgradeTitle(plan.title);
  const imageId = useMemo(() => {
    if (!api || !upgrade) return null;
    const first = touchedBy(plan).flatMap((id) => deviceFirmware(api.doc, id) ?? [])[0];
    const target = first ? targetOfDevice(api.doc, first) : null;
    return target && target.image !== '' ? target.image : null;
  }, [api, upgrade, plan]);
  if (!api || !upgrade) return <>{children}</>;
  const state: LinkState = {
    imageId,
    link,
    busy,
    error,
    issue: async () => {
      if (imageId === null) {
        setError("This model's chosen version has no image in Fathom. Upload one, then choose it.");
        return null;
      }
      setBusy(true);
      setError(null);
      const got = await api.issueLink(imageId);
      setBusy(false);
      if ('refused' in got) {
        setError(got.refused);
        return null;
      }
      setLink(got);
      return got;
    },
  };
  return <LinkScope.Provider value={state}>{children}</LinkScope.Provider>;
}

/** Copy command on a step that has commands. The fetch step's copy has the real link in it. */
export function StepCopy({ step }: { step: PlanStep }) {
  const scope = useContext(LinkScope);
  const [said, setSaid] = useState<string | null>(null);
  if (!scope || step.after === '') return null;
  const needsLink = step.after.includes(LINK_PLACEHOLDER);
  return (
    <p className="plans-step__actions">
      <button
        type="button"
        className="plans-btn"
        disabled={scope.busy}
        onClick={async () => {
          let text = step.after;
          if (needsLink) {
            const link = scope.link ?? (await scope.issue());
            if (link === null) return;
            text = commandWithLink(step.after, link.url);
          }
          setSaid((await copyText(text)) ? 'Copied' : 'Select and copy it by hand');
          window.setTimeout(() => setSaid(null), 2500);
        }}
      >
        {said ?? 'Copy command'}
      </button>
      {needsLink ? <span className="plans-note"> Gets a one-time link, which works once.</span> : null}
    </p>
  );
}

export function FirmwarePlanExtras({ plan }: { plan: Plan }) {
  const api = useContext(FirmwareContext);
  const scope = useContext(LinkScope);
  const upgrade = parseUpgradeTitle(plan.title);
  if (!api || !upgrade || !scope) return null;
  const devices = touchedBy(plan).flatMap((id) => deviceFirmware(api.doc, id) ?? []);
  const first = devices[0];
  return (
    <div data-testid="plans-firmware">
      <h3 className="plans-label">
        Devices · {devices.length}
      </h3>
      <ul className="fw-plan__devices">
        {devices.map((d) => (
          <li key={d.deviceId}>
            <span>{d.hostname || 'unnamed'}</span>
            <span className="fw-mono fw-muted">
              {d.osVersion || 'unknown'} → {upgrade.version}
            </span>
          </li>
        ))}
      </ul>
      {api.isSteward ? (
        <>
          <h3 className="plans-label">One-time link{first ? ` for ${first.hostname || 'the device'}${devices.length > 1 ? ' and the others' : ''}` : ''}</h3>
          {scope.link ? (
            <div className="fw-link-box">
              <div className="fw-link-box__url">{maskedLink(scope.link.url)}</div>
              <div className="fw-link-box__row">
                <CopyButton text={scope.link.url} label="Copy link" className="plans-btn" />
                <button type="button" className="plans-btn" disabled={scope.busy} onClick={() => void scope.issue()}>
                  Get another
                </button>
              </div>
              <p className="plans-note">Works once, then expires: 15 minutes. Fathom never logs in to the device.</p>
              <p className="plans-note">
                Expected SHA-256 <span className="plans-mono">{scope.link.sha256}</span>
              </p>
            </div>
          ) : (
            <p>
              <button type="button" className="plans-btn" disabled={scope.busy || scope.imageId === null} onClick={() => void scope.issue()}>
                {scope.busy ? 'Getting…' : 'Get a one-time link'}
              </button>
              <span className="plans-note"> {scope.imageId === null ? "No image in Fathom for this model's chosen version." : 'Works once, then expires. Fathom never logs in to the device.'}</span>
            </p>
          )}
          {scope.error ? (
            <p className="plans-note" role="alert">
              {scope.error}
            </p>
          ) : null}
          <CommandNotes commands={api.server.images.find((i) => i.imageId === scope.imageId)?.commands} />
        </>
      ) : (
        <p className="plans-note">A steward gets the one-time link on the day.</p>
      )}
    </div>
  );
}
