// -----------------------------------------------------------------------------
// SOAP 1.2 over HTTP, the way ONVIF devices speak it: an envelope, a
// WS-Security UsernameToken with a password DIGEST (the password never
// travels), and the HTTP Digest authentication a few firmwares ask for on top.
//
// The token carries the creation time, and many cameras refuse a token whose
// time is too far from their own clock: the camera clock offset (read with
// GetSystemDateAndTime, which needs no authentication) is added to it. The
// time is written in the "Zulu" form Hikvision insists on
// (2024-08-17T12:30:45Z, see onvif-zeep-async #122 and #179).
// -----------------------------------------------------------------------------

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpError, httpRequest, requestWithAuth } from './http.js';
import { XmlError, child, escapeXml, find, parseXml, path, textOf } from './xml.js';

export const NS = {
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  tev: 'http://www.onvif.org/ver10/events/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
  wsnt: 'http://docs.oasis-open.org/wsn/b-2',
  wsa: 'http://www.w3.org/2005/08/addressing',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
};

const PASSWORD_DIGEST =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const NONCE_ENCODING =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

export const SOAP_TIMEOUT_MS = 10000;

/**
 * Why a call failed: `auth` (refused credentials), `fault` (the camera
 * answered with a SOAP fault: an unsupported operation, a bad argument),
 * `network` (no answer, timeout, refused connection), `http` (an HTTP error
 * without SOAP fault), `parse` (an answer that is not XML).
 */
export class OnvifError extends Error {
  constructor(message, { kind, subcode = '', status, cause } = {}) {
    super(message, { cause });
    this.name = 'OnvifError';
    this.kind = kind;
    this.subcode = subcode;
    this.status = status;
  }

  get unreachable() {
    return this.kind === 'network';
  }
}

/** `2024-08-17T12:30:45Z`: UTC, whole seconds, Zulu. */
export function zuluTime(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** The WS-Security header of one request. */
export function securityHeader({ username, password, created, nonce = randomBytes(16) }) {
  const createdText = zuluTime(created);
  const digest = createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(createdText, 'utf8'), Buffer.from(password, 'utf8')]))
    .digest('base64');
  return (
    `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" s:mustUnderstand="1">` +
    '<wsse:UsernameToken>' +
    `<wsse:Username>${escapeXml(username)}</wsse:Username>` +
    `<wsse:Password Type="${PASSWORD_DIGEST}">${digest}</wsse:Password>` +
    `<wsse:Nonce EncodingType="${NONCE_ENCODING}">${nonce.toString('base64')}</wsse:Nonce>` +
    `<wsu:Created>${createdText}</wsu:Created>` +
    '</wsse:UsernameToken></wsse:Security>'
  );
}

/**
 * The request envelope. `body` is the operation element, written with the
 * prefixes declared here (tds, trt, tptz, tev, tt, wsnt, wsa).
 */
