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
