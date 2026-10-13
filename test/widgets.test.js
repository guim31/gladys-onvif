import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent, validateWidgetImage } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/hub.js';
import { CONTROLS, TEXT, imageKey, widgetPresets } from '../src/widgets.js';
import { DEFAULT_CONFIG, FakeCamera, createAll, createWorld } from './helpers/world.js';

const tapo = () => new FakeCamera({ model: 'tapo', host: '192.0.2.22', mac: '02-00-5E-10-00-03' });
const hikvision = () =>
  new FakeCamera({ model: 'hikvision', host: '192.0.2.21', mac: '02-00-5E-10-00-02' });

async function content(world, settings, language = 'en') {
  const ack = await world.fake.widgetGet(WIDGET_KEY, { settings, language });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
}

test('every content fits the vocabulary and the budget, in every mode and language', async (t) => {
  const world = await createWorld({ cameras: [new FakeCamera(), tapo(), hikvision()] });
  t.after(() => world.app.stop());
  await createAll(world);
  const ids = new Set(
    world.fake.discoveredDevices.flatMap((device) =>
      device.features.map((item) => item.external_id),
    ),
  );
  for (const device of world.fake.discoveredDevices) {
    for (const controls of [...CONTROLS, undefined]) {
      for (const language of ['en', 'fr', 'de', 'es']) {
        const result = await content(world, { camera: device.external_id, controls }, language);
        assert.deepEqual(
          validateWidgetContent(result),
          [],
          `${device.name} ${controls} ${language}`,
        );
        assert.ok(result.components.filter((item) => item.type === 'button').length <= 4);
        for (const item of result.components) {
          if (item.device_feature) {
            assert.ok(ids.has(item.device_feature), item.device_feature);
          }
        }
      }
    }
  }
});

test('the buttons follow the settings and what the camera can do', async (t) => {
  const world = await createWorld({ cameras: [new FakeCamera(), hikvision()] });
  t.after(() => world.app.stop());
  await createAll(world);
  const [ptz, fixed] = world.fake.discoveredDevices;
  const labels = async (settings) =>
    (await content(world, settings)).components
      .filter((item) => item.type === 'button')
      .map((item) => item.label);
  assert.deepEqual(await labels({ camera: ptz.external_id }), ['Left', 'Up', 'Down', 'Right']);
  assert.deepEqual(await labels({ camera: ptz.external_id, controls: 'zoom_presets' }), [
    'Zoom out',
    'Zoom in',
    'Gate',
    'Garden',
  ]);
  assert.deepEqual(
    await labels({ camera: ptz.external_id, controls: 'presets', presets: 'portail, 2, nothing' }),
    ['Portail', 'Garden'],
  );
  assert.deepEqual(await labels({ camera: ptz.external_id, controls: 'none' }), []);
  assert.deepEqual(await labels({ camera: fixed.external_id }), []);
  // Numbered keys: the core drops a button whose action key is taken.
  const buttons = (
    await content(world, { camera: ptz.external_id, controls: 'presets' })
  ).components.filter((item) => item.type === 'button');
  assert.equal(new Set(buttons.map((item) => item.action.key)).size, buttons.length);
});

test('image, status of the detections, caption', async (t) => {
  const world = await createWorld({ cameras: [tapo()] });
  t.after(() => world.app.stop());
  await createAll(world);
  const [device] = world.fake.discoveredDevices;
  const result = await content(world, { camera: device.external_id }, 'fr');
  const image = result.components.find((item) => item.type === 'image');
  assert.equal(image.key, imageKey(device.external_id, 1));
  const served = await world.fake.widgetGetImage(image.key);
  assert.equal(served.success, true);
  assert.deepEqual(validateWidgetImage(served.data.image), []);
  const status = result.components.find((item) => item.type === 'status');
  assert.deepEqual(
    status.items.map((item) => item.label),
    [
      'Détection de mouvement',
      'Détection de personne',
      'Détection de véhicule',
      'Détection d’animal',
    ],
  );
  assert.match(result.components[0].text, /^Image \d\d:\d\d:\d\d$/);
  const unknown = await world.fake.widgetGetImage('cam-000000000000-1');
  assert.equal(unknown.success, false);
});

test('a tap moves the camera and comes back with the new view', async (t) => {
  const world = await createWorld({
    config: { ...DEFAULT_CONFIG, move_duration: '0.5' },
    timings: {
      imageAfterMoveMs: 10,
      imageAfterPresetMs: 10,
      minImageSpacingMs: 0,
      freshImageMs: 0,
    },
  });
  t.after(() => world.app.stop());
  await createAll(world);
  const [device] = world.fake.discoveredDevices;
  const camera = world.network.cameras[0];
  const before = world.hub.cameras.values().next().value.sources[0].imageSeq;
  const ack = await world.fake.widgetAction(
    WIDGET_KEY,
    'move_1',
    { value: 1 },
    { settings: { camera: device.external_id } },
  );
  assert.deepEqual(ack.data, {
    message: { en: 'Left', fr: 'Gauche', de: 'Links', es: 'Izquierda' },
  });
  assert.deepEqual(
    camera.moves.map((item) => item.operation),
    ['ContinuousMove', 'Stop'],
  );
  assert.ok(world.hub.cameras.values().next().value.sources[0].imageSeq > before);
  const preset = await world.fake.widgetAction(
    WIDGET_KEY,
    'preset_2',
    { value: 5 },
    { settings: { camera: device.external_id } },
  );
  assert.equal(preset.data.message.fr, 'Position mémorisée : Portail');
  const nothing = await world.fake.widgetAction(
    WIDGET_KEY,
    'move_1',
    { value: 1 },
    { settings: {} },
  );
  assert.equal(nothing.success, false);
});

test('without a camera chosen, or an unknown one, the widget says so', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.equal((await content(world, {}, 'de')).components[0].text, TEXT.pick.de);
  assert.equal(
    (await content(world, { camera: 'ext:x' }, 'es')).components[0].text,
    TEXT.unknown.es,
  );
  assert.deepEqual(
    widgetPresets(
      [
        { name: 'A', value: 1 },
        { name: 'B', value: 2 },
      ],
      '',
      1,
    ),
    [{ name: 'A', value: 1 }],
  );
});
