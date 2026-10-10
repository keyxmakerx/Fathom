import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { connectPorts } from '../../document/cables';
import { setDeviceField } from '../../document/edit';
import { addEdge, addNode, begin, finish } from '../../document/freeform';
import { emptyDocument, findNode, text, token } from '../../document/model';
import { WHY_RULES, affectedLines, alsoAffected, buildChain, orList, portWord } from './chain';
import { addBox, eth, lab, tick } from './fixtures';

describe('buildChain', () => {
  it('walks power, others on the switch, link, port, address, gateway, nearest first', () => {
    const l = lab();
    const chain = buildChain(l.doc, l.nas.device);
    expect(chain.deviceName).toBe('nas-01');
    expect(chain.steps.map((s) => s.topic)).toEqual(['power', 'neighbours', 'link', 'port', 'address', 'gateway']);
    const [power, others, link, port, address, gateway] = chain.steps;
    expect(power.question).toBe('Is nas-01 getting power from PDU-A outlet 4?');
    expect(others.question).toBe('Are the others on sw-02 working (fw-01, pc-04)?');
    expect(link.question).toBe('Link light on sw-02 port 23?');
    expect(link.detail).toBe('Cable 0412, red, to nas-01 eth0');
    expect(port.question).toBe('Is port 23 on sw-02 enabled and in VLAN 20?');
    expect(address.question).toBe('Does 10.0.20.15 answer?');
    expect(gateway.question).toBe('Is the gateway fw-01 (10.0.20.1) working?');
    expect(chain.steps.every((s) => s.known)).toBe(true);
  });

  it('targets what each step is about, ready to light', () => {
    const l = lab();
    const [power, others, link] = buildChain(l.doc, l.nas.device).steps;
    expect(power.targets).toEqual(expect.arrayContaining([l.nas.device, l.pdu.port('4'), l.pdu.device, l.nas.port('PSU')]));
    expect(others.targets).toEqual(expect.arrayContaining([l.sw.device, l.pc.device]));
    expect(link.targets).toEqual(expect.arrayContaining([l.cable, l.sw.port('23'), l.nas.port('eth0'), l.sw.device]));
    for (const s of buildChain(l.doc, l.nas.device).steps) expect(new Set(s.targets).size).toBe(s.targets.length);
  });

  it("says Fathom doesn't know what powers a device with no power link, and still asks", () => {
    const l = lab({ power: false });
    const [power] = buildChain(l.doc, l.nas.device).steps;
    expect(power.topic).toBe('power');
    expect(power.question).toBe('Is nas-01 getting power?');
    expect(power.detail).toContain("Fathom doesn't know what powers nas-01.");
    expect(power.known).toBe(false);
    expect(power.suspects.length).toBeGreaterThan(0);
  });

  it("says Fathom doesn't know what the device is cabled to when it has no data cable", () => {
    const l = lab({ uplink: false });
    const chain = buildChain(l.doc, l.nas.device);
    const link = chain.steps.find((s) => s.topic === 'link')!;
    expect(link.question).toBe("Is there a link light on nas-01's network port?");
    expect(link.detail).toContain("Fathom doesn't know what nas-01 is cabled to.");
    expect(link.known).toBe(false);
    expect(chain.steps.map((s) => s.topic)).not.toContain('neighbours');
    expect(chain.steps.map((s) => s.topic)).not.toContain('port');
  });

  it("says Fathom doesn't know the address or the gateway when the graph holds neither", () => {
    const l = lab({ network: false });
    const chain = buildChain(l.doc, l.nas.device);
    const at = (t: string) => chain.steps.find((s) => s.topic === t)!;
    expect(at('address').question).toBe('Does nas-01 answer?');
    expect(at('address').detail).toContain("Fathom doesn't know nas-01's address.");
    expect(at('gateway').question).toBe('Can nas-01 reach other networks?');
    expect(at('gateway').detail).toContain("Fathom doesn't know nas-01's gateway.");
    // No step is a statement: every title is a question.
    for (const s of chain.steps) expect(s.question.endsWith('?')).toBe(true);
    // The port step still asks, and says it holds no VLAN for it.
    const port = chain.steps.find((s) => s.topic === 'port')!;
    expect(port.question).toBe('Is port 23 on sw-02 enabled?');
    expect(port.detail).toContain('no VLAN');
  });

  it("offers Tie ports at the port step when the switch's pasted interfaces are not tied", () => {
    const l = lab({ network: false });
    expect(buildChain(l.doc, l.nas.device).steps.find((s) => s.topic === 'port')!.tie).toBeUndefined();
    const b = begin(l.doc, tick());
    const iface = addNode(b, 'Interface', { 'Interface.name': text('ge-0/0/22'), 'Interface.form': token('ethernet') });
    addEdge(b, 'HasInterface', l.sw.device, iface);
    const port = buildChain(finish(b, 'paste'), l.nas.device).steps.find((s) => s.topic === 'port')!;
    expect(port.tie).toBe(l.sw.device);
    expect(port.detail).toContain("sw-02's pasted interfaces are not tied to a port.");
  });

  it('reads a management address when no subnet holds the device', () => {
    const l = lab({ network: false });
    const doc = setDeviceField(l.doc, l.nas.device, 'management_address', '10.0.20.15', tick());
    expect(buildChain(doc, l.nas.device).steps.find((s) => s.topic === 'address')!.question).toBe('Does 10.0.20.15 answer?');
  });

  it('puts the single-fed rule beside the power step when one of two inlets is cabled', () => {
    let doc = emptyDocument();
    const made = addBox(doc, 'srv-01', [{ label: 'PSU 1', connector: 'c14', service: 'power' }, { label: 'PSU 2', connector: 'c14', service: 'power' }]);
    doc = made.doc;
    const pdu = addBox(doc, 'PDU-B', [{ label: '1', connector: 'c13', service: 'power' }]);
    doc = connectPorts(pdu.doc, pdu.box.port('1'), made.box.port('PSU 1'), {}, tick());
    const [power] = buildChain(doc, made.box.device).steps;
    expect(power.why).toContain(WHY_RULES['power.psu.single-fed']);
    expect(power.detail).toContain('second inlet');
  });

  it('gives every step a Why? from the checks where one matches, else a fixed sentence', () => {
    const l = lab();
    const chain = buildChain(l.doc, l.nas.device);
    for (const s of chain.steps) expect(s.why.length).toBeGreaterThan(0);
    expect(chain.steps.find((s) => s.topic === 'link')!.why).toContain(WHY_RULES['phy.link.speed-mismatch']);
    expect(chain.steps.find((s) => s.topic === 'port')!.why).toContain(WHY_RULES['l2.vlan.access-mismatch']);
    expect(chain.steps.find((s) => s.topic === 'address')!.why).toContain(WHY_RULES['ip.address.same-on-link']);
  });

  it('names the parts that would be suspect and tests that tell them apart', () => {
    const l = lab();
    const link = buildChain(l.doc, l.nas.device).steps.find((s) => s.topic === 'link')!;
    expect(link.suspects.map((s) => s.label)).toEqual(['the cable', 'port 23 on sw-02']);
    expect(link.suspects.map((s) => s.id)).toEqual([l.cable, l.sw.port('23')]);
    expect(link.tests[0]).toMatch(/^Try nas-01 on a free port \(sw-02 has \d+\)$/);
    expect(link.tests).toContain('Try another cable between them');
  });

  it('follows a cable through a patch panel to the device behind it', () => {
    // nas-01 eth0 -> panel port 1 (the same hole as port 2) -> sw-02 port 3.
    let doc = emptyDocument();
    const nas = addBox(doc, 'nas-01', [{ label: 'eth0', connector: 'rj45' }]);
    const sw = addBox(nas.doc, 'sw-02', eth(4));
    const b = begin(sw.doc, tick());
    const panel = addNode(b, 'PassiveNode', { 'PassiveNode.label': text('Panel 1'), 'PassiveNode.form': token('patch_panel') });
    const port = (label: string): string => {
      const id = addNode(b, 'PhysicalPort', { 'PhysicalPort.label': text(label), 'PhysicalPort.connector': token('rj45'), 'PhysicalPort.face': token('front') });
      addEdge(b, 'HasPort', panel, id);
      return id;
    };
    const p1 = port('1');
    const p2 = port('2');
    addEdge(b, 'PassThrough', p1, p2);
    doc = finish(b, 'panel');
    doc = connectPorts(doc, nas.box.port('eth0'), p1, {}, tick());
    doc = connectPorts(doc, p2, sw.box.port('3'), {}, tick());
    const link = buildChain(doc, nas.box.device).steps.find((s) => s.topic === 'link')!;
    expect(link.question).toBe('Link light on sw-02 port 3?');
    expect(link.detail).toContain('through Panel 1');
    expect(link.targets).toEqual(expect.arrayContaining([panel, p1, p2, sw.box.port('3')]));
  });

  it('is the same for a device with nothing recorded at all', () => {
    const made = addBox(emptyDocument(), 'lone-01', []);
    const chain = buildChain(made.doc, made.box.device);
    expect(chain.steps.map((s) => s.topic)).toEqual(['power', 'link', 'address', 'gateway']);
    expect(chain.steps.every((s) => !s.known)).toBe(true);
  });
});

