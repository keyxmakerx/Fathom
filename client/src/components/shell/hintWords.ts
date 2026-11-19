// What each control's hint says, in one place so the words can be read and checked together. A name, then one
// plain sentence a person who has never drawn a network could follow. `hints.test.ts` holds them to that.

import type { Lens } from './lens';
import type { MainView } from './types';

/** The four views in the bar's order, the word on each tab, and what each is. Work sits beside them. */
export const VIEWS: readonly MainView[] = ['diagram', 'canvas', 'inventory', 'sheet'];
export const VIEW_LABEL: Record<MainView, string> = { diagram: 'Diagram', canvas: 'Canvas', inventory: 'Inventory', sheet: 'Sheet' };
export const VIEW_HINT: Record<MainView, string> = {
  diagram: 'Every device as a box and every cable as a line. The quickest way to see what connects to what.',
  canvas: 'The racks, shelves and walls as they are in the room. Add devices and plug in cables here.',
  inventory: 'Everything in this design as lists: devices, ports, cables, networks and addresses.',
  sheet: 'The same lists as one spreadsheet, a tab for each list.',
};
export const WORK_HINT = "Every site's work in one place: planned changes, things that are down, and orders.";

export const BAR_HINT = {
  home: 'Your designs, your work and your settings.',
  search: 'Find a device, rack, port or cable, or run a command by typing its name.',
  undo: 'Take back your last change.',
  redo: 'Put back the change you just took back.',
  doing: 'Start a job on what you have selected: plan a change, say it is down, or trace a path from it.',
  share: 'Choose who in your organisation can see this, and who can change it.',
  admin: 'Settings for the whole server. Only the people who run it see this.',
  shortcuts: 'Every keyboard shortcut on one sheet.',
  account: 'Your sign-in details, the browsers you are signed in on, light or dark, and signing out.',
  sample: 'This design is the sample. Change anything: it is a copy of your own, and you can put it back.',
  viewOnly: 'You can look at this design but not change it. Someone who looks after it can let you.',
} as const;

/** The lenses, where they change the drawing. A lens changes marks and colours; it never moves or hides a box. */
export const LENS_HINT: Record<Lens, string> = {
  cables: 'Each cable in its real colour. Press again for the list of cables, grouped by VLAN, tag, type or device.',
  links: 'Colours each line by its VLAN and draws a faster link thicker. Drawn in the Diagram view.',
  routing: 'Says which device routes, where each gateway is, and which network a cable carries.',
  power: 'What feeds what: power supplies, outlets and the cords between them.',
  owner: 'Who looks after each thing.',
};
/** In Inventory a lens picks the columns of the lists. */
export const LENS_HINT_INVENTORY: Record<Lens, string> = {
  cables: 'The lists show the cabling columns.',
  links: 'The lists show the link columns.',
  routing: 'The lists show the address and routing columns.',
  power: 'The lists show the power columns.',
  owner: 'The lists show who looks after each thing.',
};

export const TOOL_HINT = {
  select: 'Drag a box around things to select them.',
  pan: 'Drag the drawing to move around it.',
  wheelZooms: 'The mouse wheel zooms. Press to make it scroll instead. Ctrl and the wheel always zooms.',
  wheelScrolls: 'The mouse wheel scrolls. Press to make it zoom instead. Ctrl and the wheel always zooms.',
  where: 'The path from the design down to what you have selected. Pick a line to jump there.',
  layers: 'Choose what is written on the drawing: names, addresses, VLANs and more.',
  look: 'How the drawing is drawn: device style, cable style and colours. It changes nothing in the design.',
  views: 'Places on the drawing you saved, each with its layers. Pick one to go back to it.',
  saveView: 'Keep this spot and its layers under a name, to come back to in one press.',
} as const;

export const ZOOM_HINT = {
  out: 'Step back to see more.',
  in: 'Step closer to read more.',
  stops: 'Jump to a set distance, from everything at once down to inside one device.',
  fit: 'Bring the whole design into view.',
} as const;

/** The right-hand panel's tabs, by the word on the tab. */
export const DOCK_HINT: Record<string, string> = {
  Equipment: 'The things you can add. Click one, or drag it onto the drawing.',
  Details: 'Everything about what you have selected, to read and to change.',
  History: 'Every saved change to this design: who made it and when. Any version can be brought back.',
  Checks: 'Mistakes Fathom found in this design, each with why it matters and how to fix it.',
  Docs: 'Notes, links and files kept with this design.',
};
