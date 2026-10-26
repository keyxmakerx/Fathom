// The glossary behind Why? cards (card nu-words A): the networking words those cards use, each with one plain line.
// A word can name an explainer in corpus/explainers/ for "Learn more": the general ones are the networking basics in
// corpus/explainers/network-basics.yaml.

export interface GlossaryEntry {
  /** The word as written, lower case; matched whole, any case, with a plural ending. */
  term: string;
  definition: string;
  /** An explainer `id` (corpus/explainers/) to offer as "Learn more". */
  explainer?: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: 'prefix',
    definition:
      'A network written as an address and a length, like 192.168.10.0/24. The /24 says the first 24 bits name the network, so it covers 192.168.10.0 to 192.168.10.255. A longer length is a smaller, more specific network.',
  },
  {
    term: 'preference',
    definition: 'How much a router trusts one route over another to the same network. The lower number wins. Cisco calls it administrative distance.',
  },
  {
    term: 'frame',
    definition: "One piece of data on an Ethernet link, addressed from one device's hardware (MAC) address to another's. Switches move frames; routers move the packets inside them.",
  },
  {
    term: 'vlan',
    definition:
      'A virtual LAN: one switch split into separate networks. Devices in different VLANs cannot reach each other directly. Traffic between them has to go through a router, and only a rule on that router can stop it.',
    explainer: 'explain:concept:basics.vlan',
  },
  { term: 'broadcast domain', definition: 'All the devices that hear a broadcast sent by any one of them. One VLAN is one broadcast domain.' },
  {
    term: 'trunk',
    definition: 'A port or cable that carries several VLANs at once, each frame tagged with its VLAN number.',
    explainer: 'explain:concept:basics.trunk',
  },
  {
    term: 'access port',
    definition: 'A switch port in exactly one VLAN, without tags. This is where a computer, camera or printer plugs in.',
    explainer: 'explain:concept:basics.access-port',
  },
  {
    term: 'gateway',
    definition: "The router a device sends traffic to when the far end is not on the device's own network. It is often the router's address ending in .1.",
  },
  { term: 'subnet', definition: 'One IP network, like 192.168.10.0/24. Devices on the same subnet reach each other directly; anything else goes through the gateway.' },
  {
    term: 'learned routes',
    definition:
      "Routes a device picks up while it runs, from DHCP or a routing protocol such as OSPF, instead of from its typed configuration. Fathom does not record them, so a trace cannot follow them. On a home network, usually only the router routes; a plain switch doesn't.",
  },
  { term: 'static route', definition: 'A route typed into the configuration by hand: "to reach this network, send it to that address".' },
  {
    term: 'zone',
    definition: 'A group of interfaces a firewall treats the same way, such as lan or cameras. Firewall rules are written from one zone to another.',
    explainer: 'explain:concept:basics.firewall-zones',
  },
  {
    term: 'line card',
    definition:
      'A board that slides into a slot in a modular device and carries ports of its own. Its ports go down when it is pulled. Cisco also calls them modules or NIMs; Juniper calls them FPCs and PICs.',
  },
  {
    term: 'optic',
    definition:
      'The small plug-in module (an SFP or QSFP) that turns a port into a fibre or copper connection. The port is the cage; the optic decides the speed, the fibre type and how far it reaches.',
  },
  { term: 'transceiver', definition: 'Another name for an optic: the module in a port that sends and receives on the fibre or copper.' },
  { term: 'sfp', definition: 'Small form-factor pluggable: the common optic for 1 Gb/s ports. SFP+ is the 10 Gb/s one and QSFP the wider one for 40 Gb/s and up.' },
];

/** The part after a port name, as in `port2.0` or `ge-0/0/1.0`. */
export const UNIT_ENTRY: GlossaryEntry = {
  term: 'unit',
  definition: 'The number after the dot is the logical unit: a numbered slice of a port, where its addresses and VLANs are set. Most ports have only unit 0.',
};

export type Piece = string | { text: string; entry: GlossaryEntry };

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UNIT = String.raw`[a-z][a-z0-9-]*\d(?:/\d+)*\.\d+`;
const PATTERN = new RegExp(
  String.raw`\b(?:(${[...GLOSSARY]
    .sort((a, b) => b.term.length - a.term.length)
    .map((e) => escape(e.term).replace(/ /g, String.raw`\s+`))
    .join('|')})(?:e?s)?|(${UNIT}))\b`,
  'gi',
);

/** `text` split into plain runs and glossary words, each word marked only the first time it appears. */
export function glossPieces(text: string, entries: readonly GlossaryEntry[] = GLOSSARY): Piece[] {
  const byTerm = new Map(entries.map((e) => [e.term, e]));
  const out: Piece[] = [];
  const seen = new Set<string>();
  let at = 0;
  for (const m of text.matchAll(PATTERN)) {
    const entry = m[1] !== undefined ? byTerm.get(m[1].toLowerCase().replace(/\s+/g, ' ')) : UNIT_ENTRY;
    if (entry === undefined || seen.has(entry.term)) continue;
    seen.add(entry.term);
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push({ text: m[0], entry });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
