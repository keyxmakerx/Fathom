// XML for an nmap scan (-oX). Nothing with a DTD is parsed: any entity or element declaration,
// and any DOCTYPE other than nmap's own bare `<!DOCTYPE nmaprun>`, is refused before the browser's
// parser sees the text, and nmap's bare one is cut out first. So there is nothing for an external
// entity (XXE) or an entity-expansion bomb to use.

import { LIMITS, ImportRefusal } from './limits';

export interface XEl {
  tag: string;
  attrs: ReadonlyMap<string, string>;
  children: XEl[];
  /** Text directly inside, not including children's. */
  text: string;
}

export type XmlParser = (xml: string) => XEl;

/** The text to hand to a parser, or a refusal. */
export function checkXml(raw: string): string {
  let xml = raw.replace(/^\uFEFF/, '');
  const at = xml.search(/<!DOCTYPE/i);
  if (at >= 0) {
    const bare = /^<!DOCTYPE\s+nmaprun\s*>/.exec(xml.slice(at));
    if (!bare) throw new ImportRefusal('This XML declares a document type or entities, which is refused. A plain nmap -oX file does not.');
    xml = xml.slice(0, at) + xml.slice(at + bare[0].length);
  }
  // Anything left that opens with "<!" other than a comment or CDATA is a declaration.
  if (/<!(?!--|\[CDATA\[)/.test(xml)) {
    throw new ImportRefusal('This XML declares a document type or entities, which is refused. A plain nmap -oX file does not.');
  }
  let opens = 0;
  for (let i = xml.indexOf('<'); i >= 0; i = xml.indexOf('<', i + 1)) {
    opens += 1;
    if (opens > LIMITS.xmlElements * 2) throw new ImportRefusal('This XML has far more elements than an nmap scan; it was not read.');
  }
  return xml;
}

/** The browser's own DOMParser, copied into plain objects with a stack of our own. */
export const domXmlParser: XmlParser = (xml) => {
  if (typeof DOMParser === 'undefined') throw new ImportRefusal('This browser cannot read XML files.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0 || !doc.documentElement) {
    throw new ImportRefusal('This is not well-formed XML.');
  }
  if (doc.getElementsByTagName('*').length > LIMITS.xmlElements) {
    throw new ImportRefusal('This XML has far more elements than an nmap scan; it was not read.');
  }
  const copy = (e: Element): XEl => {
    const attrs = new Map<string, string>();
    for (const a of Array.from(e.attributes)) attrs.set(a.name, a.value);
    let text = '';
    for (const n of Array.from(e.childNodes)) if (n.nodeType === 3 || n.nodeType === 4) text += n.nodeValue ?? '';
    return { tag: e.tagName, attrs, children: [], text };
  };
  const root = copy(doc.documentElement);
  const stack: Array<[Element, XEl]> = [[doc.documentElement, root]];
  while (stack.length > 0) {
    const [src, dst] = stack.pop()!;
    for (const child of Array.from(src.children)) {
      const c = copy(child);
      dst.children.push(c);
      stack.push([child, c]);
    }
  }
  return root;
};

export function parseXml(raw: string, parser: XmlParser = domXmlParser): XEl {
  const root = parser(checkXml(raw));
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const e = stack.pop()!;
    count += 1;
    if (count > LIMITS.xmlElements) throw new ImportRefusal('This XML has far more elements than an nmap scan; it was not read.');
    stack.push(...e.children);
  }
  return root;
}

export const kids = (e: XEl, tag: string): XEl[] => e.children.filter((c) => c.tag === tag);
export const kid = (e: XEl, tag: string): XEl | undefined => e.children.find((c) => c.tag === tag);
export const attr = (e: XEl | undefined, name: string): string => e?.attrs.get(name) ?? '';
