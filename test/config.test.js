import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  accountsFingerprint,
  normalizeConfig,
  parseAddress,
  parseHosts,
} from '../src/config.js';

test('addresses: IP, name, port, full device service address', () => {
  assert.deepEqual(parseAddress('192.0.002.020'), {
    host: '192.0.2.20',
    port: 80,
    path: '/onvif/device_service',
  });
  assert.deepEqual(parseAddress('cam.lan:2020'), {
    host: 'cam.lan',
    port: 2020,
    path: '/onvif/device_service',
  });
  assert.deepEqual(parseAddress('http://192.0.2.5:8000/onvif/device'), {
    host: '192.0.2.5',
    port: 8000,
    path: '/onvif/device',
  });
  for (const bad of [
    '',
    '300.1.1.1',
    '1234',
    '10.0.0',
    'https://192.0.2.5',
    'http://u:p@192.0.2.5',
    'a_b',
    'http://x/?q=1',
  ]) {
    assert.equal(parseAddress(bad), null, bad);
  }
  const { hosts, invalid } = parseHosts('192.0.2.5, 192.0.2.5;cam.lan:2020\n bad!');
  assert.deepEqual(
    hosts.map((host) => `${host.host}:${host.port}`),
    ['192.0.2.5:80', 'cam.lan:2020'],
  );
  assert.deepEqual(invalid, ['bad!']);
});

test('defaults, accounts and their fingerprint', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config.hosts, []);
  assert.deepEqual(config.accounts, []);
  assert.equal(config.snapshotSeconds, Number(DEFAULT_CONFIG.snapshot_interval));
  assert.equal(config.moveMs, 1000);
  assert.equal(config.language, 'fr');
  const full = normalizeConfig({
    username: ' admin ',
    password: 'a',
    username_2: '',
    password_2: 'ignored',
    username_3: 'viewer',
    snapshot_interval: '10',
    move_duration: '0.5',
    language: 'de',
  });
  assert.deepEqual(full.accounts, [
    { username: 'admin', password: 'a' },
    { username: 'viewer', password: '' },
  ]);
  assert.equal(full.snapshotSeconds, 10);
  assert.equal(full.moveMs, 500);
  assert.equal(
    normalizeConfig({ snapshot_interval: '7', move_duration: '9', language: 'it' }).moveMs,
    1000,
  );
  assert.notEqual(full.accountsKey, accountsFingerprint([{ username: 'admin', password: 'b' }]));
  assert.ok(!full.accountsKey.includes('a') || full.accountsKey.length === 16);
  assert.equal(normalizeConfig(null).language, 'fr');
});
