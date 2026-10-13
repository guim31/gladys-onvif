import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HttpError } from '../src/onvif/http.js';
import {
  OnvifError,
  envelope,
  readFault,
  securityHeader,
  soapCall,
  zuluTime,
} from '../src/onvif/soap.js';
import { find, parseXml, textOf } from '../src/onvif/xml.js';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/onvif/happytime/${name}.xml`, import.meta.url), 'utf8');
const answer =
  (status, body, authenticate = []) =>
  async () => ({
    status,
    headers: {},
    authenticate,
    body: Buffer.from(body),
  });

test('the password digest follows the UsernameToken profile, in Zulu time', () => {
  const nonce = Buffer.from('0123456789abcdef');
  const created = new Date('2024-08-17T12:30:45.678Z');
  const xml = securityHeader({ username: 'ad<min', password: 'pässword', created, nonce });
  const token = find(parseXml(`<s:x xmlns:s="urn:s">${xml}</s:x>`), 'UsernameToken');
  assert.equal(textOf(token, 'Username'), 'ad<min');
  assert.equal(textOf(token, 'Created'), '2024-08-17T12:30:45Z');
  const expected = createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from('2024-08-17T12:30:45Z'), Buffer.from('pässword')]))
    .digest('base64');
  assert.equal(textOf(token, 'Password'), expected);
  assert.ok(!xml.includes('pässword'), 'the password never travels');
  assert.equal(zuluTime(new Date(0)), '1970-01-01T00:00:00Z');
});

test('the envelope carries the token only with an account, at the camera time', () => {
  assert.ok(!envelope('<tds:GetSystemDateAndTime/>', {}).includes('Security'));
  const xml = envelope('<x/>', {
    credentials: { username: 'u', password: 'p' },
    timeOffsetMs: 3600_000,
    now: Date.parse('2024-01-01T00:00:00Z'),
  });
  assert.match(xml, /<wsu:Created>2024-01-01T01:00:00Z<\/wsu:Created>/);
});

test('SOAP faults are read, refused credentials told apart', () => {
  const fault = readFault(parseXml(fixture('Fault-GotoPreset')));
  assert.deepEqual(fault.subcodes, ['Action', 'NoToken']);
  assert.equal(fault.reason, 'The requested token does not exist.');
  assert.equal(readFault(parseXml(fixture('Stop'))), null);
});

test('soapCall resolves with the answer element, or throws a typed error', async () => {
  const ok = await soapCall({
    url: 'http://192.0.2.1/x',
    body: '<x/>',
    request: answer(200, fixture('Stop')),
  });
  assert.equal(ok.name, 'StopResponse');

  const cases = [
    [answer(400, fixture('Fault-GotoPreset')), 'fault', 'NoToken'],
    [
      answer(
        400,
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body><e:Fault><e:Code><e:Value>e:Sender</e:Value><e:Subcode><e:Value>ter:NotAuthorized</e:Value></e:Subcode></e:Code><e:Reason><e:Text>Sender not Authorized</e:Text></e:Reason></e:Fault></e:Body></e:Envelope>',
      ),
      'auth',
      'NotAuthorized',
    ],
    [answer(401, ''), 'auth', ''],
    [answer(500, 'oops'), 'http', ''],
    [answer(200, 'not xml'), 'parse', ''],
    [
      async () => {
        throw new HttpError('connect EHOSTUNREACH', { code: 'EHOSTUNREACH' });
      },
      'network',
      '',
    ],
  ];
  for (const [request, kind, subcode] of cases) {
    await assert.rejects(
      soapCall({ url: 'http://192.0.2.1/x', body: '<x/>', request }),
      (err) => err instanceof OnvifError && err.kind === kind && err.subcode === subcode,
      kind,
    );
  }
});
