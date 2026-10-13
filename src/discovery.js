// -----------------------------------------------------------------------------
// Where to look for cameras: the answers to a WS-Discovery probe the Gladys
// core broadcasts for the integration, the addresses typed in the
// configuration, and the cameras already known.
//
// WS-Discovery is multicast (239.255.255.250, UDP 3702): neither the probe
// nor the answers cross the Docker bridge of the integration. The core's
// mediated discovery (`udp-active-broadcast`) emits a forged payload in
// BROADCAST on a declared port, and relays the unicast answers. A camera
// listening on 0.0.0.0:3702 receives a broadcast as well as the multicast:
// most do (gSOAP-based firmwares), some only listen on the multicast group —
// those are added by their address.
//
// The core caps the payload at 512 bytes: the probe goes without XML
// declaration and without `Types` filter (a camera answers an empty probe),
// and the answers are filtered here.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { DEFAULT_PORT, DEVICE_SERVICE_PATH } from './onvif/camera.js';
import { child, children, parseXml, path, textOf } from './onvif/xml.js';

export const WS_DISCOVERY_PORT = 3702;
export const SCAN_TIMEOUT_SECONDS = 4;
export const MAX_PAYLOAD_BYTES = 512;

/** The probe, about 490 bytes. */
export function probeMessage(messageId = randomUUID()) {
  return Buffer.from(
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ' +
      'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
      'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><e:Header>' +
      `<w:MessageID>uuid:${messageId}</w:MessageID>` +
      '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
      '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>' +
      '</e:Header><e:Body><d:Probe/></e:Body></e:Envelope>',
    'utf8',
  );
}

/** The options of the `scanNetwork` call. */
export function scanRequest() {
  return {
    port: WS_DISCOVERY_PORT,
    payload: probeMessage(),
    timeoutSeconds: SCAN_TIMEOUT_SECONDS,
  };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const isIpv4 = (text) => {
  const match = String(text).match(IPV4);
  return Boolean(match) && match.slice(1).every((part) => Number(part) <= 255);
};

function decodeScope(scopes, key) {
  const prefix = `onvif://www.onvif.org/${key}/`;
  const found = scopes.find((scope) => scope.startsWith(prefix));
  if (!found) {
    return '';
  }
  try {
    return decodeURIComponent(found.slice(prefix.length)).trim();
  } catch {
    return found.slice(prefix.length).trim();
  }
}

/**
 * The cameras among the answers of a scan: `[{ host, port, path, endpoint,
 * name, hardware }]`, one per address. Printers and other WS-Discovery
 * devices are left out.
 * @param {Array} replies raw results `[{ source_ip, source_port, payload_base64 }]`
 */
export function parseProbeMatches(replies) {
  const found = new Map();
  for (const reply of Array.isArray(replies) ? replies : []) {
    if (!reply || !isIpv4(reply.source_ip)) {
      continue;
    }
    let root;
    try {
      root = parseXml(Buffer.from(String(reply.payload_base64 ?? ''), 'base64'));
    } catch {
      continue;
    }
    for (const match of children(path(root, 'Body', 'ProbeMatches'), 'ProbeMatch')) {
      const types = textOf(match, 'Types');
      const scopes = textOf(match, 'Scopes').split(/\s+/).filter(Boolean);
      const camera =
        /NetworkVideoTransmitter/i.test(types) ||
        scopes.some((scope) => scope.startsWith('onvif://www.onvif.org/'));
      if (!camera) {
        continue;
      }
      const address = pickAddress(textOf(match, 'XAddrs'), reply.source_ip);
      const key = `${address.host}:${address.port}`;
      if (!found.has(key)) {
        found.set(key, {
          ...address,
          endpoint: textOf(child(match, 'EndpointReference'), 'Address') || null,
          name: decodeScope(scopes, 'name'),
          hardware: decodeScope(scopes, 'hardware'),
        });
      }
    }
  }
  return [...found.values()];
}

/**
 * The device service address of an answer, on the address it came from: an
 * XAddr may name another interface (IPv6, a second network card).
 */
function pickAddress(xaddrs, sourceIp) {
  const urls = xaddrs
    .split(/\s+/)
    .map((text) => {
      try {
        return new URL(text);
      } catch {
        return null;
      }
    })
    .filter((url) => url && url.protocol === 'http:');
  const best =
    urls.find((url) => url.hostname === sourceIp) ?? urls.find((url) => isIpv4(url.hostname));
  return {
    host: sourceIp,
    port: best?.port ? Number(best.port) : DEFAULT_PORT,
    path: best?.pathname && best.pathname !== '/' ? best.pathname : DEVICE_SERVICE_PATH,
  };
}

/**
 * Run `task` on every item, `limit` at a time; resolves with the results in
 * order (`{ value }` or `{ error }`).
 */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { value: await task(items[index]) };
      } catch (error) {
        results[index] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
