// The firmware api for one open design: what the server holds, and every change a person makes.
// Targets and holds are document edits (`document/firmware.ts`) written through `applyDocChange`, as
// tags and plans are, so undo, history and live co-editing see them. Images go to the server.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  FirmwareOff,
  declareImage,
  firmwareRefusalWords,
  issueFetchLink,
  listFirmware,
  modelsProblem,
  setImageModels,
  sendImageBytes,
} from '../../api/firmware';
import {
  FirmwareRefusal,
  chosenFor,
  clearTarget,
  deviceFirmware,
  setDeviceTarget,
  setFirmwareHold,
  setRunningVersion,
  setTarget,
  setVersionPlatform,
} from '../../document/firmware';
import type { Document } from '../../document/model';
import { checkUpload } from './uploadCheck';
import { buildUpgradePlan, labelled, type UpgradeTemplate } from './upgradePlan';
import type { FirmwareApi, FirmwareServer, Refused } from './context';

export interface FirmwareInputs {
  organisationId: string;
  scopeId: string;
  doc: Document | null;
  /** Draw or steward. */
  canDraw: boolean;
  isSteward: boolean;
  applyDocChange: (next: Document) => void;
  actor?: string;
  /** Hands a plan to the place that makes it (the canvas holds the plans). */
  requestUpgrade: (template: UpgradeTemplate) => void;
  openModel: (model: string) => void;
  openPlan: (planId: string) => void;
}

const refusal = (e: unknown): Refused => ({ refused: e instanceof FirmwareRefusal ? e.message : e instanceof Error ? e.message : 'That was refused.' });

export function useFirmwareApi(inputs: FirmwareInputs): FirmwareApi | null {
  const { organisationId, scopeId, doc, canDraw, isSteward, applyDocChange, actor, requestUpgrade, openModel, openPlan } = inputs;
  const [server, setServer] = useState<FirmwareServer>({ status: 'loading', images: [], error: null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    listFirmware(organisationId, scopeId).then(
      (images) => live && setServer({ status: 'ready', images, error: null }),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof FirmwareOff) setServer({ status: 'off', images: [], error: null });
        else setServer((s) => ({ status: 'error', images: s.images, error: firmwareRefusalWords(e, 'list') }));
      },
    );
    return () => {
      live = false;
    };
  }, [organisationId, scopeId, tick]);

  const latest = useRef({ doc, server, actor, requestUpgrade, openModel, openPlan, applyDocChange });
  latest.current = { doc, server, actor, requestUpgrade, openModel, openPlan, applyDocChange };

  const edit = useCallback((make: (d: Document, o: { actor?: string }) => Document): Refused | void => {
    const now = latest.current;
    if (now.doc === null) return { refused: 'No design is open.' };
    try {
      const next = make(now.doc, now.actor ? { actor: now.actor } : {});
      if (next !== now.doc) now.applyDocChange(next);
    } catch (e) {
      return refusal(e);
    }
  }, []);

  return useMemo<FirmwareApi | null>(() => {
    if (doc === null) return null;
    return {
      doc,
      canEdit: canDraw,
      isSteward,
      server,
      reload,
      setTarget: (model, patch) => edit((d, o) => setTarget(d, model, patch, o)),
      clearTarget: (model) => void edit((d, o) => clearTarget(d, model, o)),
      setHold: (deviceId, reason) => edit((d, o) => setFirmwareHold(d, deviceId, reason, o)),
      setDeviceTarget: (deviceId, version) => edit((d, o) => setDeviceTarget(d, deviceId, version, o)),
      setRunning: (deviceId, version) => edit((d, o) => setRunningVersion(d, deviceId, version, o)),
      setVersionPlatform: (deviceId, platform) => edit((d, o) => setVersionPlatform(d, deviceId, platform, o)),
      upload: async (form, onProgress, signal) => {
        const checked = checkUpload({ filename: form.file.name, size: form.file.size, platform: form.platform, version: form.version, sha256: form.sha256 });
        if ('problem' in checked) return { refused: checked.problem };
        const modelsWrong = modelsProblem(form.models);
        if (modelsWrong !== null) return { refused: modelsWrong };
        try {
          const declared = await declareImage(organisationId, scopeId, {
            filename: checked.ok.filename,
            byteLength: checked.ok.byteLength,
            sha256: checked.ok.sha256,
            platform: checked.ok.platform,
            version: checked.ok.version,
            models: form.models,
          });
          await sendImageBytes(declared, form.file, onProgress, signal);
          reload();
          return { imageId: declared.imageId };
        } catch (e) {
          reload();
          return { refused: firmwareRefusalWords(e) };
        }
      },
      setImageModels: async (imageId, models) => {
        const problem = modelsProblem(models);
        if (problem !== null) return { refused: problem };
        try {
          const done = await setImageModels(organisationId, imageId, models);
          reload();
          return { changed: done.changed };
        } catch (e) {
          return { refused: firmwareRefusalWords(e) };
        }
      },
      issueLink: async (imageId) => {
        try {
          return await issueFetchLink(organisationId, imageId);
        } catch (e) {
          return { refused: firmwareRefusalWords(e, 'link') };
        }
      },
      planUpgrade: (deviceIds, how = {}) => {
        const now = latest.current;
        if (now.doc === null) return;
        const devices = deviceIds.flatMap((id) => deviceFirmware(now.doc!, id) ?? []);
        const first = devices[0];
        if (first === undefined) return;
        const chosen = chosenFor(now.doc, first);
        if (chosen === null) {
          if (first.models[0] !== undefined) now.openModel(first.models[0]);
          return;
        }
        const target = chosen.target;
        const image = target ? (now.server.images.find((i) => i.imageId === target.image) ?? null) : null;
        // A model's version takes that model's devices; a device's own version takes the devices
        // asked for that have the same one and no model target.
        const mine = target
          ? devices.filter((d) => d.models.includes(target.model))
          : devices.filter((d) => d.ownTarget === chosen.version && chosenFor(now.doc!, d)?.target === null);
        const label = target ? target.model : first.hostname || 'this device';
        let template = buildUpgradePlan({ devices: mine, label, version: chosen.version, target, image, ...(how.kit ? { kit: how.kit } : {}) });
        if (how.intoPlan) template = { ...labelled(template, `${label} to ${chosen.version}`), intoPlan: how.intoPlan };
        now.requestUpgrade(template);
      },
      openModel: (model) => latest.current.openModel(model),
      openPlan: (id) => latest.current.openPlan(id),
    };
  }, [doc, canDraw, isSteward, server, reload, edit, organisationId, scopeId]);
}
