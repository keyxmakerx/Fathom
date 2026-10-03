// What the People and Waiting screens say, and the small decisions behind
// them, kept pure so the words and the batch rules can be tested without a
// browser. Names and emails here are only ever what a steward typed.

import { BATCH_CAP, DAY_SECONDS, type Asked, type ConfirmRow, type Invitation } from '../../api/invitations';
import type { AccessRow, Person } from '../../api/people';

export const CAPABILITY_WORD: Record<Asked, string> = { read: 'Read', draw: 'Draw', steward: 'Steward' };

/** What each level lets a person do, in the words the invite form shows. */
export const CAPABILITY_HELP: Record<Asked, string> = {
  read: 'Read: can look at everything in the folder.',
  draw: 'Draw: can look and can change designs in the folder.',
  steward: 'Steward: can also invite and confirm people and remove their access. Needs a second steward to agree.',
};

/** "Draw · LON1", or "Read · whole organisation". */
export function accessWords(capability: Asked, scopeId: string | null, label: string): string {
  return `${CAPABILITY_WORD[capability]} · ${scopeId === null ? 'whole organisation' : label}`;
}

export function stateWords(person: Person): string {
  if (person.state === 'active') return 'Active';
  if (person.state === 'waiting') return person.expired ? 'Joined, too late to confirm' : 'Waiting for you';
  return person.expired ? 'Invited, link expired' : 'Invited';
}

/** Ink, not colour: a filled dot for someone in, an open one for someone not yet. */
export function stateMark(person: Person): string {
  return person.state === 'active' ? '●' : person.state === 'waiting' ? '◆' : '○';
}

/** What a person can do, one line: the rows, or what is asked of them. */
export function canDoWords(person: Person): string {
  if (person.state === 'active') {
    if (person.access.length === 0) return 'Nothing in the folders you steward';
    return person.access.map((a) => accessWords(a.capability, a.scopeId, a.label)).join('; ');
  }
  if (!person.asked) return 'Nothing yet';
  const asked = accessWords(person.asked.capability, person.asked.scopeId, person.asked.scopeLabel);
  return person.state === 'waiting' ? `${asked} (waits for you)` : `${asked} (when they join)`;
}

const two = (n: number) => String(n).padStart(2, '0');

/** "today 09:12", "yesterday 17:40", or "3 Oct 09:12". */
export function whenLabel(unix: number, nowMs: number): string {
  const d = new Date(unix * 1000);
  const now = new Date(nowMs);
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const diff = Math.round((day(now) - day(d)) / (DAY_SECONDS * 1000));
  if (diff === 0) return `today ${clock}`;
  if (diff === 1) return `yesterday ${clock}`;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${d.getDate()} ${month} ${clock}`;
}

export function dateLabel(unix: number): string {
  const d = new Date(unix * 1000);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${d.getDate()} ${month} ${d.getFullYear()}`;
}

/** What removing this row does, said before it is signed. */
export function removalWords(row: AccessRow, who: string): string {
  const what = accessWords(row.capability, row.scopeId, row.label);
  if (row.revokeTakesEffectInSeconds > 0) {
    const hours = Math.round(row.revokeTakesEffectInSeconds / 3600);
    return (
      `Removing ${who}’s steward access (${what}) takes effect ${hours} hours after you sign. ` +
      'Until then they keep it. That wait is the rule for removing another steward, so that one steward ' +
      'cannot remove another at once.'
    );
  }
  return `Remove ${who}’s access (${what}). It stops as soon as you sign.`;
}

/** Why a row cannot be removed from this screen, or null when it can. */
export function whyNotRemovable(row: AccessRow, you: boolean): string | null {
  if (row.revokingAtUnix !== null) return `Being removed on ${dateLabel(row.revokingAtUnix)}.`;
  if (row.genesis) return 'Given when the organisation was set up.';
  if (row.inherited) return 'Comes from a folder above; remove it there.';
  if (!row.revocable) return 'You do not steward this folder.';
  if (you) return 'You cannot remove your own access here.';
  if (row.scopeId === null) return 'Given to the whole organisation; not removable from this screen yet.';
  return null;
}

