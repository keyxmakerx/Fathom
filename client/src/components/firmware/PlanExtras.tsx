// What a firmware upgrade plan adds to the plan panel (mockup r14-b3): the devices with
// "running to target", and the one-time link for the image. The panel is a narrow dock, so these sit
// under the steps rather than beside them. The link is held here, in memory, for the life of the open
// plan: it is never written to the design, it works once, and it ends in 15 minutes.

import { createContext, useContext, useState, type ReactNode } from 'react';

import type { FetchLink } from '../../api/firmware';
import { chosenFor, deviceFirmware } from '../../document/firmware';
import type { Document } from '../../document/model';
import type { Plan, PlanStep } from '../../document/plans';
import { CommandToType, TypeItYourselfNote } from '../typing/CommandToType';
import { useTypeItYourself } from '../typing/typeItYourself';
import { FirmwareContext } from './context';
import { HowItGetsThere } from './ByHand';
import { linkWarnings, warningCodes, type LinkWarning } from './linkWarnings';
import { CommandNotes, CopyButton, LinkWarnings, copyText } from './parts';
import { FETCH_STEP_TITLE, LINK_PLACEHOLDER, commandWithLink, maskedLink, stepTitle, upgradeGroups, type UpgradeGroup } from './upgradePlan';
import './firmware.css';

interface LinkState {
  groups: UpgradeGroup[];
  /** The image each fetch step's devices are chosen for, by step id; null when Fathom has none. */
  imageOf(stepId: string): string | null;
  /** What looks wrong about sending that image to that step's devices (`linkWarnings`). */
  warningsOf(stepId: string): LinkWarning[];
  links: Readonly<Record<string, FetchLink>>;
  busy: boolean;
  error: string | null;
  /**
   * A link for this image. When `warnings` are not yet passed for it, shows them instead and
   * gives null; "Get the link anyway" then gets one with their codes, which the server records.
   */
  issue(imageId: string | null, warnings?: readonly LinkWarning[]): Promise<FetchLink | null>;
  /** The warnings waiting for an answer, and for which image. */
  pending: { imageId: string; warnings: readonly LinkWarning[] } | null;
  anyway(): Promise<void>;
  back(): void;
}

const LinkScope = createContext<LinkState | null>(null);

/** The image a group's devices are chosen for: the first that has a model target naming one. */
function imageOfGroup(doc: Document, g: UpgradeGroup): string | null {
  for (const id of g.deviceIds) {
    const d = deviceFirmware(doc, id);
    const t = d ? chosenFor(doc, d)?.target : null;
    if (t && t.image !== '') return t.image;
  }
  return null;
}

/**
 * Gives a firmware upgrade plan's panel its links, one image per fetch step, so a plan that holds
 * two models' upgrades gets each model's image. A plan is a firmware plan by its steps, not its name.
 */
export function UpgradeLinkScope({ plan, children }: { plan: Plan; children: ReactNode }) {
  const api = useContext(FirmwareContext);
  const [links, setLinks] = useState<Record<string, FetchLink>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<LinkState['pending']>(null);
  const [passed, setPassed] = useState<Readonly<Record<string, readonly string[]>>>({});
  const groups = upgradeGroups(plan);
  if (!api || groups.length === 0) return <>{children}</>;
  const byStep = new Map(groups.flatMap((g) => (g.fetchStep ? [[g.fetchStep.id, imageOfGroup(api.doc, g)] as const] : [])));
  const get = async (imageId: string, codes: readonly string[]): Promise<FetchLink | null> => {
    setBusy(true);
    setError(null);
    const got = await api.issueLink(imageId, codes);
    setBusy(false);
    if ('refused' in got) {
      setError(got.refused);
      return null;
    }
    setLinks((l) => ({ ...l, [imageId]: got }));
    return got;
  };
  const state: LinkState = {
    groups,
    imageOf: (stepId) => byStep.get(stepId) ?? null,
    warningsOf: (stepId) => {
      const imageId = byStep.get(stepId);
      const image = imageId ? api.server.images.find((i) => i.imageId === imageId) : undefined;
      const group = groups.find((g) => g.fetchStep?.id === stepId);
      if (!image || !group) return [];
      return linkWarnings(api.doc, image, group.deviceIds.flatMap((id) => deviceFirmware(api.doc, id) ?? []));
    },
    links,
    busy,
    error,
    pending,
    issue: async (imageId, warnings = []) => {
      if (imageId === null) {
        setError("This model's chosen version has no image in Fathom. Upload one, then choose it.");
        return null;
      }
      const codes = warningCodes(warnings);
      const seen = passed[imageId] ?? [];
      if (codes.some((c) => !seen.includes(c))) {
        setPending({ imageId, warnings });
        return null;
      }
      return get(imageId, codes);
    },
    anyway: async () => {
      if (pending === null) return;
      const codes = warningCodes(pending.warnings);
      setPassed((p) => ({ ...p, [pending.imageId]: codes }));
      setPending(null);
      await get(pending.imageId, codes);
    },
    back: () => setPending(null),
  };
  return <LinkScope.Provider value={state}>{children}</LinkScope.Provider>;
}

/**
 * Copy command on a step that has commands. The fetch step's copy has the real link in it, and the
 * fetch step also offers the same job by hand from Windows or Linux.
 */
