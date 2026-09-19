import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

// This build's own rule for a name in a list: it never shrinks, and it
// clips in the middle rather than at either end, so the distinguishing tail
// of a long name survives even in a narrow column. Plain CSS `text-overflow`
// only ever ellipses one end, so this splits the text into a shrinkable
// head (CSS ellipsis) and a fixed-width tail shown in full — two spans in a
// flex row, no library, no new dependency.
//
// This session's brief item 5's second fix: the split used to run off
// `text.length` alone, so a short name in a wide column still got cut into
// head/tail even though the whole thing plainly fit — a middle "clip" with
// nothing to clip. The column's actual width was never consulted. Fixed by
// measuring: an always-present, off-screen probe span (`MEASURE_STYLE`)
// carries the same text at its natural, unwrapped width; `overflowing` is
// true only when that natural width exceeds the visible container's own —
// the split renders exactly then, never merely because the name happens to
// be long.

const WRAP_STYLE: CSSProperties = {
  display: 'flex',
  position: 'relative',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
};

const HEAD_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const TAIL_STYLE: CSSProperties = {
  flex: '0 0 auto',
  whiteSpace: 'nowrap',
};

const PLAIN_STYLE: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

/** Off-screen, unmeasured by layout (`position: absolute`, taken out of
 * flow) and invisible (`visibility: hidden`) — present purely so
 * `scrollWidth` reports the text's true, unwrapped width regardless of
 * whether the visible content beside it is currently the plain span or the
 * split head/tail. */
const MEASURE_STYLE: CSSProperties = {
  position: 'absolute',
  visibility: 'hidden',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  left: 0,
  top: 0,
};

/** How many trailing characters always survive, in full, past the ellipsis. */
const TAIL_CHARS = 6;

export function MiddleClip({ text }: { text: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  // Measured, not assumed: `overflowing` starts `false` and is corrected
  // before paint (`useLayoutEffect`, not `useEffect`) the first time this
  // mounts and again whenever the column is resized (`ResizeObserver` on the
  // container) or the text itself changes.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return undefined;
    function check() {
      if (!container || !measure) return;
      setOverflowing(measure.scrollWidth > container.clientWidth);
    }
    check();
    const observer = new ResizeObserver(check);
    observer.observe(container);
    return () => observer.disconnect();
  }, [text]);

  const split = overflowing && text.length > TAIL_CHARS + 1;
  const head = split ? text.slice(0, text.length - TAIL_CHARS) : text;
  const tail = split ? text.slice(text.length - TAIL_CHARS) : '';

  return (
    <span ref={containerRef} style={WRAP_STYLE} title={overflowing ? text : undefined}>
      <span ref={measureRef} aria-hidden="true" style={MEASURE_STYLE}>
        {text}
      </span>
      {split ? (
        <>
          <span style={HEAD_STYLE}>{head}</span>
          <span style={TAIL_STYLE}>{tail}</span>
        </>
      ) : (
        <span style={PLAIN_STYLE}>{text}</span>
      )}
    </span>
  );
}
