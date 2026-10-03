import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DEVICE_ROLES } from '../../document/edit';
import { DeviceIcon, ICON_KINDS, iconForRole } from './deviceIcons';

describe('device icons', () => {
  it('maps each drawn role to its icon', () => {
    expect(iconForRole('router')).toBe('router');
    expect(iconForRole('switch')).toBe('switch');
    expect(iconForRole('firewall')).toBe('firewall');
    expect(iconForRole('server')).toBe('server');
    expect(iconForRole('access_point')).toBe('access_point');
  });
  it('falls back to a box for other, unknown, inherited and unset roles', () => {
    for (const r of ['other', 'load_balancer', 'toaster', 'constructor', '__proto__', '', null, undefined]) expect(iconForRole(r)).toBeNull();
  });
  it('every role is either mapped to a known icon or deliberately a box', () => {
    for (const role of DEVICE_ROLES) {
      const k = iconForRole(role);
      if (k != null) expect(ICON_KINDS).toContain(k);
    }
  });
  it('draws every icon in ink outline with no outside reference', () => {
    for (const kind of ICON_KINDS) {
      const html = renderToStaticMarkup(createElement(DeviceIcon, { kind }));
      expect(html).toContain(`data-icon="${kind}"`);
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('stroke-width="1.6"');
      expect(html).not.toMatch(/href|<image|url\(/);
    }
  });
});
