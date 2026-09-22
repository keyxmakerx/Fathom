import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { encodeQr } from './encode';
import { QrCode } from './QrCode';
import { QR_QUIET_ZONE, qrPath, qrSide } from './svg';
import { QR_VECTORS } from './vectors.reference';

describe('the SVG geometry', () => {
  it('offsets every module by the quiet zone ISO/IEC 18004 §9.1 asks for', () => {
    expect(QR_QUIET_ZONE).toBe(4);
    expect(qrPath([[true]])).toBe('M4 4h1v1h-1z');
    expect(qrSide(21)).toBe(29);
  });

  it('draws a run of dark modules as one rectangle, not one each', () => {
    expect(qrPath([[true, true, true]])).toBe('M4 4h3v1h-3z');
    expect(qrPath([[true, false, true]])).toBe('M4 4h1v1h-1zM6 4h1v1h-1z');
  });

  it('draws nothing for a row with no dark module', () => {
    expect(qrPath([[false, false]])).toBe('');
  });

  it('covers exactly the dark modules of a real symbol', () => {
    // The area of the path equals the number of dark modules: a run-merging
    // bug that dropped or doubled a module would change it.
    const vector = QR_VECTORS[0];
    const symbol = encodeQr(vector.text);
    const dark = vector.rows.join('').split('').filter((module) => module === '1').length;
    const area = [...qrPath(symbol.modules).matchAll(/h(\d+)v1/g)].reduce(
      (sum, match) => sum + Number(match[1]),
      0,
    );
    expect(area).toBe(dark);
  });
});

describe('the QR component', () => {
  const markup = renderToStaticMarkup(
    createElement(QrCode, { value: 'otpauth://totp/Fathom:a@b.test?secret=ABCDEFGH', label: 'code' }),
  );

  it('is inline SVG and nothing the Content-Security-Policy has to allow', () => {
    // ADR-0056 decision 7: the policy does not move for this screen. No
    // `<img>`, no `data:` URI, no `style` attribute.
    expect(markup).toContain('<svg');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('data:');
    expect(markup).not.toContain('style=');
    expect(markup).not.toContain('url(');
  });

  it('is a labelled image to a screen reader, and does not read the secret out', () => {
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="code"');
    expect(markup).not.toContain('ABCDEFGH');
  });

  it('says so in words rather than failing when the value will not fit', () => {
    // Past 2,331 bytes there is no larger symbol at level M. Nothing this
    // client draws comes near it — the longest `otpauth://` URI the server
    // can build is about 1,100 bytes — but the screen must not go blank if
    // one ever did.
    const tooLong = renderToStaticMarkup(
      createElement(QrCode, { value: 'x'.repeat(2332), label: 'code' }),
    );
    expect(tooLong).toContain('data-testid="qr-missing"');
    expect(tooLong).toMatch(/setup key/);
  });
});
