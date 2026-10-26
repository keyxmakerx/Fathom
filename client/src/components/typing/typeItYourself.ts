// "Type it yourself" (sign-off card r30-nocopy): a teaching setting a steward turns on for a person, or
// the person turns on for themselves (only a steward turns it off). While it is on, commands are shown
// to be typed by hand: no copy buttons on them, the text not selectable, and each command broken into
// labelled parts. Links and hashes still copy: a SHA-256 or a one-time link is not something to learn by
// typing. It is a teaching aid, not a control, so nothing here says it stops anyone copying.

import { createContext, useContext } from 'react';

/** Whether the signed-in person has it on in the open organisation. Off outside one. */
export const TypeItYourself = createContext(false);

export const useTypeItYourself = (): boolean => useContext(TypeItYourself);

/** What one part of a command is, in words a learner reads under it. */
export type PartLabel = 'command' | 'word' | 'option' | 'path' | 'file' | 'value' | 'text' | 'link' | 'fill in';

export interface CommandPart {
  text: string;
  label: PartLabel;
}

/** A path on a device or a computer: `/var/tmp/x`, `flash:`, `C:\fw`, `./x`, `~/x`. */
const PATH = /^(\/|\.{1,2}\/|~\/|[A-Za-z]:\\|[a-z][\w-]*:(?!\/\/))/;
/** A file by its name: `junos-21.4R3.tgz`, `cat9k_iosxe.17.09.04a.SPA.bin`. */
const FILE = /^[\w.+-]+\.(tgz|tar|gz|bin|img|iso|swi|zip|pkg|txt|conf|cfg)$/i;
/** A number, an address, a version: `22`, `10.0.0.1`, `17.09.04a`, `21.4R3-S5.5`. */
const VALUE = /^\d[\w.:()/-]*$/;

function labelOf(token: string, first: boolean, link?: string): PartLabel {
  if (token.startsWith('<') && token.endsWith('>')) return /link|url/i.test(token) ? 'link' : 'fill in';
  if (link !== undefined && token.includes(link)) return 'link';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return 'link';
  if (/^["'].*["']$/.test(token)) return 'text';
  if (first) return 'command';
  if (/^--?\w/.test(token)) return 'option';
  if (FILE.test(token)) return 'file';
  if (PATH.test(token)) return 'path';
  if (VALUE.test(token)) return 'value';
  return 'word';
}

/**
 * Split a command into the parts a person types, one space between each. A quoted string and a
 * `<placeholder>` stay one part each. `link`, when given, is a one-time link inside the command: its part
 * is labelled `link`, so the page can offer the link's own copy beside it.
 */
export function commandParts(command: string, link?: string): CommandPart[] {
  const tokens = command.trim().match(/<[^>]*>|"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens.map((text, i) => ({ text, label: labelOf(text, i === 0, link) }));
}
