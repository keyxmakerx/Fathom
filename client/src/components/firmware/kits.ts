// Written steps for upgrades Fathom has no image for (schema 0.31, sign-off r55): the device fetches
// its update from the vendor, not from Fathom, so these are a person's checklist with the vendor's
// own menu paths and commands, never something Fathom runs. Each kit names the page it was written
// from and the day it was read; a kit nobody could check against the vendor says so on its first
// step. Pure data. The plan adds the last step itself, "Record <version> as running" (upgradePlan.ts).

export type KitId = 'opnsense' | 'debian' | 'ubuntu' | 'truenas' | 'synology' | 'general';

export interface KitStep {
  title: string;
  /** The muted second line. */
  muted: string;
  /** Commands, one per line, when the vendor gives some. */
  after?: string;
}

export interface Kit {
  id: KitId;
  label: string;
  /** False when the vendor's own page could not be read: the first step says so. */
  checked: boolean;
  steps: readonly KitStep[];
}

const READ_ON = '2026-10-28';

const from = (who: string, url: string): KitStep => ({ title: `Check these steps against ${who}`, muted: `Written from ${url}, read ${READ_ON}.` });

export const KITS: Readonly<Record<KitId, Kit>> = {
  // docs.opnsense.org/manual/updates.html (no page date; © 2016-2026 Deciso) and the 26.1 release notes.
  opnsense: {
    id: 'opnsense',
    label: 'OPNsense',
    checked: true,
    steps: [
      from('OPNsense', 'docs.opnsense.org/manual/updates.html'),
      { title: 'Back up the running config', muted: 'Paste /conf/config.xml into Fathom; the redaction gate runs first.' },
      { title: 'Read the release notes for the new version', muted: 'docs.opnsense.org/releases: 26.1 moved ISC-DHCP to a plugin, for one.' },
      { title: 'Have a way back', muted: 'A major upgrade runs offline: keep a console or second connection, and a snapshot to revert to.' },
      { title: 'Check for updates and install', muted: 'System ‣ Firmware ‣ Status, Check for updates. On the console: option 12.' },
      { title: 'Let it reboot', muted: 'A major upgrade downloads, reboots, installs, and reboots again.' },
    ],
  },
  // debian.org/releases/oldstable/amd64/release-notes/ch-upgrading.html, chapter 4 (no page date).
  debian: {
    id: 'debian',
    label: 'Debian',
    checked: true,
    steps: [
      from("Debian's release notes", 'debian.org/releases/…/release-notes/ch-upgrading.html'),
      { title: 'Back up /etc, /var/lib/dpkg and /var/lib/apt/extended_states', muted: 'And the package list, from the command below.', after: "cat /etc/debian_version\ndpkg --get-selections '*'" },
      { title: 'Read "Issues to be aware of" for the new release', muted: 'Chapter 5 of the release notes. Check there is room for the upgrade.' },
      { title: 'Point APT at the new release', muted: 'Add lines for the new codename; put # in front of the old ones.' },
      { title: 'Upgrade in two steps', muted: 'A minimal upgrade first, then the full one.', after: 'apt update\napt upgrade --without-new-pkgs\napt full-upgrade' },
      { title: 'Reboot', muted: 'The new kernel needs it.' },
    ],
  },
  // ubuntu.com/server/docs/how-to/software/upgrade-your-release/ (last updated July 6, 2026).
  ubuntu: {
    id: 'ubuntu',
    label: 'Ubuntu',
    checked: true,
    steps: [
      from('Ubuntu', 'ubuntu.com/server/docs/how-to/software/upgrade-your-release'),
      { title: 'Back up all your data', muted: 'Somewhere it can be restored from if the upgrade goes wrong.' },
      {
        title: 'Bring this release fully up to date',
        muted: 'Reboot first if /run/reboot-required exists. The upgrade needs several gigabytes free.',
        after: 'sudo apt update\nsudo apt dist-upgrade -o APT::Get::Always-Include-Phased-Updates=true',
      },
      { title: 'Expect third-party repositories to be turned off', muted: 'PPAs are disabled during the upgrade; re-enable them after.' },
      { title: 'Run the release upgrade', muted: 'Read the differences before answering each configuration-file question.', after: 'sudo do-release-upgrade' },
      { title: 'Reboot when it asks', muted: 'It is not upgraded until this reboot.' },
    ],
  },
  // truenas.com/docs/scale/25.10/scaletutorials/systemsettings/updatescale/ (modified 2025-08-29) and
  // truenas.com/docs/scale/systemsettings/update/updatingtruenas/ (modified 2026-04-23).
  truenas: {
    id: 'truenas',
    label: 'TrueNAS',
    checked: true,
    steps: [
      from('TrueNAS', 'truenas.com/docs/scale/…/updatescale'),
      { title: 'Take the latest maintenance release first', muted: 'Before a new major version. The Software Status page lists the upgrade paths.' },
      { title: 'Pick an idle time', muted: 'The system restarts after an update.' },
      { title: 'Install the update and save the configuration', muted: 'System ‣ Update, Install Update. Tick Export Password Secret Seed, then Save Configuration.' },
      { title: 'Keep that file out of Fathom', muted: 'With the secret seed it holds the system’s secrets. Store it where secrets go.' },
      { title: 'After the restart, check the settings', muted: 'Clear the browser cache (Ctrl+F5), log in, recheck, save a new configuration.' },
    ],
  },
  // Synology's own Knowledge Center pages returned no body to the fetch on 2026-10-28. The manual
  // update path is from mariushosting.com/synology-how-do-i-manually-update-dsm/ (updated
  // 2026-10-14), a third party. Unchecked, and the first step says so.
  synology: {
    id: 'synology',
    label: 'Synology DSM',
    checked: false,
    steps: [
      {
        title: "Check these steps against Synology's own help first",
        muted: `Fathom could not read Synology's pages on ${READ_ON}; these come from mariushosting.com.`,
      },
      { title: 'Back up what this NAS holds', muted: 'Before the update, somewhere off this NAS.' },
      { title: 'Open DSM Update', muted: 'Control Panel ‣ Update & Restore ‣ DSM Update.' },
      { title: 'Or update by hand', muted: 'Download the .pat for this model, then Manual DSM Update and choose it.' },
      { title: 'Let it restart', muted: 'Inside the window.' },
    ],
  },
  general: {
    id: 'general',
    label: 'Other (no written steps)',
    checked: true,
    steps: [
      { title: 'Back up the running config', muted: 'Paste it into Fathom; the redaction gate runs first.' },
      { title: "Read the vendor's release notes", muted: 'Fathom has no steps written for this platform.' },
      { title: 'Have a way back', muted: 'A console, a snapshot, or the old version to hand.' },
      { title: 'Install and let it restart', muted: 'Inside the window.' },
    ],
  },
};

export const KIT_CHOICES: readonly KitId[] = ['opnsense', 'debian', 'ubuntu', 'truenas', 'synology', 'general'];

/** The kit a platform suggests; the person can pick another (a NAS often has no platform at all). */
export function kitFor(platform: string): KitId {
  if (platform === 'opnsense') return 'opnsense';
  if (platform === 'linux-host') return 'debian';
  return 'general';
}
