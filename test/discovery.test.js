import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_PAYLOAD_BYTES,
  WS_DISCOVERY_PORT,
  isIpv4,
  mapLimit,
  parseProbeMatches,
  probeMessage,
  scanRequest,
} from '../src/discovery.js';
import { child, parseXml, path, textOf } from '../src/onvif/xml.js';

const reply = (ip, xml) => ({
  source_ip: ip,
  source_port: 3702,
  payload_base64: Buffer.from(xml).toString('base64'),
});
const recorded = readFileSync(
  new URL('./fixtures/onvif/happytime/ProbeMatches.xml', import.meta.url),
  'utf8',
);

test('the probe fits the 512 bytes the core allows, and is a WS-Discovery Probe', () => {
  const payload = probeMessage();
  assert.ok(payload.length <= MAX_PAYLOAD_BYTES, `${payload.length} bytes`);
  const root = parseXml(payload);
  assert.equal(
    textOf(child(root, 'Header'), 'Action'),
    'http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe',
  );
  assert.ok(path(root, 'Body', 'Probe'));
  assert.notEqual(
    textOf(child(root, 'Header'), 'MessageID'),
    textOf(child(parseXml(probeMessage()), 'Header'), 'MessageID'),
  );
  const request = scanRequest();
  assert.equal(request.port, WS_DISCOVERY_PORT);
  assert.ok(request.timeoutSeconds >= 1 && request.timeoutSeconds <= 30);
});

test('the recorded answer of the Happytime server is a camera', () => {
  const found = parseProbeMatches([
    reply('192.0.2.40', recorded.replaceAll('{{host}}', '192.0.2.40')),
  ]);
  assert.deepEqual(found, [
    {
      host: '192.0.2.40',
      port: 8000,
      path: '/onvif/device_service',
      endpoint: 'urn:uuid:f1f31b87-a5ec-8d7b-56aa-e47a79ab199e',
      name: 'IP-Camera',
      hardware: 'HI3518C',
    },
  ]);
});

test('the address it came from wins over the one it announces; printers are left out', () => {
  const camera = recorded.replaceAll('{{host}}', '198.51.100.9');
  const printer = recorded
    .replace('dn:NetworkVideoTransmitter tds:Device', 'wsdp:Device wprt:PrintDeviceType')
    .replace(/onvif:\/\/www\.onvif\.org\/[^ <]+/g, '');
  const found = parseProbeMatches([
    reply('192.0.2.41', camera),
    reply('192.0.2.42', printer),
    reply('192.0.2.41', camera),
    reply('not-an-ip', camera),
    reply('192.0.2.43', 'garbage'),
    null,
  ]);
  assert.deepEqual(
    found.map((item) => [item.host, item.port]),
    [['192.0.2.41', 8000]],
  );
  assert.deepEqual(parseProbeMatches('nope'), []);
});

test('helpers', async () => {
  assert.equal(isIpv4('192.0.2.1'), true);
  assert.equal(isIpv4('256.0.0.1'), false);
  const results = await mapLimit([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('two');
    return n * 10;
  });
  assert.deepEqual(
    results.map((r) => r.value ?? r.error.message),
    [10, 'two', 30],
  );
});
