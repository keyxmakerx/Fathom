import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseServerDeviceReading } from '../../api/deviceReadServer';
import { DeviceReadingLineView, deviceReadingSentence } from './DeviceReadingLine';

describe('Admin › Settings › Device reading (ADR-0082 §4.4)', () => {
  it('says how to turn it on when the server does not read, and offers no switch', () => {
    const out = renderToStaticMarkup(createElement(DeviceReadingLineView, { loaded: { server: false, reader: false } }));
    expect(out).toContain('FATHOM_DEVICE_READ=on');
    expect(out).not.toContain('<input');
    expect(out).not.toContain('<button');
  });

  it('tells a stopped reader from a running one', () => {
    expect(deviceReadingSentence({ server: true, reader: false })).toContain('not answering');
    expect(deviceReadingSentence({ server: true, reader: true })).toContain('Steward decides');
  });

  it('reads the server’s answer', () => {
    expect(parseServerDeviceReading(new TextEncoder().encode('{"reader":false,"server":true}\n'))).toEqual({ server: true, reader: false });
  });
});