describe('alsoAffected', () => {
  it('says what a device powers and what has no other cable than the one to it', () => {
    const l = lab();
    expect(alsoAffected(l.doc, l.pdu.device)).toEqual([{ id: l.nas.device, name: 'nas-01', how: 'is powered from it' }]);
    expect(alsoAffected(l.doc, l.sw.device).map((a) => [a.name, a.how])).toEqual([
      ['fw-01', 'has no other cable'],
      ['nas-01', 'has no other cable'],
      ['pc-04', 'has no other cable'],
    ]);
  });

  it('leaves out a neighbour that has another way, and says nothing depends on the device', () => {
    const l = lab();
    // sw-02 has other cables, so it does not depend on nas-01.
    expect(alsoAffected(l.doc, l.nas.device)).toEqual([]);
    expect(affectedLines('nas-01', [])).toEqual(['Nothing else depends on nas-01.']);
  });

  it('writes one line per way', () => {
    expect(
      affectedLines('sw-02', [
        { id: 'p', name: 'srv-01', how: 'is powered from it' },
        { id: 'a', name: 'nas-01', how: 'has no other cable' },
        { id: 'b', name: 'pc-04', how: 'has no other cable' },
      ]),
    ).toEqual(['srv-01 is powered from sw-02.', 'nas-01, pc-04 have no other cable.']);
  });
});

describe('words', () => {
  it('says a numbered port as "port 23" and a named one as it is', () => {
    expect(portWord('23')).toBe('port 23');
    expect(portWord('eth0')).toBe('eth0');
    expect(portWord('')).toBe('a port');
    expect(orList(['the cable', 'port 23 on sw-02'])).toBe('the cable or port 23 on sw-02');
    expect(orList(['a', 'b', 'c'])).toBe('a, b or c');
  });
});

describe('the Why? texts are the Checks rules word for word', () => {
  const rulesDir = fileURLToPath(new URL('../../../../corpus/rules/', import.meta.url));
  const folded = (id: string): string => {
    const raw = readFileSync(`${rulesDir}${id}/rule.yaml`, 'utf8');
    const lines = raw.split('\n');
    const at = lines.findIndex((l) => l.startsWith('why:'));
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (!l.startsWith(' ')) break;
      body.push(l.trim());
    }
    return body.join(' ');
  };
  for (const [id, text] of Object.entries(WHY_RULES)) {
    it(id, () => {
      expect(text).toBe(folded(id));
    });
  }
  it('finds the node for a known hostname', () => {
    const l = lab();
    expect(findNode(l.doc, l.nas.device)).toBeDefined();
  });
});
