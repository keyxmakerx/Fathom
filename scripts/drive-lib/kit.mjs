// The pieces every browser drive repeated: the PASS/FAIL line, waiting for the server to
// answer, and the TOTP code a drive types at sign-in. One copy here; a drive imports what it uses.
import { webcrypto } from 'node:crypto';
import { inflateSync } from 'node:zlib';

/** The names of the checks that failed, in order. A drive exits non-zero when this is not empty. */
export const fails = [];

export function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) fails.push(name);
}

/** Whether two things on the page lie over each other: `over` is true when their boxes share any area, and `said`
 * gives both boxes for the line a failed check prints. `null` when either is not on the page. */
export async function lieOver(page, a, b) {
  return page.evaluate(
    ([a, b]) => {
      const box = (sel) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return r != null && r.width > 0 && r.height > 0 ? r : null;
      };
      const p = box(a);
      const q = box(b);
      if (p == null || q == null) return null;
      const say = (r) => `${Math.round(r.left)}..${Math.round(r.right)} across, ${Math.round(r.top)}..${Math.round(r.bottom)} down`;
      return { over: p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom, said: `${say(p)} and ${say(q)}` };
    },
    [a, b],
  );
}

/** The pixels of a PNG as the browser writes a screenshot: 8 bits a channel, RGB or RGBA, not interlaced. */
function pngPixels(png) {
  let width = 0;
  let height = 0;
  let channels = 0;
  const packed = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6) || body[12] !== 0) {
        throw new Error(`a PNG this does not read: depth ${body[8]}, colour type ${body[9]}, interlace ${body[12]}`);
      }
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      packed.push(body);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(packed));
  const stride = width * channels;
  const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? data[row + x - channels] : 0;
      const up = y > 0 ? data[row - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[row - stride + x - channels] : 0;
      let guess = 0;
      if (filter === 1) guess = left;
      else if (filter === 2) guess = up;
      else if (filter === 3) guess = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        guess = a <= b && a <= c ? left : b <= c ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`a PNG row filter this does not read: ${filter}`);
      }
      data[row + x] = (raw[line + x] + guess) & 0xff;
    }
  }
  return { width, height, channels, data };
}

/** How far two pictures of one size are apart: the mean difference of a colour channel, 0 to 255. */
function meanDifference(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('two pictures of different sizes');
  let sum = 0;
  for (let i = 0; i < a.width * a.height; i += 1) {
    for (let c = 0; c < 3; c += 1) sum += Math.abs(a.data[i * a.channels + c] - b.data[i * b.channels + c]);
  }
  return Math.round((sum / (a.width * a.height * 3)) * 100) / 100;
}

const STRIPES = ['repeating-linear-gradient(90deg, #000 0 2px, #fff 2px 4px)', 'repeating-linear-gradient(90deg, #fff 0 2px, #000 2px 4px)'];

/** How much of what lies behind a frosted thing can be told through it.
 *
 * Fine stripes are laid over `behind` (the drawing) and a picture is taken of the part of `frosted` that lies over
 * them. The stripes are moved by their own width and a second picture is taken. `through` is how far apart the two
 * are: near 0 when the stripes are blurred to one tone, their contrast when they show sharp. `control` is the same
 * with the thing's own blur turned off: it says the stripes are behind the thing at all. `null` when the two do
 * not lie over each other.
 *
 * The computed `backdrop-filter` does not say this. The blur can be there and see only what its own layer drew.
 */
export async function seenThrough(page, frosted, behind) {
  // Whatever is still arriving has arrived: a thing part way through its own fade shows the page through itself.
  await page.evaluate(() => {
    const ending = document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
    return Promise.race([Promise.allSettled(ending.map((a) => a.finished)), new Promise((done) => setTimeout(done, 3000))]);
  });
  const clip = await page.evaluate(
    ([frosted, behind]) => {
      const p = document.querySelector(frosted)?.getBoundingClientRect();
      const q = document.querySelector(behind)?.getBoundingClientRect();
      if (p == null || q == null) return null;
      // Inside the thing's edge: a rounded corner leaves the page sharp outside its curve.
      const inset = 8;
      const x = Math.ceil(Math.max(p.left + inset, q.left, 0));
      const y = Math.ceil(Math.max(p.top + inset, q.top, 0));
      const width = Math.floor(Math.min(p.right - inset, q.right, window.innerWidth)) - x;
      const height = Math.floor(Math.min(p.bottom - inset, q.bottom, window.innerHeight)) - y;
      return width >= 16 && height >= 16 ? { x, y, width, height } : null;
    },
    [frosted, behind],
  );
  if (clip == null) return null;
  const lay = (stripes) =>
    page.evaluate(
      ([behind, stripes]) => {
        let el = document.getElementById('drive-stripes');
        if (stripes == null) {
          el?.remove();
          return null;
        }
        if (el == null) {
          el = document.createElement('div');
          el.id = 'drive-stripes';
          // Over the drawing's own layers and under its panels (React Flow keeps those at 5).
          Object.assign(el.style, { position: 'absolute', inset: '0', zIndex: '4', pointerEvents: 'none' });
          document.querySelector(behind).appendChild(el);
        }
        el.style.background = stripes;
        return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null))));
      },
      [behind, stripes],
    );
  const blur = (off) =>
    page.evaluate(
      ([frosted, off]) => {
        const el = document.querySelector(frosted);
        for (const property of ['backdrop-filter', '-webkit-backdrop-filter']) {
          if (off) el.style.setProperty(property, 'none', 'important');
          else el.style.removeProperty(property);
        }
      },
      [frosted, off],
    );
  const told = async () => {
    const pictures = [];
    for (const stripes of STRIPES) {
      await lay(stripes);
      pictures.push(pngPixels(await page.screenshot({ clip, scale: 'css' })));
    }
    return meanDifference(pictures[0], pictures[1]);
  };
  try {
    const through = await told();
    await blur(true);
    const control = await told();
    return { through, control };
  } finally {
    await blur(false);
    await lay(null);
  }
}

/** True once `url` answers 2xx, false after `timeoutMs`. */
export async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, as an authenticator app reads a TOTP secret. */
export function base32Decode(text) {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const c of clean) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new Error(`not RFC 4648 base32: ${JSON.stringify(c)}`);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** The six-digit RFC 6238 code for `step` (seconds since 1970 / 30). */
export async function totpCode(secretBytes, step) {
  const key = await webcrypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step), false);
  const tag = new Uint8Array(await webcrypto.subtle.sign('HMAC', key, counter));
  const offset = tag[tag.length - 1] & 0x0f;
  const binary =
    ((tag[offset] & 0x7f) << 24) | (tag[offset + 1] << 16) | (tag[offset + 2] << 8) | tag[offset + 3];
  return String(binary % 1000000).padStart(6, '0');
}
