// Fetch from Termix's read-only list (ADR-0080 decision 9). A check step's command may be run through
// Termix only if it is on this list for the device's platform; anything else is refused here, in the
// browser, before anything is sent. This file is the security-relevant part of decision 9: the list
// is an allow-list, word for word, never a block-list, and it is tested against real spellings
// (`readOnly.test.ts`).
//
// The grammar, for every platform:
// - one line, at most 200 characters, of letters, digits, spaces and `_ - . / : , ( ) @`, plus `|`
//   between a command and an output filter. No quote, `$`, `{`, `;`, `&`, `>`, `<`, backquote or
//   backslash: nothing that chains, substitutes, redirects, or lets Termix fill a variable or a
//   secret into the line (Snippets 1.2.0 fills `$HOST`, `${INPUT_n}` and `{{SECRET}}`).
// - it starts with one of the platform's read-only commands below, spelled out in full: the CLIs
//   accept abbreviations, and an abbreviation is refused so that what is checked is what runs.
// - each `|` is followed by one of the platform's display filters below, spelled out in full.
//
// Read-only commands, from the commands Fathom already writes for these platforms
// (`crates/fathom-server/src/firmware_commands.rs`, vendor pages read 2026-10-10 and cited there):
// `show` everywhere; Junos `file checksum`; IOS XE and NX-OS `dir`; IOS XE and EOS `verify /sha512`;
// EOS `dir` and `verify-swi`.
//
// Display filters, read 1 November 2026 (CLAUDE.md rule 1):
// - Junos: "Filtering Operational Command Output", Junos OS Evolved CLI User Guide (juniper.net).
//   Kept: count, display, except, find, last, match, no-more, trim. Left out: save, tee and append
//   write a file; request message sends to other users; refresh, hold and resolve are not needed.
// - IOS XE: "Searching and Filtering CLI Output", Configuration Fundamentals Configuration Guide,
//   IOS XE Release 3S: begin, exclude, include. "show Command Output Redirection", System Management
//   Configuration Guide, IOS XE 17.x (updated 2023-08-21): redirect, tee and append write to a URL,
//   so they are not on the list.
// - NX-OS: "Understanding the Command-Line Interface", Nexus 3600 NX-OS Fundamentals Configuration
//   Guide 9.3(x), the `show running-config | ?` list. Kept: begin, count, exclude, include, no-more,
//   section. Left out: perl, sed, vsh, sscp and the rest, some of which run programs.
// - EOS: no page establishing EOS's filters could be read, so EOS takes none (CLAUDE.md rule 1:
//   "I could not establish this" beats a guess). A plain `show` still runs.

export type Family = 'junos' | 'ios-xe' | 'nx-os' | 'eos';

/** A device platform (schema/platforms.yaml ids) to its CLI family; null where nothing is offered. */
export function familyOf(platform: string): Family | null {
  if (platform.startsWith('junos')) return 'junos';
  if (platform === 'ios-xe' || platform === 'nx-os' || platform === 'eos') return platform;
  return null;
}

interface Rules {
  /** Each a sequence of whole words the command must start with. */
  commands: readonly (readonly string[])[];
  filters: readonly string[];
}

export const READ_ONLY: Readonly<Record<Family, Rules>> = {
  junos: { commands: [['show'], ['file', 'checksum']], filters: ['count', 'display', 'except', 'find', 'last', 'match', 'no-more', 'trim'] },
  'ios-xe': { commands: [['show'], ['dir'], ['verify', '/sha512']], filters: ['begin', 'exclude', 'include'] },
  'nx-os': { commands: [['show'], ['dir']], filters: ['begin', 'count', 'exclude', 'include', 'no-more', 'section'] },
  eos: { commands: [['show'], ['dir'], ['verify', '/sha512'], ['verify-swi']], filters: [] },
};

export const MAX_COMMAND = 200;
const ALLOWED = /^[A-Za-z0-9 _\-./:,()@|]+$/;

export type ReadOnlyVerdict = { ok: true } | { ok: false; why: string };

/** Whether `command` may be fetched on a device of `platform`, and if not, why, in a sentence. */
export function readOnlyVerdict(platform: string, command: string): ReadOnlyVerdict {
  const family = familyOf(platform);
  if (family === null) return { ok: false, why: `Fathom has no read-only list for ${platform || 'a device with no platform'}.` };
  if (command.length === 0 || command.trim() === '') return { ok: false, why: 'There is no command to fetch.' };
  if (command.length > MAX_COMMAND) return { ok: false, why: `The command is longer than ${MAX_COMMAND} characters.` };
  if (!ALLOWED.test(command)) return { ok: false, why: 'The command holds a character Fathom does not send (a quote, $, {, ;, &, >, <, a backslash or a line break).' };
  const rules = READ_ONLY[family];
  const [head, ...pipes] = command.split('|');
  const words = head!.trim().split(/\s+/);
  const starts = rules.commands.find((c) => c.every((w, i) => words[i] === w) && words.length >= c.length);
  if (!starts) {
    const names = rules.commands.map((c) => c.join(' ')).join(', ');
    return { ok: false, why: `“${words[0] ?? ''}” is not on the read-only list for this platform (${names}, spelled out in full).` };
  }
  if (family === 'junos' && starts[0] === 'file' && words[2] !== 'sha-256') {
    return { ok: false, why: '“file checksum” is fetched only as file checksum sha-256 <file>, the form Fathom’s own steps use.' };
  }
  for (const p of pipes) {
    const filter = p.trim().split(/\s+/)[0] ?? '';
    if (!rules.filters.includes(filter)) {
      return {
        ok: false,
        why:
          rules.filters.length === 0
            ? 'Fathom sends no output filter after | on this platform.'
            : `“| ${filter}” is not a display filter Fathom sends (${rules.filters.join(', ')}).`,
      };
    }
  }
  return { ok: true };
}
