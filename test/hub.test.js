import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { MOVES } from '../src/devices.js';
import { TRIGGER, findPreset, normalizeMac, uniqueId } from '../src/hub.js';
import { LARGE_JPEG } from './helpers/fakeCamera.js';
import { DEFAULT_CONFIG, FakeCamera, createAll, createWorld, waitFor } from './helpers/world.js';

const tapo = () => new FakeCamera({ model: 'tapo', host: '192.0.2.22', mac: '02-00-5E-10-00-03' });
const hikvision = () =>
  new FakeCamera({ model: 'hikvision', host: '192.0.2.21', mac: '02-00-5E-10-00-02' });
const feature = (device, key) =>
  device.features.find((item) => item.external_id.endsWith(`:${key}`));

test('the cameras answering the probe are published, and saved without password', async (t) => {
  const world = await createWorld({ cameras: [new FakeCamera(), hikvision(), tapo()] });
  t.after(() => world.app.stop());
  assert.equal(world.fake.scans.length, 1);
  assert.equal(world.fake.scans[0].port, 3702);
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    ['Happytimesoft IPCamera', 'HIKVISION DS-2CD2085FWD-I', 'tp-link C200'],
  );
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  await world.hub.store.flush();
  const saved = readFileSync(join(world.dataDir, 'onvif-state.json'), 'utf8');
  assert.ok(!saved.includes('secret'), 'no password under /data');
  assert.match(saved, /"username":"admin"/);
});

test('typed addresses work without discovery, invalid ones are reported', async (t) => {
  const world = await createWorld({
    cameras: [tapo()],
    scan: false,
    config: { ...DEFAULT_CONFIG, hosts: '192.0.2.22:2020, nope!' },
  });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 1);
  const ack = await world.fake.action('search', {});
  assert.match(ack.data.message.en, /1 camera\(s\), 1 answering/);
  assert.match(ack.data.message.en, /Ignored addresses: nope!/);
});

test('the account a camera takes is found among three; a refused one is not tried again', async (t) => {
  const camera = new FakeCamera({ model: 'hikvision', host: '192.0.2.21', password: 'third' });
  const world = await createWorld({
    cameras: [camera],
    config: {
      username: 'a',
      password: 'x',
      username_2: 'admin',
      password_2: 'y',
      username_3: 'admin',
      password_3: 'third',
    },
  });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 1);
  assert.equal(world.hub.cameras.values().next().value.username, 'admin');

  // The camera's password changes: refused, then left alone.
  camera.password = 'changed';
  const before = camera.calls.length;
  await world.hub.rediscover();
  const refused = camera.calls
    .slice(before)
    .filter((call) => call.operation === 'GetDeviceInformation');
  assert.equal(refused.length, 3, 'each account tried once');
  await world.hub.rediscover();
  assert.equal(
    camera.calls.slice(before).filter((call) => call.operation === 'GetDeviceInformation').length,
    3,
    'no new try: cameras lock an account after a few wrong passwords',
  );
  const [known] = world.hub.cameras.values();
  assert.equal(known.authError, true);
  // A search asked by the user tries again.
  camera.password = 'third';
  const ack = await world.fake.action('search', {});
  assert.doesNotMatch(ack.data.message.en, /refused/);
  assert.equal(known.authError, false);
});

test('a camera nobody can log into is reported, not published', async (t) => {
  const world = await createWorld({
    cameras: [hikvision()],
    config: { username: 'admin', password: 'bad' },
  });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 0);
  assert.match(world.fake.connectionStatus.message.en, /refused the user name and password/);
  const ack = await world.fake.action('search', {});
  assert.match(ack.data.message.fr, /Compte refusé par 192\.0\.2\.21/);
});

