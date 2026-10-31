import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { FirmwareImage } from '../../api/firmware';
import { setDeviceTarget, setFirmwareHold, setRunningVersion, setTarget, setVersionPlatform } from '../../document/firmware';
import { TYPED_AS_WRITTEN, createPlan } from '../../document/plans';
import { NOW, addBareDevice, estate } from '../../document/firmwareFixture';
import type { Document } from '../../document/model';
import { FirmwareContext, type FirmwareApi } from './context';
import { FirmwareList } from './FirmwareList';
import { FirmwareSection } from './FirmwareSection';
import { ImagePage } from './ImagePage';
import { FirmwareActivityList, activityWords } from './Activity';
import { ModelPage, statusWords } from './ModelPage';
import { ByHandSteps, HowItGetsThere } from './ByHand';
import { CommandNotes, LinkWarnings } from './parts';
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
  sha512: null,
  lastCheckedAtUnix: null,
  changedAtUnix: null,
  retiredAtUnix: null,
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
  setDeviceTarget: () => {},
  setRunning: () => {},
  setVersionPlatform: () => {},
  upload: async () => ({ refused: 'no' }),
  setImageModels: async () => ({ changed: true }),
  retireImage: async () => ({ fileDeleted: true }),
  loadActivity: async () => [],
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

  it('puts a Copy button for the whole hash beside the short one, for readers too', () => {
    const reader = html(api(world().doc, { canEdit: false, isSteward: false }));
    expect(reader).toMatch(/9f2c…a41e <button type="button" class="fw-btn btn-quiet">Copy<\/button>/);
  });

  it('marks an image a re-check found changed, right beside its hash', () => {
    const out = html(api(world().doc, { server: { status: 'ready', images: [{ ...image, changedAtUnix: 5 }], error: null } }));
    expect(out).toContain('Changed on the server, won&#x27;t be sent');
  });

  it('shows the behind count in amber and says it in the footer, with the button that plans for them', () => {
    const out = html(api(world().doc));
    expect(out).toContain('fw-amber');
    expect(out).toMatch(/2 devices are behind/);
    expect(out).toContain('Plan an upgrade for them');
  });

  it('a steward gets Upload image; a drawer gets the plan button but not upload; a reader gets neither', () => {
    expect(html(api(world().doc))).toContain('+ Upload image');
    const drawer = html(api(world().doc, { isSteward: false }));
    expect(drawer).not.toContain('Upload image');
    expect(drawer).toContain('Plan an upgrade for them');
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

  it('gives a steward Edit models, and a writer who is not a steward does not get it', () => {
    const html = (a: FirmwareApi) => renderToStaticMarkup(createElement(ImagePage, { api: a, rowKey: 'img:' + IMG_ID, onOpenModel: noop }));
    expect(html(api(world().doc))).toContain('Edit models');
    expect(html(api(world().doc, { isSteward: false }))).not.toContain('Edit models');
  });

  it('shows the SHA-512 with a Copy button and when the file was last checked', () => {
    const sha512 = 'c'.repeat(128);
    const out = renderToStaticMarkup(createElement(ImagePage, { api: api(world().doc, { server: { status: 'ready', images: [{ ...image, sha512, lastCheckedAtUnix: 1_793_404_800 }], error: null } }), rowKey: 'img:' + IMG_ID, onOpenModel: noop }));
    expect(out).toContain('SHA-512');
    expect(out).toContain(sha512);
    expect(out.match(/>Copy</g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(out).toContain('Still matches, last checked 31 Oct 2026');
  });

  it('gives a steward Retire image, and a reader does not get it', () => {
    const html = (a: FirmwareApi) => renderToStaticMarkup(createElement(ImagePage, { api: a, rowKey: 'img:' + IMG_ID, onOpenModel: noop }));
    expect(html(api(world().doc))).toContain('Retire image…');
    expect(html(api(world().doc, { canEdit: false, isSteward: false }))).not.toContain('Retire image');
  });

  it('drops a retired image from the list and its page', () => {
    const a = api(world().doc, { server: { status: 'ready', images: [{ ...image, state: 'retired', retiredAtUnix: 1_793_404_800 }], error: null } });
    const out = renderToStaticMarkup(createElement(ImagePage, { api: a, rowKey: 'img:' + IMG_ID, onOpenModel: noop }));
    expect(out).toContain('not listed any more');
    expect(out).not.toContain('Retire image');
  });

  it('warns plainly when a re-check found the stored file changed', () => {
    const out = renderToStaticMarkup(createElement(ImagePage, { api: api(world().doc, { server: { status: 'ready', images: [{ ...image, lastCheckedAtUnix: 1_793_404_800, changedAtUnix: 1_793_404_800 }], error: null } }), rowKey: 'img:' + IMG_ID, onOpenModel: noop }));
    expect(out).toContain('role="alert"');
    expect(out).toContain("no longer matched these hashes, or was gone. Fathom won&#x27;t send it.");
    expect(out).not.toContain('Still matches');
  });

  it("lists the server's models, not the chosen-version fallback, once the server has any", () => {
    const out = renderToStaticMarkup(createElement(ImagePage, { api: api(world().doc, { server: { status: 'ready', images: [{ ...image, models: ['srx300'] }], error: null } }), rowKey: 'img:' + IMG_ID, onOpenModel: noop }));
    expect(out).toContain('srx300');
    expect(out).not.toContain('>ex4300-48t<');
  });
});

describe('what the server could not write', () => {
  const commands = { expectedSha256: HASH, devicePath: '', sourcedNote: '', sourced: 'none', platform: 'frr', family: 'unknown', couldNotEstablish: [], deviceHash: { algorithm: 'sha256', comparesWith: 'expected_sha256' }, byHand: null, steps: [] };

  it('says no steps are written for a platform without them', () => {
    expect(renderToStaticMarkup(createElement(CommandNotes, { commands }))).toContain('No steps are written for this platform yet.');
  });

  it('shows each thing not established, muted, under the commands', () => {
    const out = renderToStaticMarkup(createElement(CommandNotes, { commands: { ...commands, steps: [{ order: 1, step: 's', command: 'c', note: '' }], couldNotEstablish: ['a rollback command', 'x'] } }));
    expect(out).toContain('Not established: a rollback command');
    expect(out).toContain('Not established: x');
    expect(out).toContain('fw-muted');
    expect(out).not.toContain('No steps are written');
  });

  it('shows nothing when there are no commands', () => {
    expect(renderToStaticMarkup(createElement(CommandNotes, { commands: null }))).toBe('');
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
    expect(out).toContain('btn-quiet">Hold<');
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
    expect(out).not.toContain('btn-quiet">Hold<');
    expect(out).not.toContain('Plan a firmware upgrade');
    expect(out).not.toContain('Get a one-time link');
  });

  it('says to choose a version first when the model has none, and shows nothing with no model or no context', () => {
    const { doc, ids } = estate();
    expect(render(api(doc), ids.sw1!)).toContain('Choose a version first');
    expect(render(null, ids.sw1!)).toBe('');
  });
});

describe('a device with no model, and its own chosen version (schema 0.31)', () => {
  const render = (a: FirmwareApi, deviceId: string) => renderToStaticMarkup(createElement(FirmwareContext.Provider, { value: a }, createElement(FirmwareSection, { deviceId })));
  const home = () => {
    const made = addBareDevice(estate().doc, 'fw-home', NOW + 1);
    let d = setVersionPlatform(made.doc, made.deviceId, 'opnsense', { now: NOW + 2 });
    d = setRunningVersion(d, made.deviceId, '25.7.11_2', { now: NOW + 3 });
    d = setDeviceTarget(d, made.deviceId, '26.1', { now: NOW + 4 });
    return { doc: d, id: made.deviceId };
  };

  it('shows a bare device with a way to type what it runs and choose a version for it', () => {
    const made = addBareDevice(estate().doc, 'nas', NOW + 1);
    const out = render(api(made.doc), made.deviceId);
    expect(out).toContain('Running');
    expect(out).toContain('Type it');
    expect(out).toContain('Chosen for this device');
    expect(out).toContain('Numbering');
    expect(out).toContain('Choose a version first');
  });

  it('says behind, offers the written steps, and adds to a plan still being planned', () => {
    const { doc, id } = home();
    const planned = createPlan(doc, { title: 'Saturday window', gate: TYPED_AS_WRITTEN, now: NOW + 5 }).doc;
    const out = render(api(planned), id);
    expect(out).toContain('25.7.11_2');
    expect(out).toContain('26.1');
    expect(out).toContain('Behind');
    expect(out).toContain('Steps for');
    expect(out).toContain('Synology DSM (not checked against the vendor)');
    expect(out).toContain('Add to an existing plan…');
    expect(out).not.toContain('Firmware page');
  });

  it('lists the device under the image list, with a plan button for an editor', () => {
    const { doc } = home();
    const out = renderToStaticMarkup(createElement(FirmwareList, { api: api(doc), onOpenImage: () => {}, onOpenModel: () => {}, onOpenDevices: () => {}, onUpload: () => {} }));
    expect(out).toContain('data-testid="firmware-own"');
    expect(out).toContain('fw-home');
    expect(out).toContain('Plan an upgrade');
  });
});

describe('the same job by hand, from Windows or Linux', () => {
  const scp = {
    way: 'scp',
    label: 'Over SSH',
    warning: null,
    windows: [
      { order: 1, at: 'computer' as const, step: 'check the file on your computer', command: 'Get-FileHash .\\x.bin -Algorithm SHA512', note: 'Compare with Cisco.' },
      { order: 2, at: 'device' as const, step: 'let the switch receive a file', command: 'ip scp server enable', note: 'Cisco 215450.' },
      { order: 3, at: 'computer' as const, step: 'copy it to the device', command: 'scp -O .\\x.bin <you>@<device address>:x.bin', note: 'Why -O.' },
    ],
    linux: [{ order: 1, at: 'computer' as const, step: 'let the switch reach this computer', command: '', note: 'Start an SSH server.' }],
  };
  const tftp = { ...scp, way: 'tftp', label: 'TFTP (old way)', warning: 'No login or access control (RFC 1350).' };
  const byHand = { ways: [scp, tftp], sourcedNote: '', couldNotEstablish: ['which file system it lands on'] };

  it('shows where each step is typed, the command, why, and what was not established', () => {
    const out = renderToStaticMarkup(createElement(ByHandSteps, { way: scp, os: 'windows', couldNotEstablish: byHand.couldNotEstablish }));
    expect(out).toContain('On your computer');
    expect(out).toContain('On the device');
    expect(out).toContain('Check the file on your computer');
    expect(out).toContain('ip scp server enable');
    expect(out).toContain('Cisco 215450.');
    expect(out).toContain('Not established: which file system it lands on');
    expect(out).toContain('Copy all');
    expect(out).not.toContain('fw-hand__warning');
  });

  it('a step done by hand has no command to copy', () => {
    const out = renderToStaticMarkup(createElement(ByHandSteps, { way: scp, os: 'linux' }));
    expect(out).toContain('Start an SSH server.');
    expect(out).not.toContain('<code');
    expect(out).not.toContain('Copy all');
  });

  it('TFTP carries its warning above the steps', () => {
    const out = renderToStaticMarkup(createElement(ByHandSteps, { way: tftp, os: 'windows' }));
    expect(out).toMatch(/fw-hand__warning[^>]*>No login or access control \(RFC 1350\)\./);
    expect(out.indexOf('fw-hand__warning')).toBeLessThan(out.indexOf('fw-hand__steps'));
  });

  it("opens on Fathom's own route, with the switch above it", () => {
    const out = renderToStaticMarkup(createElement(HowItGetsThere, { byHand }, createElement('p', null, 'the link')));
    expect(out).toContain('How the file gets there');
    expect(out).toMatch(/aria-checked="true"[^>]*>Fathom link/);
    expect(out).toContain('From Windows');
    expect(out).toContain('the link');
    expect(out).not.toContain('ip scp server enable');
  });

  it('shows only the Fathom route when the server wrote no by-hand steps', () => {
    const out = renderToStaticMarkup(createElement(HowItGetsThere, { byHand: null }, createElement('p', null, 'the link')));
    expect(out).toBe('<p>the link</p>');
  });
});

describe('warnings before a link (r62)', () => {
  it('lists each warning, offers Get the link anyway and says going ahead is recorded', () => {
    const out = renderToStaticMarkup(
      createElement(LinkWarnings, { warnings: [{ code: 'wrong_model', deviceId: 'd', words: 'This image is for ex4300-48t. fw1 is srx300.' }], busy: false, onAnyway: noop, onBack: noop }),
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain('This image is for ex4300-48t. fw1 is srx300.');
    expect(out).toContain('Get the link anyway');
    expect(out).toContain('Go back');
    expect(out).toContain('written to the organisation&#x27;s history with your name');
  });
});

describe('the firmware activity (r62)', () => {
  const base = { seq: 1, atUnix: 1_793_404_800, imageId: IMG_ID, byName: 'Key Maker', source: null, warningsPassed: [], filename: null, version: null, modelsBefore: [], modelsAfter: [] };

  it('says who did what, with the warnings they went past', () => {
    expect(activityWords({ ...base, type: 'firmware_staged', version: '23.4R2' }, null).text).toBe('Uploaded (23.4R2) by Key Maker');
    const link = activityWords({ ...base, type: 'firmware_fetch_issued', warningsPassed: ['wrong_model', 'downgrade'] }, null);
    expect(link.text).toBe('One-time link asked for by Key Maker');
    expect(link.flag).toBe('went past: wrong model, downgrade');
  });

  it("flags a download from an address none of the plan's devices has, and only then", () => {
    const got = { ...base, type: 'firmware_fetch_redeemed', source: '203.0.113.9' };
    expect(activityWords(got, new Set(['10.0.0.5'])).flag).toBe('not the management address of any device in this plan');
    expect(activityWords(got, new Set(['203.0.113.9'])).flag).toBeNull();
    expect(activityWords(got, null).flag).toBeNull();
    expect(activityWords(got, null).text).toBe('Downloaded from 203.0.113.9, link from Key Maker');
  });

  it('shows nothing to someone who is not a steward', () => {
    const out = renderToStaticMarkup(createElement(FirmwareActivityList, { api: api(world().doc, { isSteward: false }), imageIds: [IMG_ID] }));
    expect(out).toBe('');
  });
});
