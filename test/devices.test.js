import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  MOVES,
  buildDevice,
  deviceName,
  featureSpecs,
  presetLabel,
  presetValues,
  sanitizeToken,
  supportedMoves,
} from '../src/devices.js';

const full = {
  continuous: { pan: true, tilt: true, zoom: true },
  relative: { pan: true, tilt: true, zoom: true },
};

test('movements follow the axes the camera has', () => {
  assert.deepEqual(supportedMoves(null), []);
  assert.deepEqual(supportedMoves(full), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(
    supportedMoves({
      continuous: { pan: true, tilt: false, zoom: false },
      relative: { zoom: true },
    }),
    [MOVES.PAN_LEFT, MOVES.PAN_RIGHT, MOVES.ZOOM_IN, MOVES.ZOOM_OUT],
  );
});

test('preset numbers come from the tokens and never move', () => {
  const presets = [
    { token: 'PTZPresetToken_2', name: 'Garden' },
    { token: '7', name: 'Gate' },
    { token: 'PTZPresetToken_1', name: 'Gate' },
    { token: 'home', name: '' },
  ];
  const values = presetValues(presets);
  assert.deepEqual(
    values.map((preset) => [preset.token, preset.value]),
    [
      ['PTZPresetToken_1', 1],
      ['PTZPresetToken_2', 2],
      ['7', 7],
      ['home', values[3].value],
    ],
  );
  assert.ok(values[3].value >= 100000);
  // Same tokens in another order, or with one more preset: same numbers.
  assert.deepEqual(presetValues([...presets].reverse()), values);
  const more = presetValues([...presets, { token: 'PTZPresetToken_9', name: 'Road' }]);
  for (const preset of values) {
    assert.equal(more.find((item) => item.token === preset.token).value, preset.value);
  }
  assert.equal(presetLabel(values[3], 'fr'), `Position ${values[3].value}`);
});

test('features: image always, PTZ when it moves, a sensor per detection', () => {
  const fixed = featureSpecs({ ptz: null, presets: null }, ['motion', 'sound'], 'en');
  assert.deepEqual(
    fixed.map((spec) => spec.key),
    ['image', 'motion'],
  );
  const ptz = featureSpecs(
    { ptz: full, presets: [{ token: '1', name: 'A' }] },
    ['tamper', 'person'],
    'fr',
  );
  assert.deepEqual(
    ptz.map((spec) => `${spec.key}:${spec.category}/${spec.type}`),
    [
      'image:camera/image',
      'move:camera/move',
      'preset:camera/preset',
      'person:motion-sensor/binary',
      'tamper:tamper/binary',
    ],
  );
  const move = ptz.find((spec) => spec.key === 'move');
  assert.deepEqual(
    move.supported_options.map((option) => option.label),
    ['Gauche', 'Droite', 'Haut', 'Bas', 'Zoomer', 'Dézoomer'],
  );
  assert.equal(ptz.find((spec) => spec.key === 'preset').max, 1);
  // A PTZ camera without presets still offers the (empty) list.
  assert.equal(featureSpecs({ ptz: full, presets: [] }, [], 'en')[2].max, 0);
});

test('device names and ids', () => {
  const gladys = createFakeGladys();
  const camera = {
    uid: '02005e100001',
    host: '192.0.2.20',
    port: 80,
    info: { manufacturer: 'HIKVISION', model: 'HIKVISION DS-2CD2', firmware: 'V5' },
    kinds: [],
    sources: [{ index: 0, token: 'Video Source/1' }],
  };
  assert.equal(deviceName(camera, camera.sources[0], 'en'), 'HIKVISION DS-2CD2');
  const device = buildDevice(
    gladys,
    camera,
    { ...camera.sources[0], ptz: null, presets: null },
    'en',
  );
  assert.equal(device.external_id, 'ext:test-integration:camera:02005e100001_Video-Source-1');
  assert.equal(device.should_poll, false);
  assert.deepEqual(
    device.params.map((param) => param.name),
    ['IP_ADDRESS', 'ONVIF_PORT', 'MANUFACTURER', 'FIRMWARE'],
  );
  const recorder = { ...camera, info: {}, sources: [{ index: 0 }, { index: 1 }] };
  assert.equal(deviceName(recorder, recorder.sources[1], 'de'), 'Kamera ONVIF (2)');
  assert.equal(sanitizeToken(''), 'main');
});
