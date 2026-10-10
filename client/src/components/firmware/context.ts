import { createContext } from 'react';

import type { FetchLink, FirmwareImage } from '../../api/firmware';
import type { TargetPatch } from '../../document/firmware';
import type { Document } from '../../document/model';

export type Refused = { refused: string };

/** What the server says about firmware for this design's scope. */
export interface FirmwareServer {
  status: 'loading' | 'off' | 'ready' | 'error';
  images: FirmwareImage[];
  /** In words, when `status` is `error`. */
  error: string | null;
}

export interface UploadForm {
  file: File;
  platform: string;
  version: string;
  /** What the person pasted from the vendor's download page. */
  sha256: string;
  /** Catalogue models the image is for. */
  models: string[];
}

/** Everything the Firmware page and a device's firmware row need from the open design. */
export interface FirmwareApi {
  doc: Document;
  /** Draw or steward: may choose versions and hold devices. */
  canEdit: boolean;
  /** Steward: may add images and issue links. The server enforces it too. */
  isSteward: boolean;
  server: FirmwareServer;
  reload(): void;
  setTarget(model: string, patch: TargetPatch): Refused | void;
  clearTarget(model: string): void;
  setHold(deviceId: string, reason: string | null): Refused | void;
  upload(form: UploadForm, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<Refused | { imageId: string }>;
  /** Replaces the models an image is for (steward). Reloads the list on success. */
  setImageModels(imageId: string, models: string[]): Promise<Refused | { changed: boolean }>;
  /** A one-time link. It is shown and dropped, never stored in the design. */
  issueLink(imageId: string): Promise<FetchLink | Refused>;
  /** Makes one plan for these devices (all of one model), or goes to that model's page when it has no chosen version. */
  planUpgrade(deviceIds: string[]): void;
  openModel(model: string): void;
  openPlan(planId: string): void;
}

export const FirmwareContext = createContext<FirmwareApi | null>(null);
