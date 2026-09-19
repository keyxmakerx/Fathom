import type { CSSProperties } from 'react';

// This build's own rule for a name in a list: it never shrinks, and it
// clips in the middle rather than at either end, so the distinguishing tail
// of a long name survives even in a narrow column. Plain CSS `text-overflow`
// only ever ellipses one end, so this splits the text into a shrinkable
// head (CSS ellipsis) and a fixed-width tail shown in full — two spans in a
// flex row, no library, no new dependency.

const WRAP_STYLE: CSSProperties = {
  display: 'flex',
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

/** How many trailing characters always survive, in full, past the ellipsis. */
const TAIL_CHARS = 6;

export function MiddleClip({ text }: { text: string }) {
  if (text.length <= TAIL_CHARS + 1) {
    return <span style={WRAP_STYLE}>{text}</span>;
  }
  const head = text.slice(0, text.length - TAIL_CHARS);
  const tail = text.slice(text.length - TAIL_CHARS);
  return (
    <span style={WRAP_STYLE} title={text}>
      <span style={HEAD_STYLE}>{head}</span>
      <span style={TAIL_STYLE}>{tail}</span>
    </span>
  );
}
