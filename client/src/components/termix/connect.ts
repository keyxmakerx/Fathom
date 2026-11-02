// The plain way to reach a device, always shown whether or not there is a Termix (ADR-0080 decision 8).
// Fathom connects to nothing: these are lines for the person to type or copy on their own computer.
//
// Sources, read for the firmware By hand steps and cited there (`crates/fathom-server/src/firmware_by_hand.rs`):
// - Windows: `ssh` comes with the OpenSSH Client for Windows; if PowerShell does not recognise it, add
//   OpenSSH Client in Settings, Optional features (Microsoft Learn, "Get started with OpenSSH for
//   Windows", updated 2025-09-04). Its example is `ssh user@host`.
// - Linux: `ssh [user@]host` (ssh(1), OpenSSH).
// Fathom has no user name for a device's login (ADR-0078 decision 2), so the line says `<your user>`.

import { bareAddress, isHostAddress } from './termix';

export const USER_PLACEHOLDER = '<your user>';

export interface ConnectWay {
  os: 'windows' | 'linux';
  label: string;
  command: string;
  note: string;
}

/** `ssh <your user>@<address>`, or null when the address is not one ssh can take. */
export function sshLine(address: string): string | null {
  const a = bareAddress(address);
  return isHostAddress(a) ? `ssh ${USER_PLACEHOLDER}@${a}` : null;
}

export function connectWays(address: string): ConnectWay[] {
  const line = sshLine(address);
  if (line === null) return [];
  return [
    {
      os: 'windows',
      label: 'From Windows (PowerShell)',
      command: line,
      note: 'ssh comes with the OpenSSH Client for Windows. If PowerShell says ssh is not recognised, add OpenSSH Client in Settings, Optional features.',
    },
    { os: 'linux', label: 'From Linux', command: line, note: 'Put your own user name in place of <your user>.' },
  ];
}
