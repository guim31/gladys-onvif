import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OnvifCamera,
  isImage,
  parseOnvifTime,
  ptzCapabilities,
  readNotification,
} from '../src/onvif/camera.js';
import { groupSources } from '../src/hub.js';
import { FakeCamera, SMALL_JPEG, createNetwork } from './helpers/fakeCamera.js';

const account = { username: 'admin', password: 'secret' };

function connect(options = {}, credentials = account) {
  const fake = new FakeCamera(options);
  const network = createNetwork([fake]);
  const client = new OnvifCamera({
    host: fake.host,
    port: fake.port,
    credentials,
    request: (request) => network.request(request),
  });
  return { fake, client };
}

test('the recorded Happytime server: identity, services, profiles, PTZ', async () => {
  const { fake, client } = connect();
  await client.syncTime();
  assert.equal(fake.calls[0].auth, 'missing', 'the clock is read without account');
  assert.deepEqual(await client.getDeviceInformation(), {
    manufacturer: 'Happytimesoft',
    model: 'IPCamera',
    firmware: '2.4',
    serial: '123456',
    hardwareId: '1.0',
  });
  assert.equal(await client.getMacAddress(), '02-00-5E-10-00-01');
  const { services, pullPoint } = await client.getServices();
  assert.equal(services.media, 'http://192.0.2.20:8000/onvif/media_service');
  assert.equal(services.ptz, 'http://192.0.2.20:8000/onvif/ptz_service');
  assert.equal(services.events, 'http://192.0.2.20:8000/onvif/event_service');
  assert.equal(pullPoint, true);
  const profiles = await client.getProfiles();
  assert.deepEqual(
    profiles.map((profile) => [profile.token, profile.sourceToken, profile.width, profile.height]),
    [
      ['ProfileToken_1', 'VideoSourceToken_1', 1280, 720],
      ['ProfileToken_2', 'VideoSourceToken_1', 640, 480],
    ],
  );
  const [source] = groupSources(profiles);
  assert.deepEqual(
    [source.mainProfile, source.subProfile, source.ptzProfile, source.configTokens],
    ['ProfileToken_1', 'ProfileToken_2', 'ProfileToken_1', ['VideoSourceConfigurationToken_1']],
  );
  const [node] = await client.getNodes();
  const ptz = ptzCapabilities(profiles[0].ptzConfiguration, node);
  assert.deepEqual(ptz.continuous, { pan: true, tilt: true, zoom: true });
  assert.equal(ptz.maxPresets, 100);
  assert.deepEqual(
    (await client.getPresets('ProfileToken_1')).map((preset) => preset.name),
    ['Gate', 'Garden', 'Gate', 'Garden', 'Portail'],
  );
  assert.equal(
    await client.getSnapshotUri('ProfileToken_1'),
    'http://192.0.2.20:8000/snapshot/ProfileToken_1',
  );
  assert.match(
    await client.getStreamUri('ProfileToken_2'),
    /^rtsp:\/\/192\.0\.2\.20:554\/test\.mp4/,
  );
  assert.ok(isImage(await client.fetchSnapshot(await client.getSnapshotUri('ProfileToken_1'))));
  await assert.rejects(client.getSnapshotUri('nope'), {
    kind: 'fault',
    message: 'Profile Not Exist',
  });
});

test('a camera with its clock an hour ahead accepts the requests once synced', async () => {
  const { client } = connect({ model: 'tapo', clockOffsetMs: 3600_000 });
  await assert.rejects(client.getDeviceInformation(), { kind: 'auth' });
  const offset = await client.syncTime();
  assert.ok(Math.abs(offset - 3600_000) < 2000, `offset ${offset}`);
  assert.equal((await client.getDeviceInformation()).model, 'C200');
});

test('a wrong password is an auth error; the dummy interface is skipped', async () => {
  const { client } = connect({ model: 'hikvision' }, { username: 'admin', password: 'wrong' });
  await assert.rejects(client.getDeviceInformation(), (err) => err.kind === 'auth');
  client.credentials = account;
  assert.equal(await client.getMacAddress(), '02-00-5E-10-00-01');
});

test('Hikvision: no PTZ, Digest on the snapshot, dashed subscription times', async () => {
  const { client } = connect({ model: 'hikvision' });
  await client.syncTime();
  const { services } = await client.getServices();
  assert.equal(services.ptz, undefined);
  const uri = await client.getSnapshotUri('Profile_1');
  assert.equal(uri, 'http://192.0.2.20/onvif-http/snapshot?Profile_1');
  assert.deepEqual(await client.fetchSnapshot(uri), SMALL_JPEG);
  client.credentials = { username: 'admin', password: 'wrong' };
  await assert.rejects(client.fetchSnapshot(uri), { kind: 'auth' });
  client.credentials = account;
  const subscription = await client.createPullPoint(600);
  assert.equal(subscription.ttlMs, 60_000);
  assert.equal(parseOnvifTime('2024-08-17-12:30:45Z'), Date.parse('2024-08-17T12:30:45Z'));
});

test('Tapo: pan and tilt only, reference parameters echoed in the pulls', async () => {
  const { fake, client } = connect({ model: 'tapo' });
  await client.syncTime();
  await client.getServices();
  const profiles = await client.getProfiles();
  const [node] = await client.getNodes();
  const ptz = ptzCapabilities(profiles[0].ptzConfiguration, node);
  assert.deepEqual(ptz.continuous, { pan: true, tilt: true, zoom: false });
  await assert.rejects(client.getSnapshotUri('profile_1'), { kind: 'fault' });
  const subscription = await client.createPullPoint(600);
  assert.match(
    subscription.referenceParameters,
    /<tt:SubscriptionId xmlns:tt="[^"]+">42<\/tt:SubscriptionId>/,
  );
  fake.emit('tapo-person');
  const { notifications } = await client.pullMessages(subscription, { timeoutSeconds: 1 });
  const header = fake.calls.at(-1).headers;
  assert.ok(header.children.some((item) => item.name === 'SubscriptionId'));
  assert.equal(notifications[0].topic, 'tns1:RuleEngine/CellMotionDetector/People');
  assert.deepEqual(notifications[0].data, [{ name: 'IsPeople', value: 'true' }]);
  await client.continuousMove('profile_1', { x: -0.5, y: 0 });
  await client.stop('profile_1');
  assert.deepEqual(
    fake.moves.map((move) => move.operation),
    ['ContinuousMove', 'Stop'],
  );
  const panTilt = fake.moves[0].xml.children[1].children[0];
  assert.deepEqual(panTilt.attrs, { x: '-0.5', y: '0' });
});

test('addresses the camera gives are pointed at the host that answered', () => {
  const client = new OnvifCamera({ host: '192.0.2.30', port: 8080 });
  client.reportedPort = 80;
  assert.equal(
    client.fixUrl('http://198.51.100.5/onvif/Media'),
    'http://192.0.2.30:8080/onvif/Media',
  );
  assert.equal(
    client.fixUrl('http://198.51.100.5:8999/snap.jpg?x=1'),
    'http://192.0.2.30:8999/snap.jpg?x=1',
  );
  assert.equal(client.fixUrl('garbage'), null);
});

test('a notification without topic or message is ignored', () => {
  assert.equal(
    readNotification({ name: 'NotificationMessage', attrs: {}, children: [], text: '' }),
    null,
  );
  assert.equal(isImage(Buffer.from('<html>')), false);
});
