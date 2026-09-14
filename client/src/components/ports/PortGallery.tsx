import type { JSX } from 'react';

import { ThemeToggle } from '../ThemeToggle';
import { C14, Lc, QsfpPlus, Rj45, SfpPlus, type PortGlyphProps, type PortKind } from './index';
import './gallery.css';

/** A static page that puts the five glyphs side by side the way the Legend
 * board puts four: every glyph, both states, at the zooms it must survive,
 * in whichever theme the toggle picks. Open it at `/ports.html`. */

const GLYPHS: { kind: PortKind; name: string; note: string; Glyph: (p: PortGlyphProps) => JSX.Element }[] = [
  { kind: 'rj45', name: 'RJ45', note: 'latch notch on top · copper', Glyph: Rj45 },
  { kind: 'sfp-plus', name: 'SFP+', note: 'flat cage with a bail · one slot', Glyph: SfpPlus },
  { kind: 'qsfp-plus', name: 'QSFP+', note: 'wide cage, four lanes · no bail', Glyph: QsfpPlus },
  { kind: 'lc', name: 'LC', note: 'two ferrules · on the patch panel', Glyph: Lc },
  { kind: 'c14', name: 'C14', note: 'hex inlet, three pins · power', Glyph: C14 },
];

/** Faceplate zoom is the Legend's true size. RJ45 pitch on the Faceplate
 * board is 36 units, and the smallest hit target in `design/tokens.css` is
 * `--row-min` 24px, so ports first become hittable at 24 / 36 ≈ 0.67. */
const ZOOMS: { label: string; scale: number; note: string }[] = [
  { label: 'First hit', scale: 0.67, note: 'where ports fade in: 24px pitch' },
  { label: 'Faceplate', scale: 1, note: 'true size, as the Legend and Faceplate boards draw it' },
  { label: 'Geometry', scale: 3, note: 'the Legend’s 3× enlargement, to read the shape' },
];

function Pair({ Glyph, scale }: { Glyph: (p: PortGlyphProps) => JSX.Element; scale: number }) {
  return (
    <span className="gallery__pair">
      <Glyph cabled scale={scale} />
      <Glyph cabled={false} scale={scale} />
    </span>
  );
}

export function PortGallery() {
  return (
    <div className="gallery">
      <header className="gallery__mast">
        <span className="gallery__brand">Fathom</span>
        <span className="gallery__crumb">
          Port glyphs · <strong>five, one size</strong> · filled = cabled, hollow = free · ink only
        </span>
        <span className="gallery__spacer" />
        <ThemeToggle />
      </header>

      {ZOOMS.map(({ label, scale, note }) => (
        <section className="gallery__band" key={label}>
          <div className="gallery__head">
            <div className="gallery__label">{scale.toFixed(2)}×</div>
            <div className="gallery__title">{label}</div>
            <div className="gallery__note">{note}</div>
          </div>
          <div className="gallery__body">
            {GLYPHS.map(({ kind, name, note: n, Glyph }) => (
              <div className="gallery__cell" key={kind}>
                <div className="gallery__name">{name}</div>
                <div className="gallery__glyphs">
                  <Pair Glyph={Glyph} scale={scale} />
                </div>
                <div className="gallery__cap">{n}</div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="gallery__band">
        <div className="gallery__head">
          <div className="gallery__label">1.00×</div>
          <div className="gallery__title">On a plate</div>
          <div className="gallery__note">the two cages as neighbours, at the Faceplate board&rsquo;s 36-unit pitch</div>
        </div>
        <div className="gallery__body">
          <div className="gallery__plate">
            <SfpPlus cabled title="xe-0/2/0" />
            <SfpPlus cabled={false} title="xe-0/2/1" />
            <SfpPlus cabled title="xe-0/2/2" />
            <SfpPlus cabled={false} title="xe-0/2/3" />
            <span className="gallery__gap" />
            <QsfpPlus cabled title="et-0/1/0" />
            <QsfpPlus cabled={false} title="et-0/1/1" />
            <QsfpPlus cabled={false} title="et-0/1/2" />
            <QsfpPlus cabled title="et-0/1/3" />
          </div>
          <div className="gallery__cap">4 × SFP+ · 4 × QSFP+ — a Juniper EX4300-48P rear, as the catalogue records it</div>
        </div>
      </section>

      <section className="gallery__band">
        <div className="gallery__head">
          <div className="gallery__label">0.67×</div>
          <div className="gallery__title">In isolation</div>
          <div className="gallery__note">
            one glyph alone in a box, nothing beside it to compare a width against. This is the test the brief sets.
          </div>
        </div>
        <div className="gallery__body gallery__body--isolation">
          {[
            { Glyph: SfpPlus, cabled: true, name: 'SFP+, cabled' },
            { Glyph: QsfpPlus, cabled: false, name: 'QSFP+, free' },
            { Glyph: QsfpPlus, cabled: true, name: 'QSFP+, cabled' },
            { Glyph: SfpPlus, cabled: false, name: 'SFP+, free' },
          ].map(({ Glyph, cabled, name }) => (
            <div className="gallery__island" key={name}>
              <Glyph cabled={cabled} scale={0.67} />
              <div className="gallery__cap">{name}</div>
            </div>
          ))}
        </div>
      </section>

      <footer className="gallery__foot">
        Shapes of the first four are the Legend board&rsquo;s. The fifth answers &ldquo;Not yet drawn — the QSFP+
        glyph&rdquo; in <code>docs/UI-SPEC.md</code>; the Legend board and the spec are the lead&rsquo;s to update.
      </footer>
    </div>
  );
}
