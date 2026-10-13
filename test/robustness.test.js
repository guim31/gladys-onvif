// -----------------------------------------------------------------------------
// What must hold when things go wrong: a camera never keeps moving, a refused
// account is left alone, a lost answer does not change a camera's identity.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOVES } from '../src/devices.js';
import { hasCredentials } from '../src/hub.js';
import { DEFAULT_CONFIG, FakeCamera, createAll, createWorld, waitFor } from './helpers/world.js';

const hikvision = () =>
  new FakeCamera({ model: 'hikvision', host: '192.0.2.21', mac: '02-00-5E-10-00-02' });
const feature = (device, key) =>
  device.features.find((item) => item.external_id.endsWith(`:${key}`));
const stops = (camera) =>
  camera.calls.filter((call) => call.operation === 'Stop' && !call.lost).length;

test('a lost stop is sent again until the camera stops', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, move_duration: '0.5' } });
  t.after(() => world.app.stop());
  const camera = world.network.cameras[0];
  const [device] = world.fake.discoveredDevices;
  await world.fake.setValue(device, feature(device, 'move'), MOVES.PAN_LEFT);
  camera.failing.Stop = 1;
  const ack = await world.fake.setValue(device, feature(device, 'move'), MOVES.STOP);
  assert.equal(ack.success, false);
  await waitFor(() => stops(camera) === 1, { timeoutMs: 3000, message: 'stop sent again' });
});

test('a move whose answer was lost is stopped by the watchdog', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, move_duration: '0.5' } });
  t.after(() => world.app.stop());
  const camera = world.network.cameras[0];
  const [device] = world.fake.discoveredDevices;
  await world.fake.setValue(device, feature(device, 'move'), MOVES.PAN_LEFT);
  camera.failing.ContinuousMove = 1;
  const ack = await world.fake.setValue(device, feature(device, 'move'), MOVES.PAN_LEFT);
  assert.equal(ack.success, false);
  await waitFor(() => stops(camera) === 1, { message: 'watchdog stop' });
  // A watchdog stop lost several times is tried again.
  camera.failing.Stop = 2;
  await world.fake.setValue(device, feature(device, 'move'), MOVES.TILT_UP);
  await waitFor(() => stops(camera) === 2, { timeoutMs: 4000, message: 'stop after two losses' });
});

test('stopping the integration mid-move stops the camera', async () => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, move_duration: '5' } });
  const camera = world.network.cameras[0];
  const [device] = world.fake.discoveredDevices;
  await world.fake.setValue(device, feature(device, 'move'), MOVES.ZOOM_IN);
  await world.app.stop();
  assert.equal(camera.moves.at(-1).operation, 'Stop');
});

test('a first start that failed runs again at the next connection', async (t) => {
  const world = await createWorld({ connect: false });
  t.after(() => world.app.stop());
  const publish = world.gladys.publishDiscoveredDevices.bind(world.gladys);
  let refuse = true;
  world.gladys.publishDiscoveredDevices = async (devices) => {
    if (refuse) {
      throw new Error('Gladys is restarting');
    }
    return publish(devices);
  };
  await world.gladys.connect();
  await world.app.ready;
  assert.equal(world.fake.discoveredDevices.length, 0);
  refuse = false;
  await world.gladys.disconnect();
  await world.gladys.connect();
  await world.hub.idle();
  assert.equal(world.fake.discoveredDevices.length, 1);
});

test('a camera that refuses its account gets no more requests with it', async (t) => {
  const camera = hikvision();
  const world = await createWorld({
    cameras: [camera],
    events: true,
    timings: { eventRetryMs: 30 },
  });
  t.after(() => world.app.stop());
  await createAll(world);
  await waitFor(() => camera.operations().includes('PullMessages'), { message: 'events' });
  camera.password = 'changed on the camera';
  camera.subscriptions.clear();
  await waitFor(() => world.hub.cameras.values().next().value.authError, { message: 'auth error' });
  const count = camera.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  await world.hub.refreshAllImages();
  const [device] = world.fake.discoveredDevices;
  assert.equal((await world.fake.getImage(device)).success, false);
  assert.deepEqual(
    camera.calls
      .slice(count)
      .filter((call) => call.auth !== 'missing' || call.operation !== 'GetSystemDateAndTime')
      .map((call) => call.operation),
    [],
    'nothing but the clock',
  );
});

test('a lost answer while connecting does not give the camera a new identity', async (t) => {
  const world = await createWorld({ cameras: [hikvision()] });
  t.after(() => world.app.stop());
  await createAll(world);
  const [before] = world.fake.discoveredDevices;
  world.network.cameras[0].failing.GetNetworkInterfaces = 1;
  await world.fake.scanRequest();
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.external_id),
    [before.external_id],
  );
  assert.equal(world.hub.cameras.size, 1);
});

test('one scene event per detector every few seconds', async (t) => {
  const camera = new FakeCamera({ model: 'tapo', host: '192.0.2.22', mac: '02-00-5E-10-00-03' });
  const world = await createWorld({
    cameras: [camera],
    events: true,
    timings: { triggerCooldownMs: 5000 },
  });
  t.after(() => world.app.stop());
  await createAll(world);
  const [device] = world.fake.discoveredDevices;
  const person = feature(device, 'person').external_id;
  for (const value of [true, false, true]) {
    camera.emit('tapo-person', { value });
    await waitFor(() => world.fake.lastState(person) === (value ? 1 : 0), {
      message: `person ${value}`,
    });
  }
  assert.equal(world.fake.sceneEvents.length, 1);
});

test('an address with credentials is never written to /data', async (t) => {
  assert.equal(hasCredentials('http://192.0.2.5/snapshot.cgi?usr=admin&pwd=x'), true);
  assert.equal(hasCredentials('http://u:p@192.0.2.5/s.jpg'), true);
  assert.equal(hasCredentials('http://192.0.2.5/onvif-http/snapshot?Profile_1'), false);
  const world = await createWorld({ cameras: [hikvision()] });
  t.after(() => world.app.stop());
  const [camera] = world.hub.cameras.values();
  camera.sources[0].snapshotUri = 'http://192.0.2.21/snapshot.cgi?usr=admin&pwd=secret';
  await world.hub.save();
  await world.hub.store.flush();
  assert.ok(!readFileSync(join(world.dataDir, 'onvif-state.json'), 'utf8').includes('pwd='));
});