test('images: on creation, on request, from RTSP when there is no snapshot', async (t) => {
  const world = await createWorld({
    cameras: [hikvision(), tapo()],
    timings: { freshImageMs: 0, minImageSpacingMs: 0 },
  });
  t.after(() => world.app.stop());
  assert.equal(world.fake.cameraImages.length, 0, 'nothing before the user adds the camera');
  await createAll(world);
  assert.equal(world.fake.cameraImages.length, 2);
  assert.ok(
    world.fake.cameraImages.every((item) => item.image.startsWith('image/jpg;base64,/9j/')),
  );
  assert.equal(world.images.grabbed.length, 1);
  assert.equal(world.images.grabbed[0], 'rtsp://admin:secret@192.0.2.22:554/stream2');

  // A large snapshot is scaled down before it goes to Gladys.
  world.network.cameras[0].snapshot = LARGE_JPEG;
  const [hik] = world.fake.discoveredDevices;
  const ack = await world.fake.getImage(hik);
  assert.equal(ack.success, true);
  assert.ok(ack.data.image.length < 150 * 1024);
  assert.equal(world.images.fitted.at(-1), LARGE_JPEG.length);

  // The periodic refresh only sends the created devices of the cameras answering.
  const sent = world.fake.cameraImages.length;
  await world.hub.refreshAllImages();
  assert.equal(world.fake.cameraImages.length, sent + 2);
});

test('images are not sent faster than the core takes them', async (t) => {
  const world = await createWorld({ timings: { minImageSpacingMs: 60_000 } });
  t.after(() => world.app.stop());
  await createAll(world);
  await world.hub.refreshAllImages();
  await world.hub.refreshAllImages();
  assert.equal(world.fake.cameraImages.length, 1);
});

test('PTZ: a move ends with a stop, by the user or by the watchdog', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, move_duration: '0.5' } });
  t.after(() => world.app.stop());
  const camera = world.network.cameras[0];
  const [device] = world.fake.discoveredDevices;
  const move = feature(device, 'move');
  assert.deepEqual(
    move.supported_options.map((option) => option.value),
    [1, 2, 3, 4, 5, 6],
  );

  assert.deepEqual(await world.fake.setValue(device, move, MOVES.PAN_RIGHT), { success: true });
  assert.deepEqual(await world.fake.setValue(device, move, MOVES.STOP), { success: true });
  assert.deepEqual(
    camera.moves.map((item) => item.operation),
    ['ContinuousMove', 'Stop'],
  );

  // A lone value (scene, widget, lost release): the watchdog stops it.
  await world.fake.setValue(device, move, MOVES.ZOOM_IN);
  assert.equal(camera.moves.at(-1).operation, 'ContinuousMove');
  await waitFor(() => camera.moves.at(-1).operation === 'Stop', { message: 'watchdog stop' });

  // Another direction while moving: stop first.
  await world.fake.setValue(device, move, MOVES.TILT_UP);
  await world.fake.setValue(device, move, MOVES.TILT_DOWN);
  assert.deepEqual(
    camera.moves.slice(-3).map((item) => item.operation),
    ['ContinuousMove', 'Stop', 'ContinuousMove'],
  );
  await world.fake.setValue(device, move, MOVES.STOP);
  // A stop with nothing moving sends nothing.
  const count = camera.moves.length;
  await world.fake.setValue(device, move, MOVES.STOP);
  assert.equal(camera.moves.length, count);
});

test('PTZ: an unsupported move is refused; a camera without continuous moves steps', async (t) => {
  const world = await createWorld({ cameras: [tapo()] });
  t.after(() => world.app.stop());
  const [device] = world.fake.discoveredDevices;
  const ack = await world.fake.setValue(device, feature(device, 'move'), MOVES.ZOOM_IN);
  assert.equal(ack.success, false);
  const [camera] = world.hub.cameras.values();
  camera.sources[0].ptz.continuous.pan = false;
  await world.fake.setValue(device, feature(device, 'move'), MOVES.PAN_LEFT);
  assert.equal(world.network.cameras[0].moves.at(-1).operation, 'RelativeMove');
  const ack2 = await world.fake.setValue(device, feature(device, 'image'), 1);
  assert.equal(ack2.success, false);
});

