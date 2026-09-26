import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from './commands';
import {
  DockerRefusalError,
  addContainer,
  addContainerNetwork,
  addPublishedPort,
  attachContainerToNetwork,
  detachContainerFromNetwork,
  removeContainer,
  removeContainerNetwork,
  removePublishedPort,
} from './docker';
import { edgesIn, edgesOut, emptyDocument, findNode, parseNodeId, type Document } from './model';
import { undo } from './undo';

const NOW = 1_700_000_000_000;

function deviceWithPorts(labels: readonly string[]): { doc: Document; deviceId: string; chassisId: string; portIds: string[] } {
  let doc = createSketchDevice(emptyDocument(), { now: NOW });
  const deviceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const portIds: string[] = [];
  for (const label of labels) {
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = addSketchPort(doc, chassisId, { label, connector: 'rj45', face: 'front' }, { now: NOW });
    const added = doc.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!;
    portIds.push(added.id);
  }
  return { doc, deviceId, chassisId, portIds };
}

function containerNetworkIdOf(doc: Document, deviceId: string): string {
  return edgesOut(doc, deviceId, 'HasContainerNetwork')[0]!.to;
}

function containerNetworkIdByName(doc: Document, deviceId: string, name: string): string {
  for (const e of edgesOut(doc, deviceId, 'HasContainerNetwork')) {
    const n = findNode(doc, e.to);
    if (n && n.fields['ContainerNetwork.name']?.value === name) return e.to;
  }
  throw new Error(`no ContainerNetwork named "${name}" on "${deviceId}"`);
}

function containerIdOf(doc: Document, deviceId: string): string {
  return edgesOut(doc, deviceId, 'HasContainer')[0]!.to;
}

