import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { About } from './About';
import licences from './licences.json';

describe('About (render-to-string)', () => {
  const markup = renderToStaticMarkup(createElement(About, { onBack: () => {} }));

  it('lists every shipped library once, with its licence', () => {
    expect(licences.length).toBeGreaterThan(0);
    for (const lib of licences) {
      expect(markup).toContain(`<td>${lib.name}</td>`);
      expect(markup).toContain(lib.license);
    }
    expect(markup.match(/<tr>/g)?.length).toBe(licences.length + 1);
  });

  it('credits React Flow, whose corner link the canvas hides', () => {
    const reactFlow = licences.find((lib) => lib.name === '@xyflow/react');
    expect(reactFlow?.license).toBe('MIT');
    expect(markup).toContain('webkid GmbH');
  });
});