test('presets: by Gladys value, by name; a renamed preset reaches the device silently', async (t) => {
  const world = await createWorld({ cameras: [tapo()] });
  t.after(() => world.app.stop());
  const camera = world.network.cameras[0];
  const [device] = world.fake.discoveredDevices;
  const preset = feature(device, 'preset');
  assert.deepEqual(preset.supported_options, [
    { value: 1, label: 'Porte', sort_order: 0 },
    { value: 2, label: 'Fenêtre', sort_order: 1 },
  ]);
  await world.fake.setValue(device, preset, 2);
  assert.equal(camera.moves.at(-1).preset, '2');
  const scene = await world.fake.sceneAction('goto_preset', {
    camera: device.external_id,
    preset: ' fenetre ',
  });
  assert.deepEqual(scene, { success: true, data: { outputs: { preset: 'Fenêtre' } } });
  const missing = await world.fake.sceneAction('goto_preset', {
    camera: device.external_id,
    preset: 'Garage',
  });
  assert.equal(missing.success, false);
  camera.presets[0].name = 'Entrée';
  await world.fake.scanRequest();
  assert.equal(
    feature(world.fake.discoveredDevices[0], 'preset').supported_options[0].label,
    'Entrée',
  );
  assert.equal(findPreset([{ token: 'a', name: 'X', value: 3 }], 3).token, 'a');
});

test('events: states, one trigger per detection, initial states silent, pulses', async (t) => {
  const camera = tapo();
  camera.initialState = ['tapo-person'];
  const world = await createWorld({ cameras: [camera], events: true });
  t.after(() => world.app.stop());
  await createAll(world);
  const [device] = world.fake.discoveredDevices;
  const id = (key) => feature(device, key).external_id;
  await waitFor(() => camera.operations().includes('PullMessages'), { message: 'first pull' });
  await waitFor(() => world.fake.lastState(id('person')) === 0, { message: 'initial state' });
  assert.equal(world.fake.sceneEvents.length, 0, 'an initial state is not an event');

  camera.emit('tapo-person');
  await waitFor(() => world.fake.lastState(id('person')) === 1, { message: 'person on' });
  await waitFor(() => world.fake.sceneEvents.length === 1, { message: 'trigger' });
  assert.deepEqual(world.fake.sceneEvents[0], {
    key: TRIGGER,
    data: { camera: device.external_id, kind: 'person', rule: 'MyPeopleDetectorRule' },
  });
  // The same state again: nothing new.
  camera.emit('tapo-person');
  camera.emit('tapo-person', { value: false });
  await waitFor(() => world.fake.lastState(id('person')) === 0, { message: 'person off' });
  assert.equal(world.fake.sceneEvents.length, 1);

  // A line crossed (Tapo: true then false) and a detection of another source token.
  camera.emit('tapo-line-cross');
  await waitFor(() => world.fake.lastState(id('line-crossing')) === 1, { message: 'line' });
  assert.equal(world.fake.sceneEvents.at(-1).data.kind, 'line_crossing');
});

test('events: a pulse goes back to 0, a new kind is added to the device', async (t) => {
  const camera = hikvision();
  const world = await createWorld({ cameras: [camera], events: true });
  t.after(() => world.app.stop());
  await createAll(world);
  const [device] = world.fake.discoveredDevices;
  assert.ok(!feature(device, 'person'));
  camera.emit('line-detector-crossed');
  await waitFor(() => world.fake.lastState(feature(device, 'line-crossing').external_id) === 1, {
    message: 'pulse',
  });
  await waitFor(() => world.fake.lastState(feature(device, 'line-crossing').external_id) === 0, {
    message: 'pulse end',
  });
  camera.emit('reolink-person');
  await waitFor(() => feature(world.fake.discoveredDevices[0], 'person'), {
    message: 'republished with person',
  });
  await waitFor(() => world.fake.sceneEvents.some((event) => event.data.kind === 'person'), {
    message: 'person trigger',
  });
});

