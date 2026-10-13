// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { DEFAULT_PORT, DEVICE_SERVICE_PATH } from './onvif/camera.js';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Seconds between two images sent to Gladys, per camera (`snapshot_interval`).
// The core accepts 12 images a minute per camera.
export const SNAPSHOT_INTERVALS = [10, 30, 60, 300, 900];

// How long a movement lasts when no "stop" follows (`move_duration`, seconds):
// the watchdog of the Gladys PTZ contract. A button of the widget, a scene or
// a tap whose release is lost moves the camera this long.
export const MOVE_DURATIONS = ['0.5', '1', '2', '5'];

export const ACCOUNT_SLOTS = 3;

export const DEFAULT_CONFIG = {
  hosts: '',
  snapshot_interval: '60',
  move_duration: '1',
  language: 'fr',
};

const MAX_HOSTS = 32;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function validHost(host) {
  const ipv4 = host.match(IPV4);
  if (ipv4) {
    return ipv4.slice(1).every((part) => Number(part) <= 255);
  }
  return HOSTNAME.test(host) && !/^\d+$/.test(host.replaceAll('.', ''));
}

/**
 * One typed address: `192.0.2.10`, `192.0.2.10:8000`, `camera.lan`, or the
 * full device service address `http://192.0.2.10:8000/onvif/device_service`.
 * Resolves to `{ host, port, path }`, or null when it is not one.
 */
export function parseAddress(entry) {
  const text = String(entry ?? '').trim();
  if (!text) {
    return null;
  }
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) {
    return null;
  }
  // The URL parser reads `1234` as 0.0.4.210: the host must be written whole.
  const written = text
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[/:]/)[0]
    .toLowerCase();
  const host = url.hostname.toLowerCase();
  if (!validHost(host) || !validHost(written)) {
    return null;
  }
  // Read the written address in decimal: the URL parser takes `020` for an
  // octal 16, and leading zeros would make another string for one address.
  const normalized = IPV4.test(written) ? written.split('.').map(Number).join('.') : host;
  return {
    host: normalized,
    port: url.port ? Number(url.port) : DEFAULT_PORT,
    path: url.pathname && url.pathname !== '/' ? url.pathname : DEVICE_SERVICE_PATH,
  };
}

/**
 * The manual address list (commas, semicolons, spaces or new lines).
 * @returns {{ hosts: Array<{ host, port, path }>, invalid: string[] }}
 */
export function parseHosts(raw) {
  const hosts = [];
  const invalid = [];
  const entries = typeof raw === 'string' ? raw.split(/[\s,;]+/) : [];
  for (const entry of entries) {
    if (!entry.trim()) {
      continue;
    }
    const address = parseAddress(entry);
    if (!address) {
      invalid.push(entry.trim());
    } else if (
      hosts.length < MAX_HOSTS &&
      !hosts.some((known) => known.host === address.host && known.port === address.port)
    ) {
      hosts.push(address);
    }
  }
  return { hosts, invalid };
}

/** The camera accounts filled in, in order (an account needs a user name). */
export function parseAccounts(source) {
  const accounts = [];
  for (let slot = 1; slot <= ACCOUNT_SLOTS; slot += 1) {
    const suffix = slot === 1 ? '' : `_${slot}`;
    const username = String(source[`username${suffix}`] ?? '').trim();
    const password = String(source[`password${suffix}`] ?? '');
    if (username) {
      accounts.push({ username, password });
    }
  }
  return accounts;
}

/**
 * A fingerprint of the accounts, to know whether they changed (a camera that
 * refused them is tried again only then). Never the passwords themselves.
 */
export function accountsFingerprint(accounts) {
  return createHash('sha256')
    .update(JSON.stringify(accounts.map((account) => [account.username, account.password])))
    .digest('hex')
    .slice(0, 16);
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const { hosts, invalid } = parseHosts(
    typeof source.hosts === 'string' ? source.hosts : DEFAULT_CONFIG.hosts,
  );
  const accounts = parseAccounts(source);
  const interval = Number(source.snapshot_interval ?? DEFAULT_CONFIG.snapshot_interval);
  const move = String(source.move_duration ?? DEFAULT_CONFIG.move_duration);
  return {
    hosts,
    invalidHosts: invalid,
    accounts,
    accountsKey: accountsFingerprint(accounts),
    snapshotSeconds: SNAPSHOT_INTERVALS.includes(interval)
      ? interval
      : Number(DEFAULT_CONFIG.snapshot_interval),
    moveMs: Number(MOVE_DURATIONS.includes(move) ? move : DEFAULT_CONFIG.move_duration) * 1000,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
