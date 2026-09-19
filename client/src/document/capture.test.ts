import { describe, expect, it } from 'vitest';

import { captureOf } from './capture';
import { formatEdgeId, formatNodeId, type Document, type GraphEdge, type GraphNode, type ProvenanceRecord } from './model';
import { newUlid } from './ulid';

/** A byte range for `lines[idx]` inside `lines.join('\n')` — independent of
 * `capture.ts`'s own `splitByteLines`, computed by re-encoding the prefix,
 * so the test proves the derivation against UTF-8 byte offsets rather than
 * against its own implementation. */
function byteRange(lines: string[], idx: number): { start: number; end: number } {
  const enc = new TextEncoder();
  const prefix = lines.slice(0, idx).join('\n') + (idx > 0 ? '\n' : '');
  const start = enc.encode(prefix).length;
  const end = start + enc.encode(lines[idx]).length;
  return { start, end };
}

function handProv(id: string): ProvenanceRecord {
  return { id, origin: { kind: 'hand' }, assertedAt: 0, assertedBy: '00000000000000000000000000', confidence: 'asserted' };
}

function parsedProv(id: string, capture: string, span: { start: number; end: number }): ProvenanceRecord {
  return { id, origin: { kind: 'parsed', capture, span }, assertedAt: 0, assertedBy: '00000000000000000000000000', confidence: 'derived' };
}

describe('captureOf', () => {
  it('returns null when the device carries no live capture', () => {
    const deviceId = formatNodeId('Device', newUlid());
    const doc: Document = { nodes: [{ id: deviceId, existence: 'present', fields: {} }], edges: [], provenance: [], history: [], batches: [] };
    expect(captureOf(doc, deviceId)).toBeNull();
  });

  it('derives the gutter mark and builtLabel from provenance spans and <REDACTED:label> markers', () => {
    const deviceId = formatNodeId('Device', newUlid());
    // `rec.origin.capture` travels the wire as a bare ULID
    // (`crates/fathom-workspace/src/lib.rs`'s `provenance_to_json`), never
    // the formatted `capture:<ulid>` node id — `captureUlid` here, not
    // `captureId`, is what a `parsed` provenance record actually names.
    const captureUlid = newUlid();
    const captureId = formatNodeId('Capture', captureUlid);
    const hasCaptureId = formatEdgeId('HasCapture', newUlid());
    const interfaceId = formatNodeId('Interface', newUlid());

    const lines = [
      '# clean ünïcödé header, ignored',
      'set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/30',
      'set security ike policy IKE-POL pre-shared-key hexadecimal <REDACTED:psk>',
      'set snmp community <REDACTED:snmp-community> authorization read-only',
      'set system ntp server 10.10.0.9',
    ];
    const text = lines.join('\n');
    const line2 = byteRange(lines, 1);
    const line4 = byteRange(lines, 3);

    const device: GraphNode = { id: deviceId, existence: 'present', fields: {} };
    const capture: GraphNode = {
      id: captureId,
      existence: 'present',
      fields: {
        'Capture.text': { presence: 'set', prov: 'prov-hand', value: text },
        'Capture.platform': { presence: 'set', prov: 'prov-hand', value: 'junos-srx' },
      },
    };
    const iface: GraphNode = {
      id: interfaceId,
      existence: 'present',
      fields: {
        'Interface.name': { presence: 'set', prov: 'prov-iface-name', value: 'ge-0/0/0.0' },
        'Interface.admin_up': { presence: 'set', prov: 'prov-iface-admin', value: true },
      },
    };
    const hasCapture: GraphEdge = { id: hasCaptureId, from: deviceId, to: captureId, prov: 'prov-hand', fields: {} };

    const doc: Document = {
      nodes: [device, capture, iface],
      edges: [hasCapture],
      provenance: [handProv('prov-hand'), parsedProv('prov-iface-name', captureUlid, line2), parsedProv('prov-iface-admin', captureUlid, line4)],
      history: [],
      batches: [],
    };

    const view = captureOf(doc, deviceId);
    expect(view).not.toBeNull();
    expect(view!.id).toBe(captureId);
    expect(view!.platform).toBe('junos-srx');
    expect(view!.lines).toHaveLength(5);

    const [l1, l2, l3, l4, l5] = view!.lines;

    expect(l1.mark).toBe('kept');
    expect(l1.builtLabel).toBeNull();
    expect(l1.drops).toEqual([]);
    expect(l1.text).toContain('ünïcödé');

    expect(l2.mark).toBe('built');
    expect(l2.builtLabel).toBe('ge-0/0/0.0');
    expect(l2.drops).toEqual([]);

    expect(l3.mark).toBe('destroyed');
    expect(l3.builtLabel).toBeNull();
    expect(l3.drops).toEqual([{ start: 59, end: 73, label: 'psk' }]);

    // Built AND destroyed on one line: still `built` (ADR-0052 §2's "the
    // PSK line ... still binds"), with the drop carried alongside it.
    expect(l4.mark).toBe('built');
    expect(l4.drops).toHaveLength(1);
    expect(l4.drops[0].label).toBe('snmp-community');
    // The triggering field (`Interface.admin_up`) has no name of its own,
    // but its owner node does — `builtLabel` names the interface the line
    // touched, not the specific field.
    expect(l4.builtLabel).toBe('ge-0/0/0.0');

    expect(l5.mark).toBe('kept');
    expect(l5.drops).toEqual([]);
  });

  it('reads a built line off an edge\'s own existence, owner = the edge\'s `to` node', () => {
    const deviceId = formatNodeId('Device', newUlid());
    const captureUlid = newUlid();
    const captureId = formatNodeId('Capture', captureUlid);
    const hasCaptureId = formatEdgeId('HasCapture', newUlid());
    const zoneId = formatNodeId('Zone', newUlid());
    const bindId = formatEdgeId('BindsInterface', newUlid());

    const lines = ['set security zones security-zone trust interfaces ge-0/0/1.20'];
    const text = lines.join('\n');
    const line1 = byteRange(lines, 0);

    const device: GraphNode = { id: deviceId, existence: 'present', fields: {} };
    const capture: GraphNode = {
      id: captureId,
      existence: 'present',
      fields: {
        'Capture.text': { presence: 'set', prov: 'prov-hand', value: text },
        'Capture.platform': { presence: 'set', prov: 'prov-hand', value: 'junos-srx' },
      },
    };
    const zone: GraphNode = {
      id: zoneId,
      existence: 'present',
      fields: { 'Zone.name': { presence: 'set', prov: 'prov-hand', value: 'trust' } },
    };
    const hasCapture: GraphEdge = { id: hasCaptureId, from: deviceId, to: captureId, prov: 'prov-hand', fields: {} };
    const bind: GraphEdge = { id: bindId, from: deviceId, to: zoneId, prov: 'prov-bind', fields: {} };

    const doc: Document = {
      nodes: [device, capture, zone],
      edges: [hasCapture, bind],
      provenance: [handProv('prov-hand'), parsedProv('prov-bind', captureUlid, line1)],
      history: [],
      batches: [],
    };

    const view = captureOf(doc, deviceId);
    expect(view!.lines).toHaveLength(1);
    expect(view!.lines[0].mark).toBe('built');
    expect(view!.lines[0].builtLabel).toBe('trust');
  });
});
