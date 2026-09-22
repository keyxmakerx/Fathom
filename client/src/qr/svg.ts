// A QR symbol as SVG geometry.
//
// ADR-0056 decision 5 puts the code on the page as inline SVG. That rules out
// three shapes this could have taken, and the reason is the
// Content-Security-Policy decision 7 refuses to move: an `<img src>` would
// need a host in `img-src`, a `data:` URI would need `img-src data:`, and a
// `<canvas>` turned into one needs the same. A `<path>` in the document needs
// nothing: it is markup, not a resource.
//
// The colours are not here — they are two classes in `styles/authenticator.css`
// — but the quiet zone is, because it is geometry. ISO/IEC 18004 §9.1 puts a
// four-module light margin around the symbol and a reader may fail without it.
//
// Written 2026-09-22.

/** ISO/IEC 18004 §9.1: four modules of light on every side. */
export const QR_QUIET_ZONE = 4;

/**
 * One `<path>` `d` for every dark module, with the quiet zone as the offset.
 *
 * Runs of dark modules along a row become one rectangle rather than one each:
 * a version-10 symbol is 3,249 modules and the path is drawn on every render
 * of the enrolment screen.
 */
export function qrPath(modules: readonly (readonly boolean[])[], quiet = QR_QUIET_ZONE): string {
  const parts: string[] = [];
  for (let y = 0; y < modules.length; y += 1) {
    const row = modules[y];
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < row.length && row[x + run]) run += 1;
      parts.push(`M${x + quiet} ${y + quiet}h${run}v1h-${run}z`);
      x += run;
    }
  }
  return parts.join('');
}

/** The side of the drawing in modules, symbol plus both quiet zones. */
export function qrSide(size: number, quiet = QR_QUIET_ZONE): number {
  return size + quiet * 2;
}
