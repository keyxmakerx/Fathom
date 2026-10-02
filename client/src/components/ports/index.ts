import './ports.css';

import type { JSX } from 'react';

import { C14 } from './C14';
import { Generic } from './Generic';
import { Lc } from './Lc';
import { QsfpPlus } from './QsfpPlus';
import { Rj45 } from './Rj45';
import { SfpPlus } from './SfpPlus';
import type { PortGlyphProps, PortKind } from './types';

export { C14, Generic, Lc, QsfpPlus, Rj45, SfpPlus };
export type { PortGlyphProps, PortKind };

/** The catalogue names a kind; this picks the glyph for it. */
export const PORT_GLYPHS: Record<PortKind, (props: PortGlyphProps) => JSX.Element> = {
  rj45: Rj45,
  'sfp-plus': SfpPlus,
  lc: Lc,
  c14: C14,
  'qsfp-plus': QsfpPlus,
  generic: Generic,
};

/** Each glyph's true (scale 1) size, matching its `frame(...)` box. */
export const GLYPH_SIZE: Record<PortKind, { w: number; h: number }> = {
  rj45: { w: 23, h: 21 },
  'sfp-plus': { w: 29, h: 17 },
  lc: { w: 25, h: 15 },
  c14: { w: 23, h: 17 },
  'qsfp-plus': { w: 41, h: 14 },
  generic: { w: 17, h: 17 },
};
