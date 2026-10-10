import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { FirmwareImage } from '../../api/firmware';
import { setFirmwareHold, setTarget } from '../../document/firmware';
import { NOW, estate } from '../../document/firmwareFixture';
import type { Document } from '../../document/model';
import { FirmwareContext, type FirmwareApi } from './context';
import { FirmwareList } from './FirmwareList';
import { FirmwareSection } from './FirmwareSection';
import { ImagePage } from './ImagePage';
import { ModelPage, statusWords } from './ModelPage';
import { UploadForm } from './UploadForm';
import { modelTableRows } from './rows';
import { modelRows } from '../../document/firmware';

// Render-to-string smoke tests, as the other component tests here do: no DOM library is installed.

const IMG_ID = '01JQZ00000000000000000000A';
const HASH = '9f2c' + 'ab'.repeat(28) + 'a41e';

const image: FirmwareImage = {
  imageId: IMG_ID,
  filename: 'junos-install-ex.tgz',
  byteLength: 1_400_000_000,
  state: 'staged',
  failedReason: null,
  createdAtUnix: 1,
  stagedAtUnix: 2,
  sha256: HASH,
  platform: 'junos-ex',
  version: '23.4R2',
  models: ['ex4300-48t'],
  commands: null,
};

function world() {
  const { doc, ids } = estate();
  let d = setTarget(doc, 'ex4300-48t', { version: '23.4R2', platform: 'junos-ex', image: IMG_ID, imageSha256: HASH }, { now: NOW + 1 });
  d = setFirmwareHold(d, ids.sw3!, 'lab rig, kept for a class', { now: NOW + 2 });
  return { doc: d, ids };
}

const api = (doc: Document, over: Partial<FirmwareApi> = {}): FirmwareApi => ({
  doc,
  canEdit: true,
  isSteward: true,
  server: { status: 'ready', images: [image], error: null },
  reload: () => {},
  setTarget: () => {},
  clearTarget: () => {},
  setHold: () => {},
  upload: async () => ({ refused: 'no' }),
  issueLink: async () => ({ refused: 'no' }),
  planUpgrade: () => {},
  openModel: () => {},
  openPlan: () => {},
  ...over,
});

const noop = () => {};

describe('the Firmware list (r14-b1)', () => {
  const html = (a: FirmwareApi) => renderToStaticMarkup(createElement(FirmwareList, { api: a, onOpenImage: noop, onOpenModel: noop, onOpenDevices: noop, onUpload: noop }));

  it('is one row per image, with version, models, a short hash, counts and a badge', () => {
    const out = html(api(world().doc));
    expect(out).toContain('23.4R2');
    expect(out).toContain('ex4300-48t');
    expect(out).toContain('9f2c…a41e');
    expect(out).toContain('Chosen');
    expect(out).toContain('Version');
    expect(out).toContain('Behind');
    expect(out).toContain('Plans');
    expect(out).toContain('Filter images');
    for (const t of ['All', 'Juniper', 'Cisco', 'Arista']) expect(out).toContain(`>${t}<`);
  });

  it('shows the behind count in amber and says it in the footer, with the button that plans for them', () => {
    const out = html(api(world().doc));
    expect(out).toContain('fw-amber');
    expect(out).toMatch(/2 devices are behind/);
    expect(out).toContain('Plan an upgrade for them');
  });

  it('a person who can edit gets Upload image; a reader gets neither it nor the plan button', () => {
    expect(html(api(world().doc))).toContain('+ Upload image');
    const reader = html(api(world().doc, { canEdit: false, isSteward: false }));
    expect(reader).not.toContain('Upload image');
    expect(reader).not.toContain('Plan an upgrade for them');
    expect(reader).toContain('23.4R2');
  });

  it('with firmware off, says how to turn it on, and still lists typed versions', () => {
    const out = html(api(world().doc, { server: { status: 'off', images: [], error: null } }));
    expect(out).toContain('Firmware is off on this server. Set FATHOM_FIRMWARE_FETCH_BASE_URL in .env to the address your switches can reach, then run docker compose up -d.');
    expect(out).not.toContain('Upload image');
    expect(out).toContain('23.4R2');
  });

  it('says what it is doing while the server has not answered, and lists an image no model has yet', () => {
    const { doc } = estate();
    expect(html(api(doc, { server: { status: 'loading', images: [], error: null } }))).toContain('Reading what the server holds');
    const out = html(api(doc, { server: { status: 'ready', images: [{ ...image, models: [] }], error: null } }));
    expect(out).toContain('no models yet');
    expect(out).toContain('Staged');
  });
});

