// Admin › Settings › Device reading: `GET /admin/device-read`, operators only
// (`crates/fathom-server/src/device_read_admin.rs`, ADR-0082 §4.4). Whether this
// server reads devices is `FATHOM_DEVICE_READ`, an environment setting, so the
// console shows it and never sets it.

import { jsonObject } from './json';
import { signedFetch } from './signedFetch';

export interface ServerDeviceReading {
  /** The operator allowed reading (`FATHOM_DEVICE_READ=on`). */
  server: boolean;
  /** The reader answered a ping just now. */
  reader: boolean;
}

export function parseServerDeviceReading(bytes: Uint8Array): ServerDeviceReading {
  const r = jsonObject(bytes, 'device reading');
  return { server: r.server === true, reader: r.reader === true };
}

export async function fetchServerDeviceReading(): Promise<ServerDeviceReading> {
  return parseServerDeviceReading(await signedFetch('GET', '/admin/device-read'));
}
