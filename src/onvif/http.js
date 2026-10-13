// -----------------------------------------------------------------------------
// The one place that opens HTTP connections to the cameras: a request function
// over node:http / node:https, bounded in time (idle AND total) and in size,
// and the HTTP authentication most cameras ask for (Digest, sometimes Basic)
// on their snapshot address. It is the seam the tests replace with simulated
// cameras (test/helpers/fakeCamera.js).
//
// HTTPS: cameras serve self-signed certificates, so they are not verified —
// the same choice as Home Assistant. The traffic stays encrypted on the LAN.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { authorization, parseChallenge } from './digest.js';

export const DEFAULT_TIMEOUT_MS = 10000;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class HttpError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message, { cause });
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {object} request
 * @param {string} request.method
 * @param {string} request.url absolute URL
 * @param {Record<string, string>} [request.headers]
 * @param {string | Buffer} [request.body]
 * @param {number} [request.timeoutMs] whole request, connection included
 * @param {number} [request.maxBytes] largest body accepted
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<{ status: number, headers: object, authenticate: string[], body: Buffer }>}
 */
export function httpRequest({
  method,
  url,
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
  signal,
}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new HttpError('Invalid URL', { code: 'EINVALIDURL', cause: err }));
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new HttpError(`Unsupported protocol ${target.protocol}`, { code: 'EPROTOCOL' }));
      return;
    }
    if (signal?.aborted) {
      reject(new HttpError('Request aborted', { code: 'EABORTED' }));
      return;
    }
    const secure = target.protocol === 'https:';
    const payload = body === undefined ? undefined : Buffer.from(body);
    let settled = false;
    const done = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      }
    };
    // The URL may carry credentials (user:pass@ or a query string): requests
    // are made from its parts, never logged.
    const req = (secure ? https : http).request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method,
        headers: payload ? { ...headers, 'content-length': payload.length } : headers,
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            fail(new HttpError('Response too large', { code: 'ETOOBIG' }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const authenticate = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            if (res.rawHeaders[i].toLowerCase() === 'www-authenticate') {
              authenticate.push(res.rawHeaders[i + 1]);
            }
          }
          done(resolve, {
            status: res.statusCode,
            headers: res.headers,
            authenticate,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', (err) => done(reject, toHttpError(err)));
        res.on('aborted', () =>
          done(reject, new HttpError('Connection closed', { code: 'ECONNRESET' })),
        );
      },
    );
    // Settle first, then tear the connection down without an error: an error
    // given to destroy() once the answer has started has no listener left.
    const fail = (err) => {
      done(reject, err);
      req.destroy();
    };
    const timer = setTimeout(() => {
      fail(new HttpError('Request timed out', { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    const onAbort = () => fail(new HttpError('Request aborted', { code: 'EABORTED' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => done(reject, toHttpError(err)));
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function toHttpError(err) {
  return err instanceof HttpError
    ? err
    : new HttpError(err.message, { code: err.code ?? 'ENETWORK', cause: err });
}

/**
 * A request that answers the camera's HTTP authentication challenge, if any:
 * Digest first (the password never travels), Basic only when it is the one
 * scheme offered. Credentials given in the URL itself (`user:pass@`) are used
 * when none are passed.
 * @param {object} options httpRequest options, plus:
 * @param {{ username: string, password: string } | null} [options.credentials]
 * @param {Function} [options.request] httpRequest (tests replace it)
 */
export async function requestWithAuth({ credentials, request = httpRequest, ...options }) {
  const target = new URL(options.url);
  const account =
    credentials ??
    (target.username
      ? {
          username: decodeURIComponent(target.username),
          password: decodeURIComponent(target.password),
        }
      : null);
  if (target.username) {
    target.username = '';
    target.password = '';
  }
  const url = target.toString();
  const first = await request({ ...options, url });
  if (first.status !== 401 || !account) {
    return first;
  }
  const uri = `${target.pathname}${target.search}`;
  const digest = first.authenticate.map(parseChallenge).find(Boolean);
  if (digest) {
    return request({
      ...options,
      url,
      headers: {
        ...options.headers,
        authorization: authorization({
          challenge: digest,
          username: account.username,
          password: account.password,
          method: options.method,
          uri,
          nc: 1,
        }),
      },
    });
  }
  if (first.authenticate.some((header) => /^\s*basic\b/i.test(header))) {
    const token = Buffer.from(`${account.username}:${account.password}`, 'utf8').toString('base64');
    return request({
      ...options,
      url,
      headers: { ...options.headers, authorization: `Basic ${token}` },
    });
  }
  return first;
}

/** An address fit for the logs: no credentials, no query string. */
export function redactUrl(url) {
  try {
    const target = new URL(url);
    return `${target.protocol}//${target.host}${target.pathname}`;
  } catch {
    return '(invalid address)';
  }
}