describe("a model's page (r14-b2)", () => {
  const html = (a: FirmwareApi) => renderToStaticMarkup(createElement(ModelPage, { api: a, model: 'ex4300-48t', onOpenDevice: noop }));

  it('has the chosen version, and a row per device with running version, status and note', () => {
    const out = html(api(world().doc));
    expect(out).toContain('Chosen version');
    expect(out).toContain('23.4R2');
    expect(out).toContain('21.4R3-S5');
    expect(out).toContain('Behind');
    expect(out).toContain('Held');
    expect(out).toContain('lab rig, kept for a class');
    expect(out).toContain('No version yet');
    expect(out).toContain('paste a config to read it');
    expect(out).toContain('sw1');
  });

  it('gives a writer Hold and Release; a reader neither, and a plain value for the choice', () => {
    const writer = html(api(world().doc));
    expect(writer).toContain('>Hold<');
    expect(writer).toContain('>Release<');
    expect(writer).toContain('<select');
    const reader = html(api(world().doc, { canEdit: false, isSteward: false }));
    expect(reader).not.toContain('>Hold<');
    expect(reader).not.toContain('>Release<');
    expect(reader).not.toContain('<select');
    expect(reader).not.toContain('Plan an upgrade for them');
    expect(reader).toContain('lab rig, kept for a class');
  });

  it('words each state the way the mockup does', () => {
    expect(statusWords('current', null).word).toBe('On chosen');
    expect(statusWords('not-recorded', null).note).toBe('paste a config to read it');
    expect(statusWords('held', 'why').note).toBe('why');
  });
});

describe('the Models list', () => {
  it('has a row per model with its chosen version and counts', () => {
    const rows = modelTableRows(modelRows(world().doc));
    expect(rows.map((r) => r.key)).toEqual(['fw:ex4300-48t', 'fw:srx300']);
    expect(rows[0]!.cells).toMatchObject({ model: 'ex4300-48t', version: '23.4R2', devices: '4', behind: '2', held: '1' });
    expect(rows[1]!.cells.version).toBe('');
  });
});

describe('an image page', () => {
  it('shows the full hash, the models and, to a steward, the link button; a reader sees no form', () => {
    const { doc } = world();
    const row = 'img:' + IMG_ID;
    const html = (a: FirmwareApi) => renderToStaticMarkup(createElement(ImagePage, { api: a, rowKey: row, onOpenModel: noop }));
    const out = html(api(doc));
    expect(out).toContain(HASH);
    expect(out).toContain('ex4300-48t');
    expect(out).toContain('Get a one-time link');
    const reader = html(api(doc, { canEdit: false, isSteward: false }));
    expect(reader).not.toContain('Get a one-time link');
    expect(reader).not.toContain('Choose this version for a model');
  });
});

describe('the upload form', () => {
  it('asks for the file, platform, version, the vendor hash and the models', () => {
    const out = renderToStaticMarkup(createElement(UploadForm, { api: api(world().doc), onDone: noop, onCancel: noop }));
    for (const w of ['File', 'Platform', 'Version', "Vendor&#x27;s SHA-256", 'Models', 'Upload']) expect(out).toContain(w);
    for (const p of ['junos-ex', 'junos-srx', 'junos-mx', 'ios-xe', 'nx-os', 'eos']) expect(out).toContain(p);
    expect(out).toContain('ex4300-48t');
    expect(out).toContain('refuses the image if the two differ');
  });
});

describe("a device's firmware row", () => {
  const render = (a: FirmwareApi | null, deviceId: string) => renderToStaticMarkup(createElement(FirmwareContext.Provider, { value: a }, createElement(FirmwareSection, { deviceId })));

  it('says running, chosen, state and hold, with a plan button and a link for a steward', () => {
    const { doc, ids } = world();
    const out = render(api(doc), ids.sw1!);
    expect(out).toContain('Running');
    expect(out).toContain('21.4R3-S5');
    expect(out).toContain('23.4R2');
    expect(out).toContain('Behind');
    expect(out).toContain('Plan a firmware upgrade');
    expect(out).toContain('Get a one-time link');
    expect(out).toContain('fw-btn--quiet">Hold<');
  });

  it('shows a held device with its reason and a way to release it', () => {
    const { doc, ids } = world();
    const out = render(api(doc), ids.sw3!);
    expect(out).toContain('lab rig, kept for a class');
    expect(out).toContain('Release');
  });

  it('a reader sees all of it and can change nothing', () => {
    const { doc, ids } = world();
    const out = render(api(doc, { canEdit: false, isSteward: false }), ids.sw1!);
    expect(out).toContain('Behind');
    expect(out).not.toContain('fw-btn--quiet">Hold<');
    expect(out).not.toContain('Plan a firmware upgrade');
    expect(out).not.toContain('Get a one-time link');
  });

  it('says to choose a version first when the model has none, and shows nothing with no model or no context', () => {
    const { doc, ids } = estate();
    expect(render(api(doc), ids.sw1!)).toContain('Choose a version first');
    expect(render(null, ids.sw1!)).toBe('');
  });
});
