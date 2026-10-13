import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTIONS, SCENE_ACTIONS } from '../src/scenes.js';
import { DEFAULT_CONFIG, FakeCamera, createWorld } from './helpers/world.js';

test('move_camera: one direction for the given time, then stop', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, move_duration: '5' } });
  t.after(() => world.app.stop());
  const [device] = world.fake.discoveredDevices;
  const camera = world.network.cameras[0];
  const started = Date.now();
  const ack = await world.fake.sceneAction('move_camera', {
    camera: device.external_id,
    direction: 'zoom_out',
    duration: 1,
  });
  assert.deepEqual(ack, { success: true });
  assert.ok(Date.now() - started >= 900, 'waits for the stop');
  assert.deepEqual(
    camera.moves.map((item) => item.operation),
    ['ContinuousMove', 'Stop'],
  );
  const zoom = camera.moves[0].xml.children[1].children[0];
  assert.equal(zoom.name, 'Zoom');
  assert.equal(Number(zoom.attrs.x) < 0, true);
  const bad = await world.fake.sceneAction('move_camera', {
    camera: device.external_id,
    direction: 'sideways',
  });
  assert.equal(bad.success, false);
});

test('a fixed camera cannot move nor reach a preset', async (t) => {
  const world = await createWorld({
    cameras: [new FakeCamera({ model: 'hikvision', host: '192.0.2.21' })],
  });
  t.after(() => world.app.stop());
  const [device] = world.fake.discoveredDevices;
  assert.equal(
    (await world.fake.sceneAction('move_camera', { camera: device.external_id, direction: 'left' }))
      .success,
    false,
  );
  assert.equal(
    (await world.fake.sceneAction('goto_preset', { camera: device.external_id, preset: '1' }))
      .success,
    false,
  );
  assert.equal(
    (await world.fake.sceneAction('goto_preset', { camera: device.external_id })).success,
    false,
  );
  assert.equal((await world.fake.sceneAction('goto_preset', {})).success, false);
});

test('the directions are the movements of the Gladys contract', () => {
  assert.deepEqual(Object.values(DIRECTIONS), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Object.keys(SCENE_ACTIONS), ['goto_preset', 'move_camera']);
});