test('events: the subscription ends on stop, and starts again after an error', async (t) => {
  const camera = hikvision();
  const world = await createWorld({ cameras: [camera], events: true });
  t.after(() => world.app.stop());
  await waitFor(() => camera.operations().includes('PullMessages'), { message: 'pull' });
  camera.subscriptions.clear(); // the camera forgot it (reboot)
  await waitFor(
    () => camera.operations().filter((op) => op === 'CreatePullPointSubscription').length === 2,
    {
      message: 'new subscription',
    },
  );
  await world.app.stop();
  assert.equal(camera.operations().at(-1), 'Unsubscribe');
});

test('a camera that stops answering is unreachable, and comes back', async (t) => {
  const world = await createWorld({ cameras: [hikvision()] });
  t.after(() => world.app.stop());
  await createAll(world);
  const [camera] = world.network.cameras;
  camera.online = false;
  await world.hub.checkAll();
  await world.hub.checkAll();
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  assert.deepEqual(world.fake.connectionStatus.connected, false);
  camera.online = true;
  await world.hub.checkAll();
  await world.hub.idle();
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('another camera at the address of a known one does not take its place', async (t) => {
  const world = await createWorld({ cameras: [hikvision()] });
  t.after(() => world.app.stop());
  await createAll(world);
  const [old] = world.fake.discoveredDevices;
  world.network.cameras[0] = new FakeCamera({
    model: 'hikvision',
    host: '192.0.2.21',
    mac: '02-00-5E-10-00-09',
  });
  await world.fake.scanRequest();
  assert.equal(world.fake.discoveredDevices.length, 2);
  await world.hub.checkAll();
  const ack = await world.fake.getImage(old);
  assert.equal(ack.success, false, 'never the image of the other camera');
});

test('restart: known cameras are published before they answer', async (t) => {
  const first = await createWorld({ cameras: [hikvision()] });
  await first.app.stop();
  const world = await createWorld({ cameras: [], dataDir: first.dataDir, scan: false });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 1);
  assert.equal(world.fake.connectionStatus.connected, false);
});

test('reconfiguration: names in another language, faster images', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await world.fake.configUpdated({ ...DEFAULT_CONFIG, language: 'es', snapshot_interval: '10' });
  assert.equal(feature(world.fake.discoveredDevices[0], 'move').name, 'Movimiento (PTZ)');
  assert.equal(world.hub.config.snapshotSeconds, 10);
  assert.deepEqual(
    world.hub.config,
    normalizeConfig({ ...DEFAULT_CONFIG, language: 'es', snapshot_interval: '10' }),
  );
});

test('unique ids: MAC first, else serial number', () => {
  assert.equal(normalizeMac('5A-C3-55-C1-13-78'), '5ac355c11378');
  assert.equal(normalizeMac('00:00:00:00:00:00'), null);
  assert.equal(uniqueId({ mac: null, serial: 'DS-2CD 123' }), 'sn-DS-2CD123');
  assert.equal(uniqueId({ mac: '', serial: '0000' }), null);
});

test('the images come from the container timer, with no poll from Gladys', async (t) => {
  // Gladys 5.2.0 never polls a device created without should_poll (#3198):
  // the integration must not wait for onPoll, and the test never calls it.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const world = await createWorld({
    cameras: [hikvision()],
    timers: true,
    config: { ...DEFAULT_CONFIG, snapshot_interval: '60' },
    timings: { minImageSpacingMs: 0 },
  });
  t.after(() => world.app.stop());
  await createAll(world);
  const sent = world.fake.cameraImages.length;
  for (let round = 1; round <= 3; round += 1) {
    t.mock.timers.tick(60_000);
    await world.hub.idle();
    assert.equal(world.fake.cameraImages.length, sent + round, `image round ${round}`);
  }
});
