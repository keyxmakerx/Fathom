// The words the placement form says before and after the save, and the
// arithmetic behind them -- ADR-0055 decision 11 and the owner's own
// sentence, 2026-09-21: *"Just be sure there is adequate warning … and a
// redirect. Maybe even a 5 min timer (maybe variable timer but can not be
// turned off) and if operator hasn't logged in, then the admin URL is
// disabled back for being generic."*
//
// Pure functions in their own module, with no React in them, because the
// client's test runner is `environment: 'node'` (`client/vitest.config.ts`)
// and a warning nobody can test is a warning nobody can check the wording
// of. `placementCopy.test.ts` drives every branch here.

import {
  EVERYWHERE_SOURCES,
  MAX_WINDOW_SECONDS,
  MIN_WINDOW_SECONDS,
  normalisePlacementHosts,
  normalisePlacementSources,
} from '../../api/placement';

/** The window is chosen in minutes and sent in seconds. One to sixty
 * minutes, which is exactly `placement.rs`'s 60..=3600 seconds. */
export const MIN_WINDOW_MINUTES = MIN_WINDOW_SECONDS / 60;
export const MAX_WINDOW_MINUTES = MAX_WINDOW_SECONDS / 60;
export const DEFAULT_WINDOW_MINUTES = 5;

export interface PlacementDraft {
  hosts: string;
  sources: string;
  windowMinutes: number;
}

/** Why this draft cannot be saved, or `null` when it can. The server checks
 * all of this again -- `check_hosts`, `check_sources`, the window bounds --
 * and this is here so the operator is told before the console moves, not
 * after. */
export function placementProblem(draft: PlacementDraft): string | null {
  const hosts = normalisePlacementHosts(draft.hosts);
  if (hosts.length === 0) {
    return 'Name at least one host. A placement with no host would confine the console to nowhere.';
  }
  if (hosts.length > 2000) {
    return 'That host list is longer than the 2000 characters the server stores.';
  }
  for (const host of hosts.split(',').map((h) => h.trim())) {
    if (host.length === 0) continue;
    if (!/^[A-Za-z0-9.\-[\]:]+$/.test(host) || host.length > 253) {
      return `"${host}" is not a host name. A Host header carries letters, digits, "-", "." and an IPv6 literal's brackets — no scheme, no path, no space.`;
    }
  }
  if (!Number.isInteger(draft.windowMinutes)) {
    return 'The window is a whole number of minutes.';
  }
  if (draft.windowMinutes < MIN_WINDOW_MINUTES || draft.windowMinutes > MAX_WINDOW_MINUTES) {
    return `The window is between ${MIN_WINDOW_MINUTES} and ${MAX_WINDOW_MINUTES} minutes, and cannot be turned off.`;
  }
  return null;
}

/**
 * The warning shown **before** the save, as separate sentences so the
 * surface can give each its own line.
 *
 * It names the new host, the window, and what happens if nobody signs in
 * there in time -- the three things the owner asked for, in that order.
 */
export function placementWarning(draft: PlacementDraft, currentHost: string): string[] {
  const hosts = normalisePlacementHosts(draft.hosts);
  const sources = normalisePlacementSources(draft.sources);
  const first = hosts.split(',')[0].trim();
  const lines = [
    `The console moves to ${hosts} the moment you save. This host, ${currentHost}, stops answering /admin at all — it answers 404, as though the console were not installed.`,
    sources === EVERYWHERE_SOURCES
      ? `You named no source addresses, so the server stores ${EVERYWHERE_SOURCES}: the console will answer from anywhere that can reach ${first}. Narrow it here, or at your proxy, or both.`
      : `Only these source addresses will be answered: ${sources}. A request from anywhere else gets a 404, including yours if you move.`,
    `You then have ${describeWindow(draft.windowMinutes)} to sign in as an operator on ${first}. This browser is taken there as soon as the save succeeds.`,
    `If nobody signs in there inside the window, the placement reverts on its own — back to the last confirmed placement, or to a console that answers everywhere if there was none — and the revert is sealed into the site trail.`,
  ];
  return lines;
}

export function describeWindow(minutes: number): string {
  return minutes === 1 ? 'one minute' : `${minutes} minutes`;
}

/** Seconds left on the window, floored at zero. `confirmByUnix` and
 * `nowUnix` are both unix SECONDS, which is what the server sends. */
export function secondsLeft(confirmByUnix: number, nowUnix: number): number {
  return Math.max(0, Math.floor(confirmByUnix - nowUnix));
}

/** `m:ss`, the shape a countdown is read at a glance in. Minutes are not
 * padded; seconds always are. */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** What the page says while the countdown runs, on the host that is being
 * left and on the host that is being moved to. */
export function countdownSentence(host: string, secondsRemaining: number): string {
  if (secondsRemaining <= 0) {
    return `The window has run out. The console is back where it was; ${host} is no longer confined by this placement.`;
  }
  return `${formatCountdown(secondsRemaining)} left to sign in as an operator on ${host}, or this placement reverts.`;
}
