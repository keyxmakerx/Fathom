// A device's serial console (ADR-0080 decision 10): the plain lines for PuTTY on Windows and for
// `screen` or `picocom` on Linux, always there, and Termix's Serial add-on beside them when it runs.
//
// Sources, read 1 November 2026 (CLAUDE.md rule 1):
// - PuTTY manual, chapter 3, §3.11.1 (`putty.exe -serial com1`) and §3.11.3.24 (`-sercfg`: a
//   comma-separated list in which a number that is not data bits or stop bits is the baud rate).
// - GNU Screen manual, "Window Types": a tty device as the first parameter, then the baud rate.
// - picocom(1) (`npat-efault/picocom` at `1acf1dd`, `picocom.1.md`): `--baud | -b` sets the baud rate.
// - Termix's Serial add-on 1.0.2 (`Termix-SSH/Plugin-Serial` `1260614`): a tab opened from Termix's
//   left rail, not tied to a host; the person picks the port and its settings there. Its tab has no
//   standalone view (`src/frontend/index.tsx`, `registerTab` with no `standalone`), and core opens a
//   `?view=` link only for a view that has one (core `c759a14`, `src/main.tsx`, `standaloneViewFor`), so
//   there is no link straight to it: Fathom opens Termix and says where to click.
//   Browsers reach the port through Web Serial: Chrome, Edge, or Firefox 151 and newer (its manifest).

export const SERIAL = 'serial';

/** Placeholders for the port on the person's own computer, which Fathom cannot know. */
export const WINDOWS_PORT = 'COM3';
export const LINUX_PORT = '/dev/ttyUSB0';
export const SPEED_PLACEHOLDER = '<speed>';

export interface SerialWay {
  os: 'windows' | 'linux';
  label: string;
  command: string;
}

export function serialWays(baud: number | undefined): SerialWay[] {
  const speed = baud !== undefined ? String(baud) : SPEED_PLACEHOLDER;
  return [
    { os: 'windows', label: 'From Windows (PuTTY)', command: `putty.exe -serial ${WINDOWS_PORT} -sercfg ${speed}` },
    { os: 'linux', label: 'From Linux (screen)', command: `screen ${LINUX_PORT} ${speed}` },
    { os: 'linux', label: 'From Linux (picocom)', command: `picocom -b ${speed} ${LINUX_PORT}` },
  ];
}