export function envelope(body, { credentials, timeOffsetMs = 0, headers = '', now = Date.now() }) {
  const security = credentials?.username
    ? securityHeader({ ...credentials, created: new Date(now + timeOffsetMs) })
    : '';
  const prefixes = ['tds', 'trt', 'tptz', 'tev', 'tt', 'wsnt', 'wsa']
    .map((prefix) => ` xmlns:${prefix}="${NS[prefix]}"`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<s:Envelope xmlns:s="${NS.soap}"${prefixes}>` +
    `<s:Header>${security}${headers}</s:Header>` +
    `<s:Body>${body}</s:Body></s:Envelope>`
  );
}

/** WS-Addressing headers: the event subscriptions need them on some firmwares. */
export function addressingHeaders({ action, to, referenceParameters = '' }) {
  return (
    `<wsa:Action>${escapeXml(action)}</wsa:Action>` +
    `<wsa:MessageID>urn:uuid:${randomUUID()}</wsa:MessageID>` +
    `<wsa:To>${escapeXml(to)}</wsa:To>` +
    referenceParameters
  );
}

/** The SOAP fault of an answer, or null. Handles SOAP 1.2 and 1.1. */
export function readFault(root) {
  const body = child(root, 'Body');
  const fault = child(body, 'Fault');
  if (!fault) {
    return null;
  }
  // SOAP 1.2: Code/Value, Code/Subcode/Value (nested), Reason/Text.
  const subcodes = [];
  let subcode = path(fault, 'Code', 'Subcode');
  while (subcode) {
    subcodes.push(stripPrefix(textOf(subcode, 'Value')));
    subcode = child(subcode, 'Subcode');
  }
  const code = stripPrefix(textOf(path(fault, 'Code'), 'Value') || textOf(fault, 'faultcode'));
  const reason =
    textOf(path(fault, 'Reason'), 'Text') ||
    textOf(fault, 'faultstring') ||
    textOf(find(fault, 'Detail') ?? find(fault, 'detail'), undefined);
  return { code, subcodes, reason };
}

const stripPrefix = (text) => text.slice(text.indexOf(':') + 1);

const AUTH_SUBCODES = ['NotAuthorized', 'FailedAuthentication', 'InvalidSecurity'];

function isAuthFault(fault) {
  return (
    fault.subcodes.some((code) => AUTH_SUBCODES.includes(code)) ||
    AUTH_SUBCODES.includes(fault.code) ||
    /not authori[sz]ed|unauthori[sz]ed|authentication|auth fail|password/i.test(fault.reason)
  );
}

/**
 * One SOAP call. Resolves with the first element of the answer's Body (the
 * `…Response` element).
 * @param {object} options
 * @param {string} options.url the service address
 * @param {string} options.body the operation element
 * @param {{ username: string, password: string } | null} [options.credentials]
 * @param {number} [options.timeOffsetMs] camera clock minus local clock
 * @param {string} [options.headers] extra SOAP headers (WS-Addressing)
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.request] httpRequest (tests replace it)
 */
export async function soapCall({
  url,
  body,
  credentials = null,
  timeOffsetMs = 0,
  headers = '',
  timeoutMs = SOAP_TIMEOUT_MS,
  signal,
  request = httpRequest,
}) {
  let response;
  try {
    response = await requestWithAuth({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/soap+xml; charset=utf-8' },
      body: envelope(body, { credentials, timeOffsetMs, headers }),
      credentials: credentials?.username ? credentials : null,
      timeoutMs,
      signal,
      request,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      throw new OnvifError(err.message, { kind: 'network', cause: err });
    }
    throw err;
  }
  let root = null;
  const text = response.body.toString('utf8');
  if (text.trim()) {
    try {
      root = parseXml(text);
    } catch (err) {
      if (response.status >= 400) {
        throw httpFailure(response);
      }
      throw new OnvifError(`Unreadable answer: ${err.message}`, {
        kind: 'parse',
        cause: err instanceof XmlError ? err : undefined,
      });
    }
  }
  const fault = root ? readFault(root) : null;
  if (fault) {
    throw new OnvifError(fault.reason || fault.subcodes.join(', ') || fault.code || 'SOAP fault', {
      kind: isAuthFault(fault) || response.status === 401 ? 'auth' : 'fault',
      subcode: fault.subcodes[fault.subcodes.length - 1] ?? fault.code,
      status: response.status,
    });
  }
  if (response.status >= 400 || !root) {
    throw httpFailure(response);
  }
  const answer = child(root, 'Body')?.children[0];
  if (!answer) {
    throw new OnvifError('Empty SOAP answer', { kind: 'parse', status: response.status });
  }
  return answer;
}

function httpFailure(response) {
  return new OnvifError(`HTTP ${response.status}`, {
    kind: response.status === 401 || response.status === 403 ? 'auth' : 'http',
    status: response.status,
  });
}
