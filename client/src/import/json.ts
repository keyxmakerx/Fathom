// JSON from a file we did not write. The whole text is scanned for depth and size first (no
// recursion, so nesting cannot reach the stack), then parsed, then walked with a stack of our own.

import { LIMITS, ImportRefusal } from './limits';
import { clip, stripUnsafe } from './text';

/** Refuses nesting past the depth cap or more brackets and commas than the token cap. */
export function scanJson(text: string): void {
  let depth = 0;
  let tokens = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i += 1;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      depth += 1;
      tokens += 1;
      if (depth > LIMITS.jsonDepth) throw new ImportRefusal(`This JSON is nested more than ${LIMITS.jsonDepth} levels deep, which no export from these tools is.`);
    } else if (c === 0x7d || c === 0x5d) depth -= 1;
    else if (c === 0x2c) tokens += 1;
    if (tokens > LIMITS.jsonTokens) throw new ImportRefusal('This JSON holds far more entries than a device list; it was not read.');
  }
}

export function parseJson(text: string): unknown {
  scanJson(text);
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportRefusal('This file is not valid JSON.');
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const LABEL_KEYS = ['name', 'label', 'display', 'value', 'slug', 'address', 'model'];

function scalar(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '';
  return null;
}

/** What an object in a list stands for (a NetBox tag or role): its name, label or the like. */
function labelOf(v: unknown): string | null {
  const s = scalar(v);
  if (s !== null) return s;
  if (isObject(v)) {
    for (const k of LABEL_KEYS) {
      const x = Object.hasOwn(v, k) ? scalar(v[k]) : null;
      if (x) return x;
    }
  }
  return null;
}

const MAX_KEYS = 400;

/**
 * One record as dotted-path keys to text: nested objects flatten (`device_type.model`), a list
 * becomes its items' names joined by ", ", and a NetBox choice `{value,label}` becomes its value.
 * `skip` drops a path (internal ids and links).
 */
export function flatten(record: Record<string, unknown>, skip: (path: string) => boolean = () => false): Map<string, string> {
  const out = new Map<string, string>();
  const stack: Array<[string, unknown]> = [['', record]];
  while (stack.length > 0 && out.size < MAX_KEYS) {
    const [path, value] = stack.pop()!;
    if (path !== '' && skip(path)) continue;
    const s = scalar(value);
    if (s !== null) {
      out.set(path, s);
    } else if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value.slice(0, 200)) {
        const l = labelOf(item);
        if (l) parts.push(l);
      }
      out.set(path, parts.join(', '));
    } else if (isObject(value)) {
      const keys = Object.keys(value);
      if (path !== '' && keys.length === 2 && keys.includes('value') && keys.includes('label') && scalar(value.value) !== null) {
        out.set(path, scalar(value.value) ?? '');
        continue;
      }
      // Reverse so the first key is popped first and the columns keep the file's order.
      for (const k of keys.reverse()) {
        const key = clip(stripUnsafe(k).replace(/\s+/g, ' ').trim(), 100);
        if (key === '') continue;
        stack.push([path === '' ? key : `${path}.${key}`, value[k]]);
      }
    }
  }
  return out;
}
