import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Explainer } from '../../api/learn';
import { AboutSection } from './AboutSection';
import { LearnContext, type LearnApi } from './context';
import { aboutPlatform, library } from './explainers';
import { ExplainerPage } from './LearnOverlay';

function ex(over: Partial<Explainer>): Explainer {
  return {
    id: 'explain:concept:x',
    kind: 'concept',
    title: 'X',
    subject: 'x',
    platforms: [],
    tab: null,
    terse: null,
    explained: null,
    teaching: null,
    breaksIfWrong: null,
    reviewedOn: null,
    reviewed: false,
    sources: [],
    ...over,
  };
}

const eos = ex({ id: 'e:eos', title: 'EOS basics', subject: 'arista.eos-basics', platforms: ['eos'], tab: 'read this first', terse: 'Run `show version`.' });
const family = ex({ id: 'e:linux', title: 'Linux family', subject: 'linux.family-basics', tab: 'read this first' });
const debian = ex({ id: 'e:debian', title: 'Debian', subject: 'linux-debian.basics', tab: 'read this first' });
const ipsec = ex({ id: 'e:pfs', title: 'PFS', subject: 'ipsec.pfs', platforms: ['*'], tab: 'why it exists' });
const all = [debian, eos, family, ipsec];

function api(platform: string): LearnApi {
  return { status: 'ready', explainers: all, openExplainer: () => {}, openLibrary: () => {}, platformOf: () => platform };
}

describe('aboutPlatform', () => {
  it('matches a platform by its registry id', () => {
    expect(aboutPlatform(all, 'eos').map((e) => e.id)).toEqual(['e:eos']);
  });
  it('gives every Linux flavour to linux-host, the family first', () => {
    expect(aboutPlatform(all, 'linux-host').map((e) => e.id)).toEqual(['e:linux', 'e:debian']);
  });
  it('gives nothing for no platform, or one nobody wrote about', () => {
    expect(aboutPlatform(all, '')).toEqual([]);
    expect(aboutPlatform(all, 'panos')).toEqual([]);
  });
  it('never offers a non-first entry as the About card', () => {
    expect(aboutPlatform(all, 'junos-srx')).toEqual([]);
  });
});

describe('library', () => {
  it('groups by topic in a fixed order', () => {
    expect(library(all).map((g) => g.topic)).toEqual(['Arista EOS', 'Linux', 'IPsec VPNs']);
    const trunk = ex({ id: 'e:trunk', subject: 'basics.trunk', platforms: ['*'], tab: 'learn note' });
    expect(library([...all, trunk])[0]!.topic).toBe('Networking basics');
  });
});

describe('AboutSection', () => {
  const render = (a: LearnApi | null) => renderToStaticMarkup(createElement(LearnContext.Provider, { value: a }, createElement(AboutSection, { deviceId: 'Device:1' })));
  it('shows the first explainer, marked Unreviewed, with code in backticks', () => {
    const html = render(api('eos'));
    expect(html).toContain('EOS basics');
    expect(html).toContain('Unreviewed');
    expect(html).toContain('<code>show version</code>');
    expect(html).toContain('Read more');
  });
  it('shows nothing without a provider or a platform', () => {
    expect(render(null)).toBe('');
    expect(render(api(''))).toBe('');
  });
});

describe('ExplainerPage', () => {
  it('drops the Unreviewed mark once someone has vouched for it, and links only safe URLs', () => {
    const html = renderToStaticMarkup(
      createElement(ExplainerPage, {
        e: ex({
          title: 'Checked',
          reviewed: true,
          sources: [
            { publisher: null, doc: 'Good', url: 'https://example.com/a', readOn: '2026-10-25', note: null },
            { publisher: null, doc: 'Bad', url: 'javascript:alert(1)', readOn: null, note: null },
          ],
        }),
      }),
    );
    expect(html).not.toContain('Unreviewed');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('read 2026-10-25');
  });
});