// ---- Waiting rows -------------------------------------------------------

/** What the steward changed on a row before confirming. */
export interface RowEdit {
  capability: Asked;
  scopeId: string | null;
  scopeLabel: string;
}

export interface WaitingRow {
  invitation: Invitation;
  /** Access as it will be signed: the ask, or the steward's change to it. */
  capability: Asked;
  scopeId: string | null;
  scopeLabel: string;
  changed: boolean;
}

export function applyEdits(invitations: readonly Invitation[], edits: Readonly<Record<string, RowEdit>>): WaitingRow[] {
  return invitations
    .filter((i) => i.state === 'joined')
    .map((invitation) => {
      const e = edits[invitation.id];
      return e
        ? { invitation, capability: e.capability, scopeId: e.scopeId, scopeLabel: e.scopeLabel, changed: e.capability !== invitation.capabilityAsked || e.scopeId !== invitation.scopeId }
        : { invitation, capability: invitation.capabilityAsked, scopeId: invitation.scopeId, scopeLabel: invitation.scopeLabel, changed: false };
    });
}

/** Joined and able to be confirmed now. */
export const confirmable = (r: WaitingRow): boolean => r.invitation.canConfirm && r.invitation.keyCode !== null;

export interface Split {
  /** Read and Draw rows that can be confirmed together. */
  batch: WaitingRow[];
  /** Steward requests, confirmed one at a time. */
  stewards: WaitingRow[];
  /** Joined, but too late or not verifiable. They can only be refused. */
  blocked: WaitingRow[];
}

export function splitRows(rows: readonly WaitingRow[]): Split {
  const split: Split = { batch: [], stewards: [], blocked: [] };
  for (const r of rows) {
    if (!confirmable(r)) split.blocked.push(r);
    else if (r.capability === 'steward') split.stewards.push(r);
    else split.batch.push(r);
  }
  return split;
}

/** Everyone ticked, up to the cap: a long list is ticked from the top. */
export function initialTicks(batch: readonly WaitingRow[]): Set<string> {
  return new Set(batch.slice(0, BATCH_CAP).map((r) => r.invitation.id));
}

export function confirmRowOf(r: WaitingRow): ConfirmRow {
  return {
    invitation: r.invitation.id,
    account: r.invitation.account,
    capability: r.capability,
    scopeId: r.scopeId,
    keyCode: r.invitation.keyCode ?? '',
  };
}

export function ticked(batch: readonly WaitingRow[], ticks: ReadonlySet<string>): WaitingRow[] {
  return batch.filter((r) => ticks.has(r.invitation.id));
}

/** The label for the confirm button, and whether it can be pressed. */
export function confirmButton(count: number): { label: string; disabled: boolean; note: string | null } {
  const label = `Confirm ${count} ${count === 1 ? 'person' : 'people'}`;
  if (count === 0) return { label: 'Confirm', disabled: true, note: null };
  if (count > BATCH_CAP) return { label, disabled: true, note: `Up to ${BATCH_CAP} at a time. Untick some.` };
  return { label, disabled: false, note: null };
}

/** Say what a steward request needs, once the server has said whether it is a sole appointment. */
export function stewardNeeds(sole: boolean): string {
  return sole
    ? 'You are the only steward, so this takes effect 24 hours after you sign. No second steward is needed.'
    : 'A second steward must agree before this takes effect. They will see it under Waiting for you.';
}

/** Expiry for a steward appointment `days` from now, or null when not a usable number. */
export function expiryFromDays(days: number, nowUnix: number): number | null {
  if (!Number.isInteger(days) || days < 2 || days > 365) return null;
  return nowUnix + days * DAY_SECONDS;
}
