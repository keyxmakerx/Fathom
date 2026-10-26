// "Generate one": a password made in this browser from its own random source. No letters that read
// as each other (0/O, 1/l/I), so it survives being read off a screen into a console cable session.

const SETS = ['ABCDEFGHJKMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '-_.!@#%+=?'];
const ALL = SETS.join('');

function pick(set: string): string {
  // Rejection sampling, so every character is equally likely.
  const limit = 256 - (256 % set.length);
  for (;;) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b < limit) return set[b % set.length];
  }
}

/** `length` characters with at least one of each kind, which most device password rules ask for. */
export function generatePassword(length = 20): string {
  if (length < SETS.length) throw new Error('too short to hold one of each kind');
  for (;;) {
    const out = Array.from({ length }, () => pick(ALL)).join('');
    if (SETS.every((set) => [...out].some((c) => set.includes(c)))) return out;
  }
}
