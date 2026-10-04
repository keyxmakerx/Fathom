import type { ReactNode } from 'react';

/** Fathom's own outline network icons (hand drawn, no outside set): ink strokes at
 * the canvas line weight, closed shapes filled with the page so cables never show
 * through. One 56 × 40 grid each. */

export const ICON_W = 56;
export const ICON_H = 40;
export const ICON_STROKE = 1.6;

export const ICON_KINDS = ['router', 'switch', 'firewall', 'server', 'access_point', 'internet', 'pc', 'printer', 'patch_panel'] as const;

export type IconKind = (typeof ICON_KINDS)[number];

const BRICKS = [
  'M3 12 H53 M3 20 H53 M3 28 H53',
  'M28 4 V12 M16 12 V20 M40 12 V20 M28 20 V28 M16 28 V36 M40 28 V36',
].join(' ');

const GLYPHS: Record<IconKind, ReactNode> = {
  router: (
    <>
      <circle cx="28" cy="20" r="17" />
      <path d="M28 7 V15 M28 25 V33 M15 20 H23 M33 20 H41" />
    </>
  ),
  switch: (
    <>
      <rect x="3" y="6" width="50" height="28" />
      <path d="M12 15 H44 M38 10 L44 15 L38 20 M44 26 H12 M18 21 L12 26 L18 31" />
    </>
  ),
  firewall: (
    <>
      <rect x="3" y="4" width="50" height="32" />
      <path d={BRICKS} />
    </>
  ),
  server: (
    <>
      <rect x="16" y="2" width="24" height="36" />
      <path d="M21 12 H35 M21 18 H35 M21 24 H35" />
    </>
  ),
  access_point: (
    <>
      <path d="M13 17 A21 21 0 0 1 43 17 M19 23 A12 12 0 0 1 37 23" fill="none" />
      <circle cx="28" cy="31" r="3.5" fill="currentColor" />
    </>
  ),
  internet: <path d="M12 34 H44 A8 8 0 0 0 44 18 A10 10 0 0 0 26 12 A11 11 0 0 0 16 20 A7 7 0 0 0 12 34 Z" />,
  pc: (
    <>
      <rect x="6" y="3" width="44" height="26" />
      <path d="M28 29 V35 M18 36 H38" fill="none" />
    </>
  ),
  printer: (
    <>
      <rect x="17" y="3" width="22" height="9" />
      <rect x="6" y="12" width="44" height="16" />
      <rect x="15" y="24" width="26" height="12" />
    </>
  ),
  patch_panel: (
    <>
      <rect x="2" y="10" width="52" height="20" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <rect key={i} x={6 + i * 6} y="16" width="4" height="8" />
      ))}
    </>
  ),
};

/** `Device.role` → icon. A role with no icon (`load_balancer`, `other`, unset) draws a box. */
const BY_ROLE: Record<string, IconKind> = {
  router: 'router',
  switch: 'switch',
  firewall: 'firewall',
  server: 'server',
  access_point: 'access_point',
};

export function iconForRole(role: string | null | undefined): IconKind | null {
  return role != null && Object.prototype.hasOwnProperty.call(BY_ROLE, role) ? BY_ROLE[role]! : null;
}

export function DeviceIcon({ kind }: { kind: IconKind }) {
  return (
    <svg
      className="device-icon"
      data-icon={kind}
      width={ICON_W}
      height={ICON_H}
      viewBox={`0 0 ${ICON_W} ${ICON_H}`}
      aria-hidden="true"
      fill="var(--page)"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinejoin="miter"
      strokeLinecap="butt"
    >
      {GLYPHS[kind]}
    </svg>
  );
}
