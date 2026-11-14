// `GET /about` (cards r134 and r135, `crates/fathom-server/src/about.rs`): which build the server
// is, and which outside connections it has switched on. Booleans only; no host, range or key.

import { signedFetch } from './signedFetch';

export interface AboutConnections {
  deviceRead: boolean;
  outsideVaults: boolean;
  passbolt: boolean;
  offsiteBackup: boolean;
  auditSyslog: boolean;
  accessSyslog: boolean;
  termix: boolean;
}

export interface About {
  version: string;
  /** Empty in a development build, which nobody stamped. */
  commit: string;
  built: string;
  /** Whether the device reader answered a ping just now. */
  reader: boolean;
  connections: AboutConnections;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new Error(`/about: ${key} is not true or false`);
  return v;
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new Error(`/about: ${key} is not text`);
  return v;
}

export function parseAbout(bytes: Uint8Array): About {
  const o = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (o == null || typeof o !== 'object') throw new Error('/about: not an object');
  const top = o as Record<string, unknown>;
  const c = top.connections;
  if (c == null || typeof c !== 'object') throw new Error('/about: no connections');
  const conn = c as Record<string, unknown>;
  return {
    version: str(top, 'version'),
    commit: str(top, 'commit'),
    built: str(top, 'built'),
    reader: bool(top, 'reader'),
    connections: {
      deviceRead: bool(conn, 'device_read'),
      outsideVaults: bool(conn, 'outside_vaults'),
      passbolt: bool(conn, 'passbolt'),
      offsiteBackup: bool(conn, 'offsite_backup'),
      auditSyslog: bool(conn, 'audit_syslog'),
      accessSyslog: bool(conn, 'access_syslog'),
      termix: bool(conn, 'termix'),
    },
  };
}

export async function fetchAbout(): Promise<About> {
  return parseAbout(await signedFetch('GET', '/about'));
}
