import { describe, expect, it } from 'vitest';

import { parseEstate, parseFar, type EstateHit, type FarAnswer } from '../../api/estate';
import type { SiteLink } from '../../document/siteLinks';
import type { ChecksResult } from '../../engine/engine';
import { farPortWords, linkCandidates, siteLinkChange, siteLinkLabel } from '../drawing/SiteLink';
import { siteLinkFindings, withSiteLinkFindings } from './siteLinkChecks';

const HERE = 'design-west';
const link: SiteLink = {
  peerId: 'external-peer:1',
  cableId: 'cable:1',
  nearPortId: 'physical-port:near',
  label: 'DC East · core-sw-02',
  far: { design: 'design-east', element: 'physical-port:far' },
};
const answer = (over: Partial<FarAnswer>): FarAnswer => ({
  design: 'design-east',
  element: 'physical-port:far',
  state: 'here',
  designName: 'DC East',
  device: 'core-sw-02',
  port: 'xe-0/0/1',
  back: { design: HERE, element: 'physical-port:near' },
  ...over,
});

describe('the Check for links between sites', () => {
  it('says nothing when both ends name each other', () => {
    expect(siteLinkFindings([link], [answer({})], HERE)).toEqual([]);
  });

  it('warns when the far port has gone', () => {
    const [f] = siteLinkFindings([link], [answer({ state: 'gone', back: null, device: '', port: '' })], HERE);
    expect(f?.severity).toBe('warn');
    expect(f?.title).toBe('The far end of this link is gone from DC East');
    expect(f?.elements[0]?.id).toBe('cable:1');
  });

  it('notes a one-sided link, and one whose far end points elsewhere', () => {
    const [none] = siteLinkFindings([link], [answer({ back: null })], HERE);
    expect(none?.title).toBe("This link is one-sided: core-sw-02 xe-0/0/1 in DC East doesn't point back");
    expect(none?.fix).toBe('Open DC East and link that port back to this one.');
    const [other] = siteLinkFindings([link], [answer({ back: { design: HERE, element: 'physical-port:other' } })], HERE);
    expect(other?.fix).toBe('Open DC East: that port links somewhere else.');
  });

  it('says nothing about a far end it cannot see', () => {
    expect(siteLinkFindings([link], [answer({ state: 'closed' }), answer({ state: 'behind' })], HERE)).toEqual([]);
    expect(siteLinkFindings([link], [], HERE)).toEqual([]);
  });

  it('adds its findings to the engine result and counts them', () => {
    const base: ChecksResult = { refuse: 0, warn: 1, idea: 0, rulesLoaded: 3, loadFailed: false, unfinished: 0, findings: [] };
    const extra = siteLinkFindings([link], [answer({ state: 'gone' })], HERE);
    expect(withSiteLinkFindings(base, extra)).toMatchObject({ warn: 2, findings: extra });
    expect(withSiteLinkFindings(null, extra)).toBeNull();
    expect(withSiteLinkFindings(base, [])).toBe(base);
  });
});

describe('the server answers', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  it('reads far ends, and anything unexpected as closed', () => {
    const got = parseFar(enc({ ends: [{ design: 'd', element: 'e', state: 'here', designName: 'DC', device: 'sw', port: 'p1', back: ['x', 'y'] }, { design: 'd2', element: 'e2', state: '??' }] }));
    expect(got[0]).toEqual({ design: 'd', element: 'e', state: 'here', designName: 'DC', device: 'sw', port: 'p1', back: { design: 'x', element: 'y' } });
    expect(got[1]?.state).toBe('closed');
    expect(got[1]?.back).toBeNull();
  });

  it('reads a device row with its ports', () => {
    const { hits } = parseEstate(enc({ hits: [{ design: 'd', element: 'device:1', kind: 'device', name: 'sw', ports: [{ id: 'p1', name: 'Et1', farDesign: 'x', farElement: 'y' }, { id: 'p2', name: 'Et2' }] }] }));
    expect(hits[0]?.ports).toEqual([
      { id: 'p1', name: 'Et1', far: { design: 'x', element: 'y' } },
      { id: 'p2', name: 'Et2' },
    ]);
  });
});

describe('picking the far port', () => {
  const hit = (over: Partial<EstateHit>): EstateHit => ({
    design: 'design-east',
    designName: 'DC East',
    element: 'device:1',
    open: 'chassis:1',
    kind: 'device',
    name: 'core-sw-02',
    model: '',
    serial: '',
    device: '',
    place: '',
    addresses: [],
    ports: [{ id: 'physical-port:far', name: 'xe-0/0/1' }],
    ...over,
  });

  it('names the link for the far site and device', () => {
    expect(siteLinkLabel(hit({}))).toBe('DC East · core-sw-02');
    expect(siteLinkLabel(hit({ designName: null, name: '' }))).toBe('Another site');
  });

  it('offers only devices with ports in other designs', () => {
    const offered = linkCandidates([hit({}), hit({ design: HERE }), hit({ kind: 'optic' }), hit({ ports: [] })], HERE);
    expect(offered).toHaveLength(1);
  });

  it('stores the far ids and the label, nothing else', () => {
    const h = hit({});
    expect(siteLinkChange('physical-port:near', h, h.ports[0]!)).toEqual({
      kind: 'cable-link-site',
      portId: 'physical-port:near',
      label: 'DC East · core-sw-02',
      far: { design: 'design-east', element: 'physical-port:far' },
    });
  });

  it('says when a far port is already linked', () => {
    expect(farPortWords({ id: 'p', name: 'Et1', far: { design: 'x', element: 'y' } })).toBe('Et1 · already linked');
    expect(farPortWords({ id: 'p', name: '' })).toBe('Unnamed port');
  });
});
