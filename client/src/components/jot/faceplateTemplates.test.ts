import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/faceplateTemplates', () => ({
  fetchTemplates: vi.fn(),
  createTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));

import { createTemplate, fetchTemplates } from '../../api/faceplateTemplates';

import { addSketchPortRange } from '../../document/commands';
import { emptyDocument } from '../../document/model';
import { placePorts } from '../../document/plate';
import { viewOf, type PortView } from '../../document/view';
import { addFreeBoxDoc, addFreeBoxFromTemplateDoc } from '../racks/freeActions';
import {
  captureTemplate,
  loadOrganisationTemplates,
  organisationTemplates,
  parseTemplates,
  resetTemplateStoreForTests,
  storeKey,
  withTemplate,
  withoutTemplate,
} from './faceplateTemplates';
import { deviceChassis } from './jotLayout';

const port = (over: Partial<PortView>): PortView => ({
  id: 'physicalport:x',
  label: '1',
  connector: 'rj45',
  row: 0,
  column: 0,
  uplink: false,
  role: null,
  face: 'front',
  passThroughId: null,
  cable: null,
  ...over,
});

describe('faceplate templates', () => {
  it('captures only hand-typed ports, with service, face and plate spot', () => {
    const t = captureTemplate('t1', '  Keystone 24 ', {
      role: 'switch',
      ports: [
        port({ id: 'a', label: '1', plate: { x: 120, y: 333 }, service: 'ethernet' }),
        port({ id: 'b', label: 'U1', rowKind: 'top' }),
        port({ id: 'c', label: 'P', connector: 'c14', face: 'rear', service: 'nonsense' }),
        port({ id: 'd', label: 'odd', connector: '' }),
      ],
    });
    expect(t).toEqual({
      id: 't1',
      name: 'Keystone 24',
      role: 'switch',
      ports: [
        { label: '1', connector: 'rj45', face: 'front', service: 'ethernet', plate: { x: 120, y: 333 } },
        { label: 'P', connector: 'c14', face: 'rear' },
        { label: 'odd', connector: 'other', face: 'front' },
      ],
    });
  });

  it('reads what is stored defensively', () => {
    const good = { id: 'a', name: 'A', role: null, ports: [{ label: '1', connector: 'rj45', face: 'front' }] };
    const raw = JSON.stringify([good, { id: 'b', name: 'B', ports: [{ label: 1 }] }, 'junk', { id: 'c', name: 'C', role: 7, ports: [] }]);
    expect(parseTemplates(raw)).toEqual([good, { id: 'c', name: 'C', role: null, ports: [] }]);
    expect(parseTemplates('{not json')).toEqual([]);
    expect(parseTemplates(null)).toEqual([]);
  });

  it('keeps one template per name, deletes by id, and keys the store by account', () => {
    const a = { id: 'a', name: 'Panel', role: null, ports: [] };
    const b = { id: 'b', name: 'Panel', role: null, ports: [] };
    const list = withTemplate(withTemplate([], a), b);
    expect(list.map((t) => t.id)).toEqual(['b']);
    expect(withoutTemplate(list, 'b')).toEqual([]);
    expect(storeKey('acct-1')).not.toBe(storeKey('acct-2'));
    expect(storeKey(null)).toBe('fathom.faceplateTemplates.anon');
  });

  it('round-trips: a box saved as a template starts a new box with the same faceplate, in one undo step', () => {
    const a = addFreeBoxDoc(emptyDocument(), 'switch', 0, 0, undefined);
    const typed = addSketchPortRange(a.doc, a.chassisId, { labelPrefix: 'k', first: 1, last: 3, connector: 'rj45', face: 'front' });
    const first = deviceChassis(viewOf(typed, []), a.chassisId)!.ports.find((p) => p.label === 'k1')!;
    const arranged = placePorts(typed, a.chassisId, [{ portId: first.id, x: 250, y: 750 }]);
    const source = deviceChassis(viewOf(arranged, []), a.chassisId)!;
    const t = captureTemplate('t', 'Mine', source);

    const made = addFreeBoxFromTemplateDoc(arranged, t, 400, 0, a.chassisId);
    expect(made.doc.batches.length).toBe(arranged.batches.length + 1);
    const copy = deviceChassis(viewOf(made.doc, []), made.chassisId)!;
    const shape = (ps: readonly PortView[]) => ps.map((p) => [p.label, p.connector, p.face, p.plate ?? null]).sort();
    expect(shape(copy.ports)).toEqual(shape(source.ports.filter((p) => p.rowKind === undefined)));
    expect(copy.role).toBe('switch');
    expect(viewOf(made.doc, []).lines).toHaveLength(1);
  });
});

describe('faceplate templates on the server', () => {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const ports = [{ label: '1', connector: 'rj45', face: 'front' as const }];

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage);
    store.clear();
    vi.mocked(fetchTemplates).mockReset();
    vi.mocked(createTemplate).mockReset();
    resetTemplateStoreForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends this browser's templates up once, then clears the browser copy", async () => {
    store.set(storeKey('acc'), JSON.stringify([{ id: 'local1', name: 'Keystone 24', role: null, ports }]));
    vi.mocked(fetchTemplates).mockResolvedValueOnce([{ id: 's1', name: 'Shared', role: 'switch', ports, createdBy: 'other' }]);
    vi.mocked(createTemplate).mockResolvedValueOnce({ id: 's2', name: 'Keystone 24', role: null, ports, createdBy: 'acc' });
    await loadOrganisationTemplates('o1', 'acc');
    expect(createTemplate).toHaveBeenCalledWith('o1', { name: 'Keystone 24', role: null, ports });
    const { templates, error } = organisationTemplates('o1');
    expect(error).toBeNull();
    expect(templates.map((t) => [t.id, t.createdBy])).toEqual([
      ['s1', 'other'],
      ['s2', 'acc'],
    ]);
    expect(store.has(storeKey('acc'))).toBe(false);
  });

  it('a template already on the server is not sent twice', async () => {
    store.set(storeKey('acc'), JSON.stringify([{ id: 'local1', name: 'Keystone 24', role: null, ports }]));
    vi.mocked(fetchTemplates).mockResolvedValueOnce([{ id: 's2', name: 'Keystone 24', role: null, ports, createdBy: 'acc' }]);
    await loadOrganisationTemplates('o1', 'acc');
    expect(createTemplate).not.toHaveBeenCalled();
    expect(store.has(storeKey('acc'))).toBe(false);
  });

  it('one the server refuses stays in the browser and says so', async () => {
    store.set(storeKey('acc'), JSON.stringify([{ id: 'local1', name: 'Keystone 24', role: null, ports }]));
    vi.mocked(fetchTemplates).mockResolvedValueOnce([]);
    vi.mocked(createTemplate).mockRejectedValueOnce(new Error('refused'));
    await loadOrganisationTemplates('o1', 'acc');
    expect(store.has(storeKey('acc'))).toBe(true);
    expect(organisationTemplates('o1').error).toMatch(/could not be moved/);
  });

  it('a server answer with a damaged port drops that template, never trusts it', async () => {
    vi.mocked(fetchTemplates).mockResolvedValueOnce([
      { id: 's1', name: 'Good', role: null, ports, createdBy: 'acc' },
      { id: 's2', name: 'Bad', role: null, ports: [{ label: 1 }] as never, createdBy: 'acc' },
    ]);
    await loadOrganisationTemplates('o1', 'acc');
    expect(organisationTemplates('o1').templates.map((t) => t.id)).toEqual(['s1']);
  });
});
