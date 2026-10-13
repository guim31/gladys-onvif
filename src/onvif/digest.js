// -----------------------------------------------------------------------------
// HTTP Digest authentication (RFC 2617 / 7616, MD5, qop "auth"): most cameras
// protect their snapshot address with it, and a few their SOAP services too.
// The camera answers 401 with a challenge, the request is sent again with a
// response computed from the user name, the password and the challenge. The
// password itself never travels.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

/**
 * The parameters of a `WWW-Authenticate: Digest …` header, keys lower-cased,
 * or null when it is not a Digest challenge.
 */
export function parseChallenge(header) {
  const text = String(header ?? '').trim();
  const match = text.match(/^Digest\s+(.*)$/is);
  if (!match) {
    return null;
  }
  const params = {};
  const pattern = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi;
  for (const [, key, quoted, bare] of match[1].matchAll(pattern)) {
    params[key.toLowerCase()] = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : bare;
  }
  return params.nonce && params.realm !== undefined ? params : null;
}

/**
 * The `Authorization` header answering a challenge.
 * @param {object} options
 * @param {object} options.challenge from parseChallenge
 * @param {string} options.username
 * @param {string} options.password
 * @param {string} options.method HTTP method
 * @param {string} options.uri request path (with its query string)
 * @param {number} options.nc request counter for this nonce (1, 2…)
 * @param {string} [options.cnonce] client nonce (random by default)
 */
export function authorization({
  challenge,
  username,
  password,
  method,
  uri,
  nc,
  cnonce = randomBytes(8).toString('hex'),
}) {
  const algorithm = challenge.algorithm ?? 'MD5';
  let ha1 = md5(`${username}:${challenge.realm}:${password}`);
  if (/^MD5-sess$/i.test(algorithm)) {
    ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  }
  const ha2 = md5(`${method}:${uri}`);
  const qops = String(challenge.qop ?? '')
    .split(',')
    .map((qop) => qop.trim());
  const count = nc.toString(16).padStart(8, '0');
  const quote = (value) => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`,
  ];
  if (qops.includes('auth')) {
    const response = md5(`${ha1}:${challenge.nonce}:${count}:${cnonce}:auth:${ha2}`);
    parts.push(`response=${quote(response)}`, 'qop=auth', `nc=${count}`, `cnonce=${quote(cnonce)}`);
  } else {
    // RFC 2069 compatibility: no qop offered.
    parts.push(`response=${quote(md5(`${ha1}:${challenge.nonce}:${ha2}`))}`);
  }
  if (challenge.algorithm) {
    parts.push(`algorithm=${challenge.algorithm}`);
  }
  if (challenge.opaque !== undefined) {
    parts.push(`opaque=${quote(challenge.opaque)}`);
  }
  return `Digest ${parts.join(', ')}`;
}
