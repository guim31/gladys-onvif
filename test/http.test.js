import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseChallenge } from '../src/onvif/digest.js';
import { httpRequest, redactUrl, requestWithAuth } from '../src/onvif/http.js';

test('a Digest challenge is answered, the password never sent', async () => {
  const seen = [];
  const request = async (options) => {
    seen.push(options);
    if (!options.headers?.authorization) {
      return {
        status: 401,
        headers: {},
        authenticate: ['Basic realm="x"', 'Digest realm="cam", nonce="n1", qop="auth"'],
        body: Buffer.alloc(0),
      };
    }
    return { status: 200, headers: {}, authenticate: [], body: Buffer.from('ok') };
  };
  const result = await requestWithAuth({
    method: 'GET',
    url: 'http://192.0.2.5/snap?ch=1',
    credentials: { username: 'admin', password: 'secret' },
    request,
  });
  assert.equal(result.status, 200);
  const params = parseChallenge(seen[1].headers.authorization);
  assert.equal(params.username, 'admin');
  assert.equal(params.uri, '/snap?ch=1');
  assert.ok(!seen[1].headers.authorization.includes('secret'));
});

test('Basic only when it is the one scheme; credentials of the URL are used and removed', async () => {
  const seen = [];
  const request = async (options) => {
    seen.push(options);
    return options.headers?.authorization
      ? { status: 200, headers: {}, authenticate: [], body: Buffer.alloc(0) }
      : { status: 401, headers: {}, authenticate: ['Basic realm="x"'], body: Buffer.alloc(0) };
  };
  await requestWithAuth({ method: 'GET', url: 'http://u%40x:p%3Aw@192.0.2.5/a', request });
  assert.equal(seen[0].url, 'http://192.0.2.5/a');
  assert.equal(seen[1].headers.authorization, `Basic ${Buffer.from('u@x:p:w').toString('base64')}`);
});

test('without account, a 401 is returned as is', async () => {
  const request = async () => ({
    status: 401,
    headers: {},
    authenticate: ['Digest realm="a", nonce="b"'],
    body: Buffer.alloc(0),
  });
  assert.equal(
    (await requestWithAuth({ method: 'GET', url: 'http://192.0.2.5/', request })).status,
    401,
  );
});

test('addresses are logged without credentials nor query', () => {
  assert.equal(redactUrl('http://u:p@192.0.2.5:81/a/b?user=x&pwd=y'), 'http://192.0.2.5:81/a/b');
  assert.equal(redactUrl('not a url'), '(invalid address)');
});

test('requests are bounded in time and size (local server)', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      return; // never answers
    }
    if (req.url === '/big') {
      res.end(Buffer.alloc(2048));
      return;
    }
    res.setHeader('www-authenticate', ['Digest realm="a", nonce="b"', 'Basic realm="a"']);
    res.statusCode = 401;
    res.end('no');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(httpRequest({ method: 'GET', url: `${base}/slow`, timeoutMs: 100 }), {
    code: 'ETIMEDOUT',
  });
  await assert.rejects(httpRequest({ method: 'GET', url: `${base}/big`, maxBytes: 1024 }), {
    code: 'ETOOBIG',
  });
  const denied = await httpRequest({ method: 'GET', url: `${base}/` });
  assert.equal(denied.status, 401);
  assert.equal(denied.authenticate.length, 2);
  const controller = new AbortController();
  const pending = httpRequest({ method: 'GET', url: `${base}/slow`, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'EABORTED' });
  await assert.rejects(httpRequest({ method: 'GET', url: 'ftp://x/' }), { code: 'EPROTOCOL' });
});
