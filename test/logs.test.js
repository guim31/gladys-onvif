// The info level keeps the life of the integration only (start, cameras found,
// lost, back): nothing per image, per state, per event or per search, and a
// failure tried again and again is one line, then one when it ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeCamera, createAll, createWorld, waitFor } from './helpers/world.js';
import { soapFault } from './helpers/fakeCamera.js';

const tapo = () => new FakeCamera({ model: 'tapo', host: '192.0.2.22', mac: '02-00-5E-10-00-03' });
const hikvision = () =>
  new FakeCamera({ model: 'hikvision', host: '192.0.2.21', mac: '02-00-5E-10-00-02' });

/** Capture what the SDK logger writes (console.log / console.error) at `info`. */
function captureLogs(t) {
  const lines = [];
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const keep = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'log', keep);
  t.mock.method(console, 'error', keep);
  const restore = () => {
    process.env.LOG_LEVEL = previous;
    t.mock.restoreAll();
  };
  t.after(restore);
  return { lines, restore };
}

const count = (lines, text) => lines.filter((line) => line.includes(text)).length;

test('a normal cycle (images, states, events, health, search) writes nothing at info', async (t) => {
  const cameras = [hikvision(), tapo()];
  const world = await createWorld({ cameras, events: true });
  t.after(() => world.app.stop());
  await createAll(world);
  await waitFor(() => cameras.every((camera) => camera.operations().includes('PullMessages')), {
    message: 'first pulls',
  });

  const { lines, restore } = captureLogs(t);
  for (let round = 0; round < 3; round += 1) {
    await world.hub.refreshAllImages();
    await world.hub.checkAll();
    await world.hub.publishAllStates();
  }
  cameras[1].emit('tapo-person');
  cameras[1].emit('tapo-person', { value: false });
  cameras[0].emit('line-detector-crossed');
  // A detection kind the camera did not declare: the device gets the feature.
  cameras[0].emit('reolink-person');
  await waitFor(() => world.fake.sceneEvents.length >= 3, { message: 'events received' });
  await world.hub.rediscover();
  await world.hub.idle();
  restore();
  assert.deepEqual(lines, []);
});

test('a failure tried again and again is one line, then one when it ends', async (t) => {
  const camera = tapo();
  const world = await createWorld({ cameras: [camera] });
  t.after(() => world.app.stop());
  await createAll(world);
  const { lines } = captureLogs(t);

  // The RTSP stream (Tapo: no snapshot address) fails at every image round.
  const grab = world.images.grab.bind(world.images);
  let broken = true;
  world.images.grab = async (url) => {
    if (broken) {
      throw new Error('ffmpeg exited with code 1');
    }
    return grab(url);
  };
  for (let round = 0; round < 4; round += 1) {
    await world.hub.refreshAllImages();
  }
  broken = false;
  await world.hub.refreshAllImages();
  await world.hub.refreshAllImages();
  assert.equal(count(lines, 'No frame from the stream'), 1);
  assert.equal(count(lines, 'gives images again'), 1);

  // The search through Gladys (every 15 minutes) fails.
  const scanNetwork = world.gladys.scanNetwork.bind(world.gladys);
  world.gladys.scanNetwork = async () => {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  };
  for (let round = 0; round < 3; round += 1) {
    await world.hub.scan();
  }
  world.gladys.scanNetwork = scanNetwork;
  await world.hub.scan();
  await world.hub.scan();
  assert.equal(count(lines, 'Camera discovery through Gladys failed'), 1);
  assert.equal(count(lines, 'discovery through Gladys works again'), 1);

  // Gladys does not take the states.
  const publish = world.gladys.publishChangedStates.bind(world.gladys);
  world.gladys.publishChangedStates = async () => {
    throw new Error('Gladys is away');
  };
  for (let round = 0; round < 3; round += 1) {
    await world.hub.publishAllStates();
  }
  world.gladys.publishChangedStates = publish;
  world.gladys.forgetPublishedStates();
  await world.hub.publishAllStates();
  await world.hub.publishAllStates();
  assert.equal(count(lines, 'Cannot publish the states'), 1);
  assert.equal(count(lines, 'States are published to Gladys again'), 1);

  assert.equal(lines.length, 6, lines.join('\n'));
});

test('an event subscription refused again and again is one line, then one when it works', async (t) => {
  const camera = hikvision();
  let refusals = 4;
  const answer = camera.answer.bind(camera);
  camera.answer = (operation, ...rest) =>
    operation === 'CreatePullPointSubscription' && refusals-- > 0
      ? { fault: soapFault('Too many subscriptions', 'MaxPullPointsReached') }
      : answer(operation, ...rest);
  const { lines } = captureLogs(t);
  const world = await createWorld({ cameras: [camera], events: true });
  t.after(() => world.app.stop());
  await waitFor(() => camera.operations().includes('PullMessages'), { message: 'pull' });
  assert.equal(count(lines, 'interrupted'), 1);
  assert.equal(count(lines, 'Following the events of'), 1);
  assert.equal(count(lines, 'again'), 1);
});
