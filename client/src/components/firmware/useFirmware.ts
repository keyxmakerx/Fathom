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
  sendImageBytes,
} from '../../api/firmware';
import { FirmwareRefusal, clearTarget, deviceFirmware, setFirmwareHold, setTarget, targetOfDevice } from '../../document/firmware';
import type { Document } from '../../document/model';
import { checkUpload } from './uploadCheck';
import { buildUpgradePlan, type UpgradeTemplate } from './upgradePlan';
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
      upload: async (form, onProgress, signal) => {
        const checked = checkUpload({ filename: form.file.name, size: form.file.size, platform: form.platform, version: form.version, sha256: form.sha256 });
        if ('problem' in checked) return { refused: checked.problem };
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
      issueLink: async (imageId) => {
        try {
          return await issueFetchLink(organisationId, imageId);
        } catch (e) {
          return { refused: firmwareRefusalWords(e, 'link') };
        }
      },
      planUpgrade: (deviceIds) => {
        const now = latest.current;
        if (now.doc === null) return;
        const devices = deviceIds.flatMap((id) => deviceFirmware(now.doc!, id) ?? []);
        const first = devices[0];
        if (first === undefined) return;
        const target = targetOfDevice(now.doc, first);
        if (target === null) {
          now.openModel(first.models[0] ?? '');
          return;
        }
        const image = now.server.images.find((i) => i.imageId === target.image) ?? null;
        now.requestUpgrade(buildUpgradePlan({ devices: devices.filter((d) => d.models.includes(target.model)), model: target.model, target, image }));
      },
      openModel: (model) => latest.current.openModel(model),
      openPlan: (id) => latest.current.openPlan(id),
    };
  }, [doc, canDraw, isSteward, server, reload, edit, organisationId, scopeId]);
}