export function StepCopy({ step }: { step: PlanStep }) {
  const api = useContext(FirmwareContext);
  const scope = useContext(LinkScope);
  if (!scope) return null;
  const imageId = scope.imageOf(step.id);
  const copy = step.after === '' ? null : <CommandCopy step={step} scope={scope} imageId={imageId} />;
  if (stepTitle(step.change) !== FETCH_STEP_TITLE) return copy;
  const byHand = api?.server.images.find((i) => i.imageId === imageId)?.commands?.byHand;
  return <HowItGetsThere byHand={byHand}>{copy}</HowItGetsThere>;
}

function CommandCopy({ step, scope, imageId }: { step: PlanStep; scope: LinkState; imageId: string | null }) {
  const [said, setSaid] = useState<string | null>(null);
  const typing = useTypeItYourself();
  const needsLink = step.after.includes(LINK_PLACEHOLDER);
  if (typing) {
    // Shown to be typed. The link part stays a placeholder: the link has its own Copy link below.
    return (
      <div className="plans-step__actions" data-testid="plans-step-typed">
        <TypeItYourselfNote />
        <CommandToType command={step.after} />
        {needsLink ? <span className="plans-note">Get the one-time link below, copy it, and put it where the link part is.</span> : null}
      </div>
    );
  }
  return (
    <p className="plans-step__actions">
      <button
        type="button"
        className="plans-btn"
        disabled={scope.busy}
        onClick={async () => {
          let text = step.after;
          if (needsLink) {
            // A fresh link on every copy: each works once, and a plan can cover several devices.
            const link = await scope.issue(imageId, scope.warningsOf(step.id));
            if (link === null) return;
            text = commandWithLink(step.after, link.url);
          }
          setSaid((await copyText(text)) ? 'Copied' : 'Select and copy it by hand');
          window.setTimeout(() => setSaid(null), 2500);
        }}
      >
        {said ?? 'Copy command'}
      </button>
      {needsLink ? <span className="plans-note"> Each copy gets a new one-time link: copy once per device.</span> : null}
    </p>
  );
}

export function FirmwarePlanExtras({ plan }: { plan: Plan }) {
  const api = useContext(FirmwareContext);
  const scope = useContext(LinkScope);
  if (!api || !scope) return null;
  const lines = scope.groups.flatMap((g) => g.deviceIds.flatMap((id) => deviceFirmware(api.doc, id) ?? []).map((d) => ({ d, version: g.version })));
  const fetches = scope.groups.filter((g) => g.fetchStep !== null);
  return (
    <div data-testid="plans-firmware">
      <h3 className="plans-label">Devices · {lines.length}</h3>
      <ul className="fw-plan__devices">
        {lines.map(({ d, version }) => (
          <li key={`${d.deviceId}:${version}`}>
            <span>{d.hostname || 'unnamed'}</span>
            <span className="fw-mono fw-muted">
              {d.osVersion || 'unknown'} → {version}
            </span>
          </li>
        ))}
      </ul>
      {fetches.length === 0 ? null : api.isSteward ? (
        fetches.map((g) => <GroupLink key={g.fetchStep!.id} group={g} scope={scope} plan={plan} />)
      ) : (
        <p className="plans-note">A steward gets the one-time link on the day.</p>
      )}
      {scope.pending ? <LinkWarnings warnings={scope.pending.warnings} busy={scope.busy} onAnyway={() => void scope.anyway()} onBack={scope.back} /> : null}
      {scope.error ? (
        <p className="plans-note" role="alert">
          {scope.error}
        </p>
      ) : null}
    </div>
  );
}

function GroupLink({ group, scope, plan }: { group: UpgradeGroup; scope: LinkState; plan: Plan }) {
  const api = useContext(FirmwareContext)!;
  const imageId = scope.imageOf(group.fetchStep!.id);
  const link = imageId ? scope.links[imageId] : undefined;
  const devices = group.deviceIds.flatMap((id) => deviceFirmware(api.doc, id) ?? []);
  const first = devices[0];
  const many = upgradeGroups(plan).filter((g) => g.fetchStep !== null).length > 1;
  const whose = devices.length === 1 && first ? ` for ${first.hostname || 'the device'}` : many ? ` for ${group.version}` : '';
  return (
    <>
      <h3 className="plans-label">One-time link{whose}</h3>
      {link ? (
        <div className="fw-link-box">
          <div className="fw-link-box__url">{maskedLink(link.url)}</div>
          <div className="fw-link-box__row">
            <CopyButton text={link.url} label="Copy link" className="plans-btn" />
            <button type="button" className="plans-btn" disabled={scope.busy} onClick={() => void scope.issue(imageId, scope.warningsOf(group.fetchStep!.id))}>
              Get another
            </button>
          </div>
          <p className="plans-note">
            Works once, then expires: 15 minutes.{devices.length > 1 ? ' Get another for each device.' : ''} Fathom never logs in to the device.
          </p>
          <p className="plans-note">
            Expected SHA-256 <span className="plans-mono fw-hash">{link.sha256}</span>
          </p>
        </div>
      ) : (
        <p>
          <button type="button" className="plans-btn" disabled={scope.busy || imageId === null} onClick={() => void scope.issue(imageId, scope.warningsOf(group.fetchStep!.id))}>
            {scope.busy ? 'Getting…' : 'Get a one-time link'}
          </button>
          <span className="plans-note"> {imageId === null ? "No image in Fathom for this model's chosen version." : 'Works once, then expires. Fathom never logs in to the device.'}</span>
        </p>
      )}
      <CommandNotes commands={api.server.images.find((i) => i.imageId === imageId)?.commands} />
    </>
  );
}
