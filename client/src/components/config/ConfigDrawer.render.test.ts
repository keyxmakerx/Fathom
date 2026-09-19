import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { CaptureLine, CaptureView } from '../../document/capture';
import type { ChassisView, PortView } from '../../document/view';
import { ConfigDrawer, type ConfigDrawerProps } from './ConfigDrawer';

// Render-to-string smoke tests only, per `ShelfPlate.render.test.ts`'s own
// precedent — no DOM testing library is installed, so hover/click are not
// exercised as events; this checks the markup the drawer produces for a
// given `capture`/`canDraw`/`refusal`, which is what a render-to-string pass
// can actually see.

function port(overrides: Partial<PortView> & Pick<PortView, 'id' | 'label'>): PortView {
  return {
    connector: 'RJ45',
    row: 0,
    column: 0,
    uplink: false,
    role: null,
    cable: null,
    face: 'front',
    passThroughId: null,
    ...overrides,
  };
}

function chassis(overrides: Partial<ChassisView> = {}): ChassisView {
  return {
    id: 'chassis-1',
    deviceId: 'device-1',
    hostname: 'hq-fw-01',
    model: 'SRX340',
    vendor: 'juniper',
    positionU: 40,
    heightU: 2,
    face: 'front',
    ports: [port({ id: 'port-1', label: 'ge-0/0/1' })],
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [],
    singleFed: false,
    oneFitted: false,
    placement: { kind: 'rack', rackId: 'rack-1', positionU: 40, face: 'front' },
    sketch: false,
    ...overrides,
  };
}

function line(overrides: Partial<CaptureLine> & Pick<CaptureLine, 'ordinal' | 'text' | 'mark'>): CaptureLine {
  return { builtLabel: null, drops: [], ...overrides };
}

function capture(lines: CaptureLine[], overrides: Partial<CaptureView> = {}): CaptureView {
  return { id: 'capture-1', platform: 'junos-srx', lineCount: lines.length, lines, ...overrides };
}

const noop = () => {};

function baseProps(overrides: Partial<ConfigDrawerProps> = {}): ConfigDrawerProps {
  return {
    chassis: chassis(),
    capture: null,
    canDraw: false,
    onPaste: noop,
    onLineHover: noop,
    onLineSelect: noop,
    refusal: null,
    ...overrides,
  };
}

function render(props: ConfigDrawerProps): string {
  return renderToStaticMarkup(createElement(ConfigDrawer, props));
}

describe('ConfigDrawer (render-to-string)', () => {
  it('draws the gutter legend', () => {
    const markup = render(baseProps());
    expect(markup).toContain('built graph');
    expect(markup).toContain('kept as text');
    expect(markup).toContain('destroyed at the gate');
  });

  it('prints the assistant\'s six rules verbatim from UI-SPEC "Config"', () => {
    const markup = render(baseProps());
    expect(markup).toContain('reads this config and this graph only');
    expect(markup).toContain('cites a line for every claim');
    expect(markup).toContain('cannot see a credential ever');
    expect(markup).toContain('never says permitted or denied');
    expect(markup).toContain('could not establish');
    expect(markup).toContain('never changes the estate');
  });

  it('shows no paste box when canDraw is false, even with a capture', () => {
    const markup = render(baseProps({ canDraw: false, capture: capture([line({ ordinal: 1, text: 'x', mark: 'kept' })]) }));
    expect(markup).not.toContain('config-drawer__paste-input');
    expect(markup).not.toContain('Paste');
  });

  it('shows the paste box when canDraw is true', () => {
    const markup = render(baseProps({ canDraw: true }));
    expect(markup).toContain('paste a config');
    expect(markup).toContain('Paste');
  });

  it('shows the empty state when there is no capture yet', () => {
    const markup = render(baseProps({ capture: null }));
    expect(markup).toContain('No config captured for this device yet.');
  });

  it('shows the refusal as a wash when the engine refuses, only alongside the paste box', () => {
    const markup = render(baseProps({ canDraw: true, refusal: 'This device already carries a live capture.' }));
    expect(markup).toContain('config-drawer__refusal');
    expect(markup).toContain('This device already carries a live capture.');
  });

  it('never shows a refusal when canDraw is false', () => {
    const markup = render(baseProps({ canDraw: false, refusal: 'should not appear' }));
    expect(markup).not.toContain('should not appear');
  });

  it('draws each gutter mark, the destroyed block reading "<label> · destroyed at the gate", and a built line\'s port match', () => {
    const lines: CaptureLine[] = [
      line({ ordinal: 1, text: 'set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/30', mark: 'built', builtLabel: 'ge-0/0/0.0' }),
      line({ ordinal: 2, text: 'set interfaces ge-0/0/1 unit 0 family inet address 10.0.0.2/30', mark: 'built', builtLabel: 'ge-0/0/1' }),
      line({ ordinal: 3, text: 'set system ntp server 10.10.0.9', mark: 'kept' }),
      line({
        ordinal: 4,
        text: 'set security ike policy IKE-POL pre-shared-key hexadecimal <REDACTED:psk>',
        mark: 'destroyed',
        drops: [{ start: 59, end: 73, label: 'psk' }],
      }),
    ];
    const markup = render(baseProps({ capture: capture(lines) }));

    // The destroyed value's own block — the label, never the original
    // length, never the raw `<REDACTED:...>` marker text.
    expect(markup).toContain('psk · destroyed at the gate');
    expect(markup).not.toContain('<REDACTED:psk>');

    // Line 1 built an interface with no matching port on this faceplate.
    expect(markup).toContain('built ge-0/0/0.0 · no port on this plate');
    // Line 2's own name matches `port-1`'s label exactly — no such note for it.
    const noPortCount = markup.split('no port on this plate').length - 1;
    expect(noPortCount).toBe(1);

    // Every gutter glyph appears once per its own mark.
    expect(markup).toContain('●'); // built
    expect(markup).toContain('○'); // kept
    expect(markup).toContain('—'); // destroyed
  });

  it('caps rendered lines at 20,000 and says how many were not shown', () => {
    const lines: CaptureLine[] = Array.from({ length: 20_005 }, (_, i) =>
      line({ ordinal: i + 1, text: `line ${i + 1}`, mark: 'kept' }),
    );
    const markup = render(baseProps({ capture: capture(lines) }));
    expect(markup).toContain('5 lines not shown.');
    expect(markup).not.toContain('line 20005');
    expect(markup).toContain('line 20000');
  });
});
