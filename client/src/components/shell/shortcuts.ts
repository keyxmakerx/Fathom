// Every keyboard shortcut, in one table. The "Keyboard shortcuts" sheet and the command palette read
// this table, and the handlers added with it ask `matches` rather than hard-coding keys, so the list
// cannot drift from what the keys do.

export type ShortcutGroup = 'Canvas' | 'Selection' | 'Editing' | 'Find';

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Canvas', 'Selection', 'Editing', 'Find'];

/** What a key press has to be for a shortcut to fire. `mod` is Ctrl, or Cmd on a Mac. */
export interface KeySpec {
  key: string;
  mod?: boolean;
  shift?: boolean;
  /** Alt (Option on a Mac) held. Shortcuts that do not name it are not triggered with it held. */
  alt?: boolean;
}

export interface Shortcut {
  id: string;
  group: ShortcutGroup;
  /** Key caps in the order pressed together, as shown ("Ctrl", "Shift", "Z"). */
  keys: readonly string[];
  what: string;
  /** Absent for a gesture (a double-click) that is not a key press. */
  spec?: KeySpec;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'tool-select', group: 'Canvas', keys: ['V'], what: 'Select tool: drag to box-select', spec: { key: 'v' } },
  { id: 'tool-pan', group: 'Canvas', keys: ['H'], what: 'Pan tool: drag to move the view', spec: { key: 'h' } },
  { id: 'print', group: 'Canvas', keys: ['Ctrl', 'P'], what: 'Print or export', spec: { key: 'p', mod: true } },
  { id: 'go-back', group: 'Canvas', keys: ['Alt', 'Left'], what: 'Go back to where you were, like a browser', spec: { key: 'ArrowLeft', alt: true } },
  { id: 'go-forward', group: 'Canvas', keys: ['Alt', 'Right'], what: 'Go forward again', spec: { key: 'ArrowRight', alt: true } },
  { id: 'shortcuts', group: 'Canvas', keys: ['?'], what: 'Show this list of shortcuts', spec: { key: '?' } },

  { id: 'clear', group: 'Selection', keys: ['Esc'], what: 'Clear the selection or close what is open', spec: { key: 'Escape' } },
  { id: 'select-all', group: 'Selection', keys: ['Ctrl', 'A'], what: 'Select every box on the canvas', spec: { key: 'a', mod: true } },
  { id: 'nudge-up', group: 'Selection', keys: ['Up'], what: 'Move a rack device up one unit (a box: nudge it)', spec: { key: 'ArrowUp' } },
  { id: 'nudge-down', group: 'Selection', keys: ['Down'], what: 'Move a rack device down one unit (a box: nudge it)', spec: { key: 'ArrowDown' } },
  { id: 'nudge-left', group: 'Selection', keys: ['Left'], what: 'Nudge a selected box left (Shift for more)', spec: { key: 'ArrowLeft' } },
  { id: 'nudge-right', group: 'Selection', keys: ['Right'], what: 'Nudge a selected box right (Shift for more)', spec: { key: 'ArrowRight' } },

  { id: 'undo', group: 'Editing', keys: ['Ctrl', 'Z'], what: 'Undo your last change', spec: { key: 'z', mod: true } },
  { id: 'redo', group: 'Editing', keys: ['Ctrl', 'Shift', 'Z'], what: 'Redo', spec: { key: 'z', mod: true, shift: true } },
  { id: 'delete', group: 'Editing', keys: ['Delete'], what: 'Remove the selected device, box or cable', spec: { key: 'Delete' } },
  { id: 'duplicate', group: 'Editing', keys: ['Ctrl', 'D'], what: 'Duplicate the selected device', spec: { key: 'd', mod: true } },
  { id: 'copy', group: 'Editing', keys: ['Ctrl', 'C'], what: 'Copy the selected device', spec: { key: 'c', mod: true } },
  { id: 'paste', group: 'Editing', keys: ['Ctrl', 'V'], what: 'Paste into the next free units of the selected rack', spec: { key: 'v', mod: true } },
  { id: 'rename', group: 'Editing', keys: ['Double-click'], what: 'Double-click a name on the canvas to rename it' },

  { id: 'find', group: 'Find', keys: ['Ctrl', 'K'], what: 'Find a device, rack, port or cable, or run a command', spec: { key: 'k', mod: true } },
];

export function shortcutById(id: string): Shortcut {
  const found = SHORTCUTS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no shortcut called ${id}`);
  return found;
}

/** Does this key press match the shortcut called `id`? A shortcut with no key (a gesture) never does. */
export function matches(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, id: string): boolean {
  const spec = shortcutById(id).spec;
  if (spec === undefined || (spec.alt ?? false) !== event.altKey) return false;
  const mod = event.ctrlKey || event.metaKey;
  if ((spec.mod ?? false) !== mod) return false;
  // `?` is itself typed with Shift, and a letter's shift is only asked about where it matters (redo).
  if (spec.key !== '?' && spec.key.length === 1 && (spec.shift ?? false) !== event.shiftKey) return false;
  if (spec.key.length === 1) return event.key.toLowerCase() === spec.key;
  return event.key === spec.key;
}

/** True while someone is typing, so a shortcut must stay out of the way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el != null && (el.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''));
}

/** Key caps for the platform: Cmd for Ctrl, and Option for Alt, on a Mac. */
export function capsFor(keys: readonly string[], mac: boolean): string[] {
  return keys.map((k) => (mac && k === 'Ctrl' ? 'Cmd' : mac && k === 'Alt' ? 'Option' : k));
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
}

/** The shortcut for a command as one line ("Ctrl+Z"), or '' when it has none. */
export function shortcutText(id: string, mac = isMac()): string {
  return capsFor(shortcutById(id).keys, mac).join('+');
}
