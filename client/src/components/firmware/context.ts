import { createContext } from 'react';

import type { FetchLink, FirmwareImage } from '../../api/firmware';
import type { TargetPatch } from '../../document/firmware';
import type { KitId } from './kits';
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
  /** A version chosen for the device itself, when none of its models has one (`null` clears it). */
  setDeviceTarget(deviceId: string, version: string | null): Refused | void;
  /** What the device runs, typed by hand (`null` clears it). */
  setRunning(deviceId: string, version: string | null): Refused | void;
  /** How the device's versions are numbered, when no paste has said. */
  setVersionPlatform(deviceId: string, platform: string | null): Refused | void;
  upload(form: UploadForm, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<Refused | { imageId: string }>;
  /** Replaces the models an image is for (steward). Reloads the list on success. */
  setImageModels(imageId: string, models: string[]): Promise<Refused | { changed: boolean }>;
  /** Deletes a staged image's file and keeps its record (steward). Reloads the list on success. */
  retireImage(imageId: string): Promise<Refused | { fileDeleted: boolean }>;
  /** A one-time link. It is shown and dropped, never stored in the design. */
  issueLink(imageId: string, warningsPassed?: readonly string[]): Promise<FetchLink | Refused>;
  /**
   * Makes one plan for these devices (all of one model, or one device with its own chosen version),
   * or goes to that model's page when it has no chosen version. `intoPlan` adds the steps to a plan
   * still being planned instead; `kit` picks the written steps when Fathom has no image.
   */
  planUpgrade(deviceIds: string[], how?: { intoPlan?: string; kit?: KitId }): void;
  openModel(model: string): void;
  openPlan(planId: string): void;
}

export const FirmwareContext = createContext<FirmwareApi | null>(null);
