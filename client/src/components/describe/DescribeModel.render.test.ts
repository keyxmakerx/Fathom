import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Palette } from '../drawing/Palette';
import { describePorts, layoutFaceplate } from '../drawing/faceplate';
import type { PortView } from '../../document/view';
import { parseTemplates } from '../jot/faceplateTemplates';
import { DescribeModel } from './DescribeModel';

const noop = () => {};

describe('Not here? Describe it', () => {
  it('is offered under the equipment list, and only when there is somewhere to put the device', () => {
    const palette = [{ vendor: 'ubiquiti', model: 'USW-Lite-8-PoE', rackUnits: 1, summary: '8 RJ45' }];
    expect(renderToStaticMarkup(createElement(Palette, { palette, onDescribe: noop }))).toContain('Not here? Describe it');
    expect(renderToStaticMarkup(createElement(Palette, { palette }))).not.toContain('Not here? Describe it');
  });

  it('lists kept models first, under Your models', () => {
    const markup = renderToStaticMarkup(
      createElement(Palette, { palette: [{ vendor: 'x', model: 'y', rackUnits: 1, summary: '' }], yours: [{ id: 'a', name: 'NUC 13', summary: '4 ports · front, left side' }], onPickYours: noop }),
    );
    expect(markup).toContain('Your models');
    expect(markup).toContain('NUC 13');
    expect(markup.indexOf('NUC 13')).toBeLessThan(markup.indexOf('>y<'));
  });

  it('starts as the mockup does, with the name from the search and a drawn front plate', () => {
    const markup = renderToStaticMarkup(createElement(DescribeModel, { initialName: 'usw lite', onCancel: noop, onUse: noop }));
    expect(markup).toContain('value="usw lite"');
    expect(markup).toContain('Preview: 8 Copper');
    for (const face of ['Front', 'Rear', 'Left', 'Right', 'Top']) expect(markup).toContain(`>${face}</option>`);
    expect(markup).toContain('Use this model');
    expect(markup).toContain('Keep it in Your models');
  });

  it('keeps side and top ports in a saved template', () => {
    const raw = JSON.stringify([{ id: 'a', name: 'NUC', role: null, ports: [{ label: '1', connector: 'rj45', face: 'top' }, { label: '2', connector: 'rj45', face: 'left' }] }]);
    expect(parseTemplates(raw)[0]!.ports.map((p) => p.face)).toEqual(['top', 'left']);
    const bad = JSON.stringify([{ id: 'a', name: 'NUC', role: null, ports: [{ label: '1', connector: 'rj45', face: 'bottom' }] }]);
    expect(parseTemplates(bad)).toEqual([]);
  });
});

function port(id: string, face: PortView['face']): PortView {
  return { id, label: id, connector: 'rj45', row: 0, column: 0, uplink: false, role: null, face, passThroughId: null, cable: null };
}

describe('a box drawn whole', () => {
  it('keeps each face its own cluster, unfolded left, front, top, right, rear', () => {
    const ports = [port('1', 'front'), port('2', 'left'), port('3', 'top'), port('4', 'rear'), port('5', 'right')];
    const layout = layoutFaceplate(ports, 2, 'nuc');
    const x = (id: string) => layout.byId.get(id)!.x;
    expect(x('2')).toBeLessThan(x('1'));
    expect(x('1')).toBeLessThan(x('3'));
    expect(x('3')).toBeLessThan(x('5'));
    expect(x('5')).toBeLessThan(x('4'));
  });

  it('says which face in words', () => {
    const ports = [port('1', 'front'), port('2', 'left'), port('3', 'top')];
    const lines = describePorts(ports, layoutFaceplate(ports, 2, 'nuc'));
    expect(lines.some((l) => l.endsWith('on the left side'))).toBe(true);
    expect(lines.some((l) => l.endsWith('on top'))).toBe(true);
  });
});