describe('addContainerNetwork', () => {
  it('writes a bridge ContainerNetwork on its host, batch labelled for the trail', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const next = addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge', subnets: ['172.18.0.0/16'] }, { now: NOW });
    const cnId = containerNetworkIdOf(next, deviceId);
    const node = findNode(next, cnId)!;
    expect(node.fields['ContainerNetwork.name']?.value).toBe('app_net');
    expect(node.fields['ContainerNetwork.driver']?.value).toBe('bridge');
    expect(node.fields['ContainerNetwork.subnet']?.value).toEqual(['172.18.0.0/16']);
    expect(next.batches.at(-1)!.label).toBe('add Docker network app_net');
  });

  it('a macvlan network writes ParentUnit to the parent interface, creating it from a bare port', () => {
    const { doc, deviceId, portIds } = deviceWithPorts(['eth1']);
    const next = addContainerNetwork(
      doc,
      { hostDeviceId: deviceId, name: 'iot_mac', driver: 'macvlan', parent: { kind: 'port', portId: portIds[0], interfaceName: 'eth1' } },
      { now: NOW },
    );
    const cnId = containerNetworkIdOf(next, deviceId);
    const pu = edgesOut(next, cnId, 'ParentUnit')[0];
    expect(pu).toBeDefined();
    expect(parseNodeId(pu!.to).kind).toBe('LogicalUnit');
  });

  it('refuses an empty network name', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() => addContainerNetwork(doc, { hostDeviceId: deviceId, name: '', driver: 'bridge' }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('accepts a network name with a space or non-ASCII text — Text, not Identifier (dockerd itself refuses only empty)', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const next = addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'front end · café', driver: 'bridge' }, { now: NOW });
    const cnId = containerNetworkIdOf(next, deviceId);
    expect(findNode(next, cnId)!.fields['ContainerNetwork.name']?.value).toBe('front end · café');
  });

  it.each(['bridge', 'host', 'none'])('accepts %s as a recorded network name — dockerd refuses only CREATING a second one, not recording one', (name) => {
    const { doc, deviceId } = deviceWithPorts([]);
    const next = addContainerNetwork(doc, { hostDeviceId: deviceId, name, driver: name as 'bridge' | 'host' | 'none' }, { now: NOW });
    const cnId = containerNetworkIdOf(next, deviceId);
    expect(findNode(next, cnId)!.fields['ContainerNetwork.name']?.value).toBe(name);
  });

  it('refuses a name that is blank after trimming, not only the empty string', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() => addContainerNetwork(doc, { hostDeviceId: deviceId, name: '   ', driver: 'bridge' }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('refuses a name made only of U+0085 (NEL) — one of Go\'s TrimSpace whitespace runes, not JavaScript\'s', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() => addContainerNetwork(doc, { hostDeviceId: deviceId, name: '\u0085', driver: 'bridge' }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('accepts a name made only of U+FEFF (BOM) — JavaScript\'s trim() treats it as whitespace, Go\'s TrimSpace does not', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const next = addContainerNetwork(doc, { hostDeviceId: deviceId, name: '﻿', driver: 'bridge' }, { now: NOW });
    expect(findNode(next, containerNetworkIdOf(next, deviceId))!.fields['ContainerNetwork.name']?.value).toBe('﻿');
  });

  it('refuses a name that is not well-formed Unicode (a lone surrogate)', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() => addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'broken\uD800name', driver: 'bridge' }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it.each(['container', 'container:app_net', 'default'])('refuses "%s" — a name no Docker network can carry', (name) => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() => addContainerNetwork(doc, { hostDeviceId: deviceId, name, driver: 'bridge' }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('refuses a gateway outside every subnet given', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() =>
      addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge', subnets: ['172.18.0.0/16'], gateways: ['10.0.0.1'] }, { now: NOW }),
    ).toThrow(DockerRefusalError);
  });

  it('accepts a gateway inside the stated subnet', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const next = addContainerNetwork(
      doc,
      { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge', subnets: ['172.18.0.0/16'], gateways: ['172.18.0.1'] },
      { now: NOW },
    );
    expect(findNode(next, containerNetworkIdOf(next, deviceId))!.fields['ContainerNetwork.gateway']?.value).toEqual(['172.18.0.1']);
  });

  it('refuses a duplicate network name on the same device', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const once = addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge' }, { now: NOW });
    expect(() => addContainerNetwork(once, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge' }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('refuses macvlan/ipvlan with no parent', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() => addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'iot_mac', driver: 'macvlan' }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('refuses a parent given for a driver other than macvlan/ipvlan', () => {
    const { doc, deviceId, portIds } = deviceWithPorts(['eth1']);
    expect(() =>
      addContainerNetwork(
        doc,
        { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge', parent: { kind: 'port', portId: portIds[0], interfaceName: 'eth1' } },
        { now: NOW },
      ),
    ).toThrow(DockerRefusalError);
  });

  it('refuses a parent that resolves to a different host', () => {
    const first = deviceWithPorts([]);
    const second = deviceWithPorts(['eth1']);
    const doc: Document = {
      ...emptyDocument(),
      nodes: [...first.doc.nodes, ...second.doc.nodes],
      edges: [...first.doc.edges, ...second.doc.edges],
      provenance: [...first.doc.provenance, ...second.doc.provenance],
      batches: [...first.doc.batches, ...second.doc.batches],
    };
    expect(() =>
      addContainerNetwork(
        doc,
        { hostDeviceId: first.deviceId, name: 'iot_mac', driver: 'macvlan', parent: { kind: 'port', portId: second.portIds[0], interfaceName: 'eth1' } },
        { now: NOW },
      ),
    ).toThrow(DockerRefusalError);
  });

  it('refuses a subnet with host bits', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() => addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge', subnets: ['172.18.0.5/16'] }, { now: NOW })).toThrow(
      DockerRefusalError,
    );
  });

  it('refuses an unknown host device', () => {
    const { doc } = deviceWithPorts([]);
    expect(() => addContainerNetwork(doc, { hostDeviceId: 'device:00000000000000000000000000', name: 'app_net', driver: 'bridge' }, { now: NOW })).toThrow(
      DockerRefusalError,
    );
  });

  it('does not mutate its input on a refusal', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const before = JSON.stringify(doc);
    expect(() => addContainerNetwork(doc, { hostDeviceId: deviceId, name: '', driver: 'bridge' }, { now: NOW })).toThrow();
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('removeContainerNetwork', () => {
  it('refuses while a container is attached', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const withNet = addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge' }, { now: NOW });
    const withContainer = addContainer(withNet, { hostDeviceId: deviceId, name: 'gitea' }, { now: NOW });
    const cnId = containerNetworkIdOf(withContainer, deviceId);
    const containerId = containerIdOf(withContainer, deviceId);
    const attached = attachContainerToNetwork(withContainer, { container: { kind: 'existing', containerId }, networkId: cnId, address: '172.18.0.3/16' }, { now: NOW });
    expect(() => removeContainerNetwork(attached, cnId, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('removes the network once nothing is attached', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const withNet = addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge' }, { now: NOW });
    const cnId = containerNetworkIdOf(withNet, deviceId);
    const next = removeContainerNetwork(withNet, cnId, { now: NOW });
    expect(findNode(next, cnId)!.absentSince).toBeDefined();
    expect(edgesOut(next, deviceId, 'HasContainerNetwork')).toHaveLength(0);
  });
});

describe('addContainer / removeContainer', () => {
  it('writes a bare Container on its host', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const next = addContainer(doc, { hostDeviceId: deviceId, name: 'gitea' }, { now: NOW });
    const containerId = containerIdOf(next, deviceId);
    expect(findNode(next, containerId)!.fields['Container.name']?.value).toBe('gitea');
  });

  it('refuses a name that is not an Identifier', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() => addContainer(doc, { hostDeviceId: deviceId, name: 'has spaces' }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('refuses a duplicate container name on the same device', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const once = addContainer(doc, { hostDeviceId: deviceId, name: 'gitea' }, { now: NOW });
    expect(() => addContainer(once, { hostDeviceId: deviceId, name: 'gitea' }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('removeContainer cascades its AttachedTo edges and PublishedPort children', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const withNet = addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge' }, { now: NOW });
    const withContainer = addContainer(withNet, { hostDeviceId: deviceId, name: 'gitea' }, { now: NOW });
    const cnId = containerNetworkIdOf(withContainer, deviceId);
    const containerId = containerIdOf(withContainer, deviceId);
    const attached = attachContainerToNetwork(withContainer, { container: { kind: 'existing', containerId }, networkId: cnId, address: '172.18.0.3/16' }, { now: NOW });
    const published = addPublishedPort(attached, { containerId, protocol: 'tcp', containerPort: 3000, hostPort: 3000 }, { now: NOW });
    const ppId = edgesOut(published, containerId, 'HasPublishedPort')[0]!.to;

    const next = removeContainer(published, containerId, { now: NOW });
    expect(findNode(next, containerId)!.absentSince).toBeDefined();
    expect(findNode(next, ppId)!.absentSince).toBeDefined();
    expect(edgesOut(next, containerId, 'AttachedTo').filter((e) => e.absentSince === undefined)).toHaveLength(0);
    // the network itself is untouched
    expect(findNode(next, cnId)!.absentSince).toBeUndefined();
  });
});

describe('attachContainerToNetwork / detachContainerFromNetwork', () => {
  function bridgeWithContainer() {
    const { doc, deviceId } = deviceWithPorts([]);
    const withNet = addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge' }, { now: NOW });
    const withContainer = addContainer(withNet, { hostDeviceId: deviceId, name: 'gitea' }, { now: NOW });
    return { doc: withContainer, deviceId, cnId: containerNetworkIdOf(withContainer, deviceId), containerId: containerIdOf(withContainer, deviceId) };
  }

  it('writes AttachedTo with the address', () => {
    const { doc, cnId, containerId } = bridgeWithContainer();
    const next = attachContainerToNetwork(doc, { container: { kind: 'existing', containerId }, networkId: cnId, address: '172.18.0.3/16' }, { now: NOW });
    const edge = edgesOut(next, containerId, 'AttachedTo')[0]!;
    expect(edge.to).toBe(cnId);
    expect(edge.fields['AttachedTo.address']?.value).toEqual(['172.18.0.3/16']);
  });

  it('refuses a second attach of the same pair', () => {
    const { doc, cnId, containerId } = bridgeWithContainer();
    const once = attachContainerToNetwork(doc, { container: { kind: 'existing', containerId }, networkId: cnId }, { now: NOW });
    expect(() => attachContainerToNetwork(once, { container: { kind: 'existing', containerId }, networkId: cnId }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('refuses attaching across hosts unless the driver is overlay', () => {
    const host = deviceWithPorts([]);
    const withNet = addContainerNetwork(host.doc, { hostDeviceId: host.deviceId, name: 'app_net', driver: 'bridge' }, { now: NOW });
    const other = deviceWithPorts([]);
    const doc: Document = {
      ...emptyDocument(),
      nodes: [...withNet.nodes, ...other.doc.nodes],
      edges: [...withNet.edges, ...other.doc.edges],
      provenance: [...withNet.provenance, ...other.doc.provenance],
      batches: [...withNet.batches, ...other.doc.batches],
    };
    const withContainer = addContainer(doc, { hostDeviceId: other.deviceId, name: 'gitea' }, { now: NOW });
    const cnId = containerNetworkIdByName(withContainer, host.deviceId, 'app_net');
    const containerId = containerIdOf(withContainer, other.deviceId);
    expect(() => attachContainerToNetwork(withContainer, { container: { kind: 'existing', containerId }, networkId: cnId }, { now: NOW })).toThrow(DockerRefusalError);

    const overlayNet = addContainerNetwork(withContainer, { hostDeviceId: host.deviceId, name: 'ov', driver: 'overlay' }, { now: NOW });
    const overlayId = containerNetworkIdByName(overlayNet, host.deviceId, 'ov');
    expect(() => attachContainerToNetwork(overlayNet, { container: { kind: 'existing', containerId }, networkId: overlayId }, { now: NOW })).not.toThrow();
  });

  it('refuses a bad address', () => {
    const { doc, cnId, containerId } = bridgeWithContainer();
    expect(() => attachContainerToNetwork(doc, { container: { kind: 'existing', containerId }, networkId: cnId, address: 'not-an-ip' }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('refuses an address outside the network\'s own subnet', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const withNet = addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge', subnets: ['172.18.0.0/16'] }, { now: NOW });
    const withContainer = addContainer(withNet, { hostDeviceId: deviceId, name: 'gitea' }, { now: NOW });
    const cnId = containerNetworkIdOf(withContainer, deviceId);
    const containerId = containerIdOf(withContainer, deviceId);
    expect(() =>
      attachContainerToNetwork(withContainer, { container: { kind: 'existing', containerId }, networkId: cnId, address: '10.0.0.5/16' }, { now: NOW }),
    ).toThrow(DockerRefusalError);
  });

  it('refuses the same address on a second container of the same network', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const withNet = addContainerNetwork(doc, { hostDeviceId: deviceId, name: 'app_net', driver: 'bridge' }, { now: NOW });
    const withA = addContainer(withNet, { hostDeviceId: deviceId, name: 'gitea' }, { now: NOW });
    const cnId = containerNetworkIdOf(withA, deviceId);
    const aId = containerIdOf(withA, deviceId);
    const attachedA = attachContainerToNetwork(withA, { container: { kind: 'existing', containerId: aId }, networkId: cnId, address: '172.18.0.3/16' }, { now: NOW });
    expect(() =>
      attachContainerToNetwork(attachedA, { container: { kind: 'new', hostDeviceId: deviceId, name: 'grafana' }, networkId: cnId, address: '172.18.0.3/16' }, { now: NOW }),
    ).toThrow(DockerRefusalError);
  });

  it('detach tombstones only the AttachedTo edge', () => {
    const { doc, cnId, containerId } = bridgeWithContainer();
    const attached = attachContainerToNetwork(doc, { container: { kind: 'existing', containerId }, networkId: cnId, address: '172.18.0.3/16' }, { now: NOW });
    const edgeId = edgesOut(attached, containerId, 'AttachedTo')[0]!.id;
    const next = detachContainerFromNetwork(attached, edgeId, { now: NOW });
    expect(edgesOut(next, containerId, 'AttachedTo').filter((e) => e.absentSince === undefined)).toHaveLength(0);
    expect(findNode(next, containerId)!.absentSince).toBeUndefined();
    expect(findNode(next, cnId)!.absentSince).toBeUndefined();
  });

  it('names a new container and attaches it in one batch — undo leaves no container at all', () => {
    const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const { doc, deviceId, cnId } = bridgeWithContainer(); // already carries "gitea"; this attach names a second, "grafana"
    const before = doc.batches.length;
    const attached = attachContainerToNetwork(
      doc,
      { container: { kind: 'new', hostDeviceId: deviceId, name: 'grafana' }, networkId: cnId, address: '172.18.0.4/16' },
      { actor: ACTOR, now: NOW },
    );
    expect(attached.batches.length).toBe(before + 1); // one batch, not two

    const batchId = attached.batches.at(-1)!.id;
    const undone = undo(attached, batchId, { actor: ACTOR, now: NOW + 1 });
    // undo revives exactly what the batch touched, so no Container node named
    // "grafana" survives, live or tombstoned-and-orphaned.
    const grafanaNodes = undone.nodes.filter((n) => parseNodeId(n.id).kind === 'Container' && n.fields['Container.name']?.value === 'grafana');
    expect(grafanaNodes).toHaveLength(0);
  });

  it('attaches an existing container to a second network', () => {
    const { doc, deviceId, cnId, containerId } = bridgeWithContainer();
    const firstAttach = attachContainerToNetwork(doc, { container: { kind: 'existing', containerId }, networkId: cnId, address: '172.18.0.3/16' }, { now: NOW });
    const secondNet = addContainerNetwork(firstAttach, { hostDeviceId: deviceId, name: 'db_net', driver: 'bridge' }, { now: NOW });
    const secondNetId = containerNetworkIdByName(secondNet, deviceId, 'db_net');
    const both = attachContainerToNetwork(secondNet, { container: { kind: 'existing', containerId }, networkId: secondNetId, address: '172.19.0.2/16' }, { now: NOW });
    const attachments = edgesOut(both, containerId, 'AttachedTo').filter((e) => e.absentSince === undefined);
    expect(attachments).toHaveLength(2);
    expect(attachments.map((e) => e.to).sort()).toEqual([cnId, secondNetId].sort());
  });

  it('detach, then the container can still be found and removed', () => {
    const { doc, cnId, containerId } = bridgeWithContainer();
    const attached = attachContainerToNetwork(doc, { container: { kind: 'existing', containerId }, networkId: cnId, address: '172.18.0.3/16' }, { now: NOW });
    const edgeId = edgesOut(attached, containerId, 'AttachedTo')[0]!.id;
    const detached = detachContainerFromNetwork(attached, edgeId, { now: NOW });
    // still there, still live, findable by exactly the same id
    expect(findNode(detached, containerId)!.absentSince).toBeUndefined();
    const removed = removeContainer(detached, containerId, { now: NOW });
    expect(findNode(removed, containerId)!.absentSince).toBeDefined();
  });
});

describe('addPublishedPort / removePublishedPort', () => {
  function withContainer() {
    const { doc, deviceId } = deviceWithPorts([]);
    const withContainer = addContainer(doc, { hostDeviceId: deviceId, name: 'gitea' }, { now: NOW });
    return { doc: withContainer, containerId: containerIdOf(withContainer, deviceId) };
  }

  it('writes protocol, container_port and host_port', () => {
    const { doc, containerId } = withContainer();
    const next = addPublishedPort(doc, { containerId, protocol: 'tcp', containerPort: 3000, hostPort: 3000 }, { now: NOW });
    const ppId = edgesOut(next, containerId, 'HasPublishedPort')[0]!.to;
    const node = findNode(next, ppId)!;
    expect(node.fields['PublishedPort.protocol']?.value).toBe('6');
    expect(node.fields['PublishedPort.container_port']?.value).toBe('3000');
    expect(node.fields['PublishedPort.host_port']?.value).toBe('3000');
  });

  it('accepts udp and sctp', () => {
    const { doc, containerId } = withContainer();
    const udp = addPublishedPort(doc, { containerId, protocol: 'udp', containerPort: 53 }, { now: NOW });
    const sctp = addPublishedPort(udp, { containerId, protocol: 'sctp', containerPort: 9 }, { now: NOW });
    expect(edgesOut(sctp, containerId, 'HasPublishedPort')).toHaveLength(2);
  });

  it('refuses a port outside 1..65535', () => {
    const { doc, containerId } = withContainer();
    expect(() => addPublishedPort(doc, { containerId, protocol: 'tcp', containerPort: 0 }, { now: NOW })).toThrow(DockerRefusalError);
    expect(() => addPublishedPort(doc, { containerId, protocol: 'tcp', containerPort: 70_000 }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('refuses a duplicate published port', () => {
    const { doc, containerId } = withContainer();
    const once = addPublishedPort(doc, { containerId, protocol: 'tcp', containerPort: 80, hostPort: 8080 }, { now: NOW });
    expect(() => addPublishedPort(once, { containerId, protocol: 'tcp', containerPort: 80, hostPort: 8080 }, { now: NOW })).toThrow(DockerRefusalError);
  });

  it('removePublishedPort tombstones the node and its edge', () => {
    const { doc, containerId } = withContainer();
    const withPort = addPublishedPort(doc, { containerId, protocol: 'tcp', containerPort: 80, hostPort: 8080 }, { now: NOW });
    const ppId = edgesOut(withPort, containerId, 'HasPublishedPort')[0]!.to;
    const next = removePublishedPort(withPort, ppId, { now: NOW });
    expect(findNode(next, ppId)!.absentSince).toBeDefined();
    expect(edgesIn(next, ppId, 'HasPublishedPort').filter((e) => e.absentSince === undefined)).toHaveLength(0);
  });
});
