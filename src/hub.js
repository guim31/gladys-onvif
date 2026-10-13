// -----------------------------------------------------------------------------
// The ONVIF hub: finds the cameras, publishes their devices, sends their
// images to Gladys, runs the PTZ commands, follows their events and fires the
// scene trigger.
//
// Timers of the container, never the Gladys scheduler (should_poll: false):
//   - images, every `snapshot_interval` seconds, plus one shortly after a
//     detection or a movement;
//   - a health check every minute (GetSystemDateAndTime, no authentication);
//   - a new search every 15 minutes (addresses, presets, new cameras).
// Events: one PullPoint subscription per camera, read in long polling. The
// camera cannot reach the container (Docker bridge, no published port), so
// the push variant of ONVIF events (a webhook) is out of reach.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { accountsFingerprint } from './config.js';
import {
  FEATURE_KEYS,
  KIND_FEATURES,
  MOVES,
  buildDevice,
  deviceIds,
  deviceName,
  presetValues,
  supportedMoves,
} from './devices.js';
import { mapLimit, parseProbeMatches, scanRequest } from './discovery.js';
import { ImageProcessor, toDataUri } from './image.js';
import { OnvifCamera, ptzCapabilities } from './onvif/camera.js';
import {
  KINDS,
  PULSE_MS,
  SENSOR_KINDS,
  classify,
  kindsOfTopics,
  sourceTokens,
} from './onvif/events.js';
import { httpRequest } from './onvif/http.js';
import { textOf } from './onvif/xml.js';
import { OnvifError } from './onvif/soap.js';
import { CONNECTION_TEXT } from './texts.js';

const logger = createLogger({ name: 'onvif-hub' });

export const WIDGET_KEY = 'camera';
export const TRIGGER = 'detection';

export const HUB_TIMINGS = {
  rediscoveryMs: 15 * 60_000,
  healthMs: 60_000,
  // Health checks in a row without answer before a camera is "unreachable".
  unreachableAfter: 2,
  // PullMessages: how long the camera may hold the request.
  pullTimeoutSeconds: 20,
  subscriptionSeconds: 600,
  // Wait after an event subscription failed, before trying again.
  eventRetryMs: 60_000,
  // A pull answered at once with nothing: wait this long before the next one.
  emptyPullDelayMs: 1000,
  // After a movement or a preset, the image shows the new view.
  imageAfterMoveMs: 1500,
  imageAfterPresetMs: 4000,
  // The core takes 12 images a minute per camera.
  minImageSpacingMs: 5100,
  // An image younger than this answers a request for a fresh one.
  freshImageMs: 2000,
  pulseMs: PULSE_MS,
  triggerCooldownMs: 5000,
};

// Speed of a continuous move and size of a relative step, in the ONVIF
// generic spaces (-1…1).
const MOVE_SPEED = 0.5;
const RELATIVE_STEP = 0.1;
const CONNECT_CONCURRENCY = 4;
const MAX_MOVE_SECONDS = 10;
// A stop that failed is tried again after this long, this many times.
const STOP_RETRY_MS = 1000;
const MAX_STOP_TRIES = 5;
const SHUTDOWN_STOP_MS = 3000;
// Detections that deserve a fresh image.
const IMAGE_KINDS = [
  'motion',
  'person',
  'vehicle',
  'animal',
  'line_crossing',
  'intrusion',
  'doorbell',
];

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const pixels = (profile) => profile.width * profile.height;

/** A MAC address as 12 lower-case hex digits, or null. */
export function normalizeMac(raw) {
  const hex = String(raw ?? '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  return hex.length === 12 && !/^0+$/.test(hex) && hex !== 'ffffffffffff' ? hex : null;
}

/** The unique id of a camera: its MAC address, else its serial number. */
export function uniqueId({ mac, serial }) {
  const fromMac = normalizeMac(mac);
  if (fromMac) {
    return fromMac;
  }
  const fromSerial = String(serial ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 48);
  return fromSerial && !/^0+$/.test(fromSerial) ? `sn-${fromSerial}` : null;
}

/**
 * The video sources of a camera from its media profiles: per source, the
 * largest profile (image, PTZ) and the smallest one (RTSP fallback).
 */
export function groupSources(profiles) {
  const groups = new Map();
  for (const profile of profiles) {
    const token = profile.sourceToken ?? 'main';
    if (!groups.has(token)) {
      groups.set(token, []);
    }
    groups.get(token).push(profile);
  }
  return [...groups.entries()].map(([token, list], index) => {
    const sorted = [...list].sort((a, b) => pixels(b) - pixels(a));
    return {
      index,
      token,
      configTokens: [...new Set(list.map((profile) => profile.sourceConfigurationToken))].filter(
        Boolean,
      ),
      mainProfile: sorted[0].token,
      subProfile: sorted[sorted.length - 1].token,
      ptzProfile: (sorted.find((profile) => profile.ptzConfiguration) ?? null)?.token ?? null,
    };
  });
}

export class OnvifHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] httpRequest (tests replace it)
   * @param {ImageProcessor} [options.images]
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {boolean} [options.events] event subscriptions (`timers` by default)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   */
  constructor({ gladys, store, request = httpRequest, images, timers = true, events, timings }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.images = images ?? new ImageProcessor();
    this.timersEnabled = timers;
    this.eventsEnabled = events ?? timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.config = null;
    /** @type {Map<string, object>} cameras, by unique id */
    this.cameras = new Map();
    // `host:port` → fingerprint of the accounts the camera refused: they are
    // not tried again until they change (cameras lock an account after a few
    // wrong passwords).
    this.refused = new Map();
    this.failures = [];
    this.pending = new Set();
    this.timers = {};
    this.discovering = null;
    this.lastScan = { status: 'not-run', found: 0 };
    this.stopped = false;
    this.republishTimer = null;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    this.config = config;
    if (!this.restored) {
      await this.restore();
      this.restored = true;
    }
    await this.publishDevices();
    await this.discover();
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.requestWidgetRefresh();
    this.startTimers();
    this.startAllEvents();
    this.track(this.refreshAllImages());
  }

  /** Gladys came back (restart, network): it may have lost what was published. */
  async resync(config) {
    this.config = config;
    this.gladys.forgetPublishedStates();
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.requestWidgetRefresh();
  }

  async reconfigure(config) {
    const previous = this.config;
    this.config = config;
    const addresses = (list) => list.map((item) => `${item.host}:${item.port}${item.path}`).join();
    if (
      !previous ||
      addresses(previous.hosts) !== addresses(config.hosts) ||
      previous.accountsKey !== config.accountsKey
    ) {
      await this.discover({ again: true });
      await Promise.all([...this.cameras.values()].map((camera) => this.stopEvents(camera)));
      this.startAllEvents();
    }
    if (previous && previous.snapshotSeconds !== config.snapshotSeconds) {
      this.startTimers();
    }
    // New cameras, or names in another language for the Discovery list.
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.requestWidgetRefresh();
  }

  startTimers() {
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    this.clearTimers();
    this.timers.images = setInterval(
      () => this.track(this.refreshAllImages()),
      this.config.snapshotSeconds * 1000,
    );
    this.timers.health = setInterval(() => this.track(this.checkAll()), this.timings.healthMs);
    this.timers.rediscovery = setInterval(
      () => this.track(this.rediscover()),
      this.timings.rediscoveryMs,
    );
  }

  clearTimers() {
    for (const timer of Object.values(this.timers)) {
      clearInterval(timer);
    }
    this.timers = {};
  }

  async stop() {
    this.stopped = true;
    this.clearTimers();
    clearTimeout(this.republishTimer);
    const unsubscribes = [];
    for (const camera of this.cameras.values()) {
      unsubscribes.push(this.stopEvents(camera));
      for (const source of camera.sources) {
        clearTimeout(source.watchdog);
        if (source.moving !== null) {
          // Stopping mid-move: the watchdog will not run any more, stop now.
          const profile = source.ptzProfile ?? source.mainProfile;
          const stopping = this.ptz(source, () => camera.client.stop(profile));
          unsubscribes.push(Promise.race([stopping.catch(() => {}), sleep(SHUTDOWN_STOP_MS)]));
        }
        clearTimeout(source.imageTimer);
        for (const timer of source.pulses.values()) {
          clearTimeout(timer);
        }
      }
    }
    await Promise.all(unsubscribes);
    await this.idle();
    await this.store.flush();
  }

  /** Keep track of background work, so the tests (and stop) can wait for it. */
  track(promise) {
    const tracked = Promise.resolve(promise)
      .catch((err) => logger.error('Background task failed', err))
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }

  /** Resolves once no background work is left (event loops excepted). */
  async idle() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  // --- Persistence -----------------------------------------------------------

  async restore() {
    const data = await this.store.load();
    for (const [uid, saved] of Object.entries(data.cameras ?? {})) {
      if (!saved || typeof saved.host !== 'string' || !Array.isArray(saved.sources)) {
        continue;
      }
      const camera = this.createCamera(uid, saved);
      camera.sources = saved.sources
        .filter((source) => source && typeof source.token === 'string')
        .map((source, index) => this.createSource({ ...source, index }));
      if (camera.sources.length > 0) {
        this.cameras.set(uid, camera);
      }
    }
  }

  save() {
    const cameras = {};
    for (const camera of this.cameras.values()) {
      cameras[camera.uid] = {
        host: camera.host,
        port: camera.port,
        path: camera.path,
        username: camera.username,
        info: camera.info,
        services: camera.services,
        reportedPort: camera.reportedPort,
        kinds: camera.kinds,
        hasEvents: camera.hasEvents,
        sources: camera.sources.map((source) => ({
          token: source.token,
          configTokens: source.configTokens,
          mainProfile: source.mainProfile,
          subProfile: source.subProfile,
          ptzProfile: source.ptzProfile,
          snapshotUri: hasCredentials(source.snapshotUri) ? null : source.snapshotUri,
          ptz: source.ptz,
          presets: source.presets,
        })),
      };
    }
    return this.store.save({ cameras });
  }

  createCamera(
    uid,
    {
      host,
      port,
      path,
      username = null,
      info = {},
      services = null,
      reportedPort = null,
      kinds = [],
      hasEvents = false,
    },
  ) {
    const camera = {
      uid,
      host,
      port,
      path,
      username,
      info,
      services,
      reportedPort,
      kinds: KINDS.filter((kind) => kinds.includes(kind)),
      hasEvents,
      sources: [],
      client: null,
      // null until the first answer or the first search without one.
      reachable: null,
      failures: 0,
      authError: false,
      // Another camera answers at its address: not reachable until found again.
      displaced: false,
      events: null,
    };
    camera.client = this.createClient(camera);
    return camera;
  }

  createClient(camera) {
    const client = new OnvifCamera({
      host: camera.host,
      port: camera.port,
      path: camera.path,
      credentials: this.accountFor(camera.username),
      request: this.request,
    });
    if (camera.services) {
      client.services = { ...camera.services };
      client.reportedPort = camera.reportedPort;
    }
    return client;
  }

  createSource({
    index,
    token,
    configTokens = [],
    mainProfile,
    subProfile,
    ptzProfile = null,
    snapshotUri = null,
    ptz = null,
    presets = null,
  }) {
    return {
      index,
      token,
      configTokens,
      mainProfile,
      subProfile,
      ptzProfile,
      snapshotUri,
      ptz,
      presets,
      streamUri: null,
      snapshotFailures: 0,
      image: null,
      imageSeq: 0,
      capturing: null,
      lastPublishAt: 0,
      imageTimer: null,
      // PTZ: commands run one after the other, a move ends with a stop.
      ptzQueue: Promise.resolve(),
      moving: null,
      watchdog: null,
      // Detection state: kind → Map(rule → boolean).
      active: new Map(),
      pulses: new Map(),
      // Detector → time of its last scene event.
      lastTriggers: new Map(),
    };
  }

  /** The configured account with this user name (the first one by default). */
  accountFor(username) {
    const accounts = this.config?.accounts ?? [];
    return accounts.find((account) => account.username === username) ?? accounts[0] ?? null;
  }

  // --- Discovery -------------------------------------------------------------

  /**
   * Scan through the Gladys core, then connect to the typed, found and known
   * addresses. Resolves with the number of cameras answering.
   * @param {object} [options]
   * @param {boolean} [options.force] try again the accounts a camera refused
   */
  discover(options = {}) {
    if (this.discovering && !options.force && !options.again) {
      return this.discovering;
    }
    // A search asked by the user, or new settings, run after the one under
    // way: never answered by an older, unforced run.
    const run = (this.discovering ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.runDiscovery(options))
      .finally(() => {
        if (this.discovering === run) {
          this.discovering = null;
        }
      });
    this.discovering = run;
    return run;
  }

  async runDiscovery({ force = false } = {}) {
    const addresses = [];
    const add = (address) => {
      if (!addresses.some((known) => known.host === address.host && known.port === address.port)) {
        addresses.push(address);
      }
    };
    this.config.hosts.forEach(add);
    const found = await this.scan();
    found.forEach(add);
    [...this.cameras.values()].forEach((camera) =>
      add({ host: camera.host, port: camera.port, path: camera.path }),
    );

    const results = await mapLimit(addresses, CONNECT_CONCURRENCY, (address) =>
      this.connect(address, { force }),
    );
    const answered = new Set();
    const adopted = new Set();
    this.failures = [];
    results.forEach((result, index) => {
      const address = addresses[index];
      if (result.error) {
        const reason =
          result.error.kind === 'auth'
            ? 'auth'
            : result.error.kind === 'network'
              ? 'unreachable'
              : 'error';
        const known = [...this.cameras.values()].find(
          (camera) => camera.host === address.host && camera.port === address.port,
        );
        if (known && reason === 'auth') {
          // It answers, but no longer takes its account.
          answered.add(known.uid);
          known.authError = true;
        }
        // A known camera that does not answer is reported with the cameras.
        if (!(known && reason === 'unreachable')) {
          this.failures.push({ host: address.host, port: address.port, reason });
        }
        logger.debug(`No ONVIF camera at ${address.host}:${address.port}: ${result.error.message}`);
      } else if (!adopted.has(result.value.uid)) {
        adopted.add(result.value.uid);
        answered.add(result.value.uid);
        this.adopt(result.value);
      }
    });
    for (const camera of this.cameras.values()) {
      if (answered.has(camera.uid)) {
        continue;
      }
      // Another camera answers at its address (DHCP, a replaced camera): the
      // clock check alone would take it for this one.
      const taken = [...this.cameras.values()].some(
        (other) =>
          adopted.has(other.uid) && other.host === camera.host && other.port === camera.port,
      );
      if (taken && !camera.displaced) {
        camera.displaced = true;
        logger.info(`Another camera answers at the address of ${this.label(camera)}`);
        this.track(this.stopEvents(camera));
      }
      if (camera.reachable !== false) {
        camera.reachable = false;
        camera.failures = this.timings.unreachableAfter;
      }
    }
    // A displaced camera nobody added to Gladys is forgotten.
    for (const camera of [...this.cameras.values()]) {
      if (camera.displaced && !camera.sources.some((source) => this.isCreated(camera, source))) {
        this.cameras.delete(camera.uid);
      }
    }
    await this.save();
    return answered.size;
  }

  /** One WS-Discovery probe through the Gladys core. */
  async scan() {
    try {
      const found = parseProbeMatches(
        await this.gladys.scanNetwork('udp-active-broadcast', scanRequest()),
      );
      this.lastScan = { status: 'ok', found: found.length };
      return found;
    } catch (err) {
      // 403: a core without mediated discovery; 429 or 409: a scan ran less
      // than 10 s ago. The typed and known addresses still work.
      const status = err.status === 429 || err.status === 409 ? 'busy' : 'unavailable';
      logger.warn(`Camera discovery through Gladys failed: ${err.message}`);
      this.lastScan = { status, found: 0 };
      return [];
    }
  }

  /**
   * Connect to one address: clock, account, identity, video sources, PTZ,
   * events. Resolves with what the camera is; throws an OnvifError.
   */
  async connect(address, { force = false } = {}) {
    const key = `${address.host}:${address.port}`;
    const accountsKey = this.config.accountsKey ?? accountsFingerprint(this.config.accounts);
    if (!force && this.refused.get(key) === accountsKey) {
      throw new OnvifError('The camera refused these accounts', { kind: 'auth' });
    }
    const client = new OnvifCamera({ ...address, request: this.request });
    try {
      await client.syncTime();
    } catch (err) {
      if (err.kind === 'network') {
        throw err;
      }
      // Without a readable clock, the local one is used.
    }
    const known = [...this.cameras.values()].find(
      (camera) => camera.host === address.host && camera.port === address.port,
    );
    const accounts = this.config.accounts.length > 0 ? [...this.config.accounts] : [null];
    accounts.sort(
      (a, b) => Number(b?.username === known?.username) - Number(a?.username === known?.username),
    );
    let info = null;
    let lastError = null;
    let authRefused = false;
    for (const account of accounts) {
      client.credentials = account;
      try {
        info = await client.getDeviceInformation();
        break;
      } catch (err) {
        if (err.kind === 'network') {
          throw err;
        }
        authRefused ||= err.kind === 'auth';
        lastError = err;
      }
    }
    if (!info) {
      if (authRefused) {
        this.refused.set(key, accountsKey);
        logger.warn(`The camera at ${key} refused the configured accounts`);
        throw new OnvifError('The camera refused the configured accounts', { kind: 'auth' });
      }
      throw lastError;
    }
    this.refused.delete(key);

    // A timeout here must not change the identity of the camera.
    const mac = await client.getMacAddress().catch((err) => {
      if (err.kind === 'network') {
        throw err;
      }
      return null;
    });
    const sameCamera =
      !normalizeMac(mac) && known?.info?.serial && known.info.serial === info.serial ? known : null;
    const uid =
      sameCamera?.uid ??
      uniqueId({ mac, serial: info.serial }) ??
      `ip-${address.host.replace(/[^a-z0-9]/gi, '-')}-${address.port}`;
    const { services } = await client.getServices();
    if (!services.media) {
      throw new OnvifError('The camera has no media service', { kind: 'fault' });
    }
    const profiles = await client.getProfiles();
    if (profiles.length === 0) {
      throw new OnvifError('The camera has no media profile', { kind: 'fault' });
    }
    const nodes = services.ptz ? await client.getNodes().catch(() => []) : [];
    const sources = [];
    for (const group of groupSources(profiles)) {
      const ptzProfile = profiles.find((profile) => profile.token === group.ptzProfile);
      const configuration = ptzProfile?.ptzConfiguration ?? null;
      const nodeToken = configuration ? textOf(configuration, 'NodeToken') : null;
      const node = nodes.find((item) => item.attrs.token === nodeToken) ?? nodes[0] ?? null;
      const ptz = services.ptz ? ptzCapabilities(configuration, node) : null;
      const presets = ptz
        ? await client.getPresets(group.ptzProfile).catch((err) => {
            logger.debug(`No presets on ${key}: ${err.message}`);
            return [];
          })
        : null;
      const snapshotUri = await client.getSnapshotUri(group.mainProfile).catch(() => null);
      sources.push({ ...group, ptz, presets, snapshotUri });
    }
    let kinds = [];
    if (services.events) {
      kinds = await client
        .getEventProperties()
        .then(kindsOfTopics)
        .catch(() => []);
    }
    return {
      uid,
      address,
      username: client.credentials?.username ?? null,
      info: {
        manufacturer: info.manufacturer,
        model: info.model,
        firmware: info.firmware,
        serial: info.serial,
      },
      sources,
      kinds,
      // Some cameras claim no PullPoint support and have it, others the
      // reverse (Home Assistant's experience): it is always tried.
      hasEvents: Boolean(services.events),
      services,
      reportedPort: client.reportedPort,
      timeOffsetMs: client.timeOffsetMs,
    };
  }

  /** Take a connection result: a new camera is added, a known one updated. */
  adopt(result) {
    let camera = this.cameras.get(result.uid);
    if (!camera) {
      camera = this.createCamera(result.uid, { ...result.address });
      this.cameras.set(result.uid, camera);
      logger.info(
        `ONVIF camera ${result.info.manufacturer} ${result.info.model} found at ${result.address.host}:${result.address.port}`,
      );
    } else if (
      camera.host !== result.address.host ||
      camera.port !== result.address.port ||
      camera.path !== result.address.path
    ) {
      logger.info(
        `Camera ${result.uid} moved from ${camera.host}:${camera.port} to ${result.address.host}:${result.address.port}`,
      );
      this.track(this.stopEvents(camera));
      camera.client = null;
    }
    Object.assign(camera, {
      host: result.address.host,
      port: result.address.port,
      path: result.address.path,
      username: result.username,
      info: result.info,
      services: result.services,
      reportedPort: result.reportedPort,
      hasEvents: result.hasEvents,
      kinds: KINDS.filter((kind) => camera.kinds.includes(kind) || result.kinds.includes(kind)),
      authError: false,
      displaced: false,
    });
    if (camera.client) {
      // Same address: the event loop keeps its client, with the new account.
      camera.client.credentials = this.accountFor(camera.username);
      camera.client.services = { ...camera.services };
      camera.client.reportedPort = camera.reportedPort;
    } else {
      camera.client = this.createClient(camera);
    }
    camera.client.timeOffsetMs = result.timeOffsetMs;
    camera.sources = result.sources.map((found) => {
      const existing = camera.sources.find((source) => source.token === found.token);
      if (existing) {
        // Keep the runtime state (image, detections, PTZ queue).
        Object.assign(existing, { ...found, streamUri: null, snapshotFailures: 0 });
        return existing;
      }
      return this.createSource(found);
    });
    this.markReachable(camera);
    return camera;
  }

  async rediscover(options) {
    await this.discover(options);
    // New cameras, new addresses (DHCP), renamed presets: upserted silently
    // on the devices already created.
    await this.publishDevices();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.startAllEvents();
  }

  // --- Devices ---------------------------------------------------------------

  async publishDevices() {
    const devices = [];
    for (const camera of this.cameras.values()) {
      for (const source of camera.sources) {
        devices.push(buildDevice(this.gladys, camera, source, this.config.language));
      }
    }
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** Publish the devices again soon (a new detection kind appeared). */
  scheduleRepublish() {
    clearTimeout(this.republishTimer);
    this.republishTimer = setTimeout(() => {
      this.track(Promise.all([this.publishDevices(), this.save()]));
    }, 1000);
  }

  ids(camera, source) {
    return deviceIds(this.gladys, camera.uid, source.token);
  }

  /** `{ camera, source }` behind a Gladys device external id, or null. */
  resolveDevice(externalId) {
    if (typeof externalId !== 'string') {
      return null;
    }
    for (const camera of this.cameras.values()) {
      for (const source of camera.sources) {
        if (this.ids(camera, source).device === externalId) {
          return { camera, source };
        }
      }
    }
    return null;
  }

  require(externalId) {
    const found = this.resolveDevice(externalId);
    if (!found) {
      throw new Error(`Unknown ONVIF camera ${externalId}`);
    }
    if (found.camera.displaced) {
      // Its address now leads to another camera: never act on that one.
      throw new Error(`${this.label(found.camera)} is no longer at ${found.camera.host}`);
    }
    if (found.camera.authError) {
      // Every refused request brings the camera closer to locking the account.
      throw new Error(`${this.label(found.camera)} refuses its account: check it, then search`);
    }
    return found;
  }

  isCreated(camera, source) {
    const id = this.ids(camera, source).device;
    return (this.gladys.devices ?? []).some((device) => device.external_id === id);
  }

  /** The device Gladys holds (with its features), or null. */
  createdDevice(camera, source) {
    const id = this.ids(camera, source).device;
    return (this.gladys.devices ?? []).find((device) => device.external_id === id) ?? null;
  }

  // --- States ----------------------------------------------------------------

  /** Whether a detection kind is on for a source (any of its rules). */
  detected(source, kind) {
    const rules = source.active.get(kind);
    return rules ? [...rules.values()].some(Boolean) : false;
  }

  async publishStates(camera, source) {
    if (!this.isCreated(camera, source)) {
      return;
    }
    const ids = this.ids(camera, source);
    const states = SENSOR_KINDS.filter((kind) => camera.kinds.includes(kind)).map((kind) => ({
      device_feature_external_id: ids.feature(KIND_FEATURES[kind]),
      state: this.detected(source, kind) ? 1 : 0,
    }));
    if (states.length > 0) {
      // The SDK sends only the values that changed since its last publication.
      await this.gladys.publishChangedStates(states);
    }
  }

  async publishAllStates() {
    for (const camera of this.cameras.values()) {
      for (const source of camera.sources) {
        try {
          await this.publishStates(camera, source);
        } catch (err) {
          logger.warn(`Cannot publish the states of ${camera.uid}: ${err.message}`);
        }
      }
    }
  }

  /**
   * The user added a device: the states sent before were dropped by Gladys,
   * and so was the transport badge. Send them again, with an image.
   */
  async onDeviceCreated(device) {
    const found = this.resolveDevice(device?.external_id);
    if (!found) {
      return;
    }
    const { camera, source } = found;
    this.gladys.forgetPublishedStates(device.external_id);
    await this.publishStates(camera, source);
    await this.publishTransports([camera]);
    source.lastPublishAt = 0;
    if (source.image) {
      await this.publishImage(camera, source);
    } else if (camera.reachable) {
      this.track(this.refreshImage(camera, source));
    }
    this.requestWidgetRefresh();
  }

  async publishTransports(cameras = [...this.cameras.values()]) {
    const entries = [];
    for (const camera of cameras) {
      for (const source of camera.sources) {
        if (this.isCreated(camera, source)) {
          entries.push({
            external_id: this.ids(camera, source).device,
            transport: camera.reachable === true ? 'local' : 'unreachable',
            ...(camera.reachable === true && camera.authError
              ? { degraded: true, message: CONNECTION_TEXT.authError }
              : {}),
          });
        }
      }
    }
    for (let at = 0; at < entries.length; at += 100) {
      await this.gladys.publishTransports(entries.slice(at, at + 100));
    }
  }

  async publishConnectionStatus() {
    const cameras = [...this.cameras.values()];
    if (cameras.length === 0) {
      const refused = this.failures.some((failure) => failure.reason === 'auth');
      await this.gladys.setConnectionStatus(
        false,
        refused ? CONNECTION_TEXT.refused : CONNECTION_TEXT.noCamera,
      );
    } else if (!cameras.some((camera) => camera.reachable === true)) {
      await this.gladys.setConnectionStatus(false, CONNECTION_TEXT.noAnswer);
    } else {
      await this.gladys.setConnectionStatus(true);
    }
  }

  requestWidgetRefresh() {
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  // --- Reachability -----------------------------------------------------------

  /** Health check: the camera clock (also keeps the time offset right). */
  async checkAll() {
    const cameras = [...this.cameras.values()].filter((camera) => !camera.displaced);
    await mapLimit(cameras, CONNECT_CONCURRENCY, async (camera) => {
      try {
        await camera.client.syncTime();
        this.markReachable(camera);
      } catch (err) {
        if (err.kind === 'network') {
          await this.failed(camera);
        } else {
          this.markReachable(camera);
        }
      }
    });
  }

  markReachable(camera) {
    camera.failures = 0;
    if (camera.reachable === true || camera.displaced) {
      return;
    }
    const cameBack = camera.reachable === false;
    camera.reachable = true;
    if (cameBack) {
      logger.info(`${this.label(camera)} answers again at ${camera.host}`);
      this.track(
        (async () => {
          await this.publishTransports([camera]);
          await this.publishConnectionStatus();
          this.requestWidgetRefresh();
          this.startEvents(camera);
        })(),
      );
    }
  }

  async failed(camera) {
    if (this.stopped) {
      return;
    }
    camera.failures += 1;
    if (camera.failures < this.timings.unreachableAfter || camera.reachable === false) {
      return;
    }
    camera.reachable = false;
    logger.info(`${this.label(camera)} no longer answers at ${camera.host}`);
    await this.publishTransports([camera]);
    await this.publishConnectionStatus();
    this.requestWidgetRefresh();
  }

  /** An operation was refused: the camera's account changed. */
  async authFailed(camera) {
    if (!camera.authError) {
      camera.authError = true;
      logger.warn(`${this.label(camera)} refuses its account: check the user name and password`);
      await this.publishTransports([camera]);
    }
  }

  label(camera) {
    return `${deviceName(camera, camera.sources[0] ?? { index: 0 }, 'en')} (${camera.uid})`;
  }

  // --- Images ------------------------------------------------------------------

  /**
   * The periodic images, for the created devices of the cameras answering.
   * A round still running (slow cameras) makes the next one wait its turn.
   */
  refreshAllImages() {
    this.imageRound ??= this.runImageRound().finally(() => {
      this.imageRound = null;
    });
    return this.imageRound;
  }

  async runImageRound() {
    const jobs = [];
    for (const camera of this.cameras.values()) {
      if (camera.reachable !== true || camera.authError) {
        continue;
      }
      for (const source of camera.sources) {
        if (this.isCreated(camera, source)) {
          jobs.push({ camera, source });
        }
      }
    }
    // One camera at a time: ffmpeg runs one at a time anyway.
    for (const { camera, source } of jobs) {
      await this.refreshImage(camera, source).catch(() => {});
    }
  }

  /**
   * A fresh image of a source, sent to Gladys when the device exists and the
   * rate allows. Concurrent requests share one capture.
   * @returns {Promise<Buffer>} the JPEG
   */
  refreshImage(camera, source, { publish = true } = {}) {
    source.capturing ??= this.capture(camera, source).finally(() => {
      source.capturing = null;
    });
    return source.capturing.then(async (jpeg) => {
      if (publish) {
        await this.publishImage(camera, source);
      }
      return jpeg;
    });
  }

  /** Capture one image: the snapshot address, else a frame of the stream. */
  async capture(camera, source) {
    if (camera.displaced) {
      throw new Error(`${this.label(camera)} is no longer at ${camera.host}`);
    }
    if (camera.authError) {
      throw new Error(`${this.label(camera)} refuses its account`);
    }
    let jpeg = null;
    if (source.snapshotUri && source.snapshotFailures < 3) {
      try {
        const raw = await camera.client.fetchSnapshot(source.snapshotUri);
        jpeg = await this.images.fit(raw);
        source.snapshotFailures = 0;
      } catch (err) {
        if (err.kind === 'network') {
          await this.failed(camera);
          throw err;
        }
        // A refused snapshot counts as a failure of the snapshot address
        // only: after three, the RTSP stream takes over.
        source.snapshotFailures += 1;
        logger.warn(`Snapshot of ${this.label(camera)} failed: ${err.message}`);
      }
    }
    if (!jpeg) {
      jpeg = await this.grabFrame(camera, source);
    }
    source.image = { jpeg, at: Date.now() };
    source.imageSeq += 1;
    this.markReachable(camera);
    return jpeg;
  }

  /** A frame of the RTSP stream (smallest profile), credentials in the URL. */
  async grabFrame(camera, source) {
    if (!source.streamUri) {
      const uri = await camera.client.getStreamUri(source.subProfile);
      if (!uri) {
        throw new Error(`${this.label(camera)} gives no stream address`);
      }
      source.streamUri = uri;
    }
    const url = new URL(source.streamUri);
    const account = camera.client.credentials;
    if (account?.username && !url.username) {
      url.username = encodeURIComponent(account.username);
      url.password = encodeURIComponent(account.password ?? '');
    }
    try {
      return await this.images.grab(url.toString());
    } catch (err) {
      logger.warn(`No frame from the stream of ${this.label(camera)}: ${err.message}`);
      throw err;
    }
  }

  /** Send the last image to Gladys, at most one every 5 s per device. */
  async publishImage(camera, source) {
    if (!source.image || !this.isCreated(camera, source)) {
      return false;
    }
    const now = Date.now();
    if (now - source.lastPublishAt < this.timings.minImageSpacingMs) {
      return false;
    }
    source.lastPublishAt = now;
    try {
      await this.gladys.publishCameraImage(
        this.ids(camera, source).device,
        toDataUri(source.image.jpeg),
      );
      return true;
    } catch (err) {
      // 404: the camera is turned off in Gladys ("private mode"), or not
      // created yet; 429: too many images. Nothing to fix here.
      logger.debug(`Image of ${this.label(camera)} not taken by Gladys: ${err.message}`);
      return false;
    }
  }

  /** A fresh image in `delayMs` (one pending per source, the earliest wins). */
  scheduleImage(camera, source, delayMs) {
    if (this.stopped || !this.isCreated(camera, source)) {
      return;
    }
    const at = Math.max(
      Date.now() + delayMs,
      source.lastPublishAt + this.timings.minImageSpacingMs,
    );
    if (source.imageTimer && source.imageTimerAt <= at) {
      return;
    }
    clearTimeout(source.imageTimer);
    source.imageTimerAt = at;
    source.imageTimer = setTimeout(() => {
      source.imageTimer = null;
      this.track(
        this.refreshImage(camera, source)
          .then(() => this.requestWidgetRefresh())
          .catch(() => {}),
      );
    }, at - Date.now());
  }

  /**
   * Wait for a movement to end, then capture the new view (the widget shows
   * it when its action resolves).
   */
  async freshImageAfter(externalId, delayMs) {
    const { camera, source } = this.require(externalId);
    clearTimeout(source.imageTimer);
    source.imageTimer = null;
    await sleep(delayMs);
    await this.refreshImage(camera, source).catch(() => {});
  }

  /** A fresh image for Gladys (dashboard, "send camera image" in scenes). */
  async imageFor(externalId) {
    const { camera, source } = this.require(externalId);
    if (source.image && Date.now() - source.image.at < this.timings.freshImageMs) {
      return toDataUri(source.image.jpeg);
    }
    const jpeg = await this.refreshImage(camera, source);
    return toDataUri(jpeg);
  }

  // --- PTZ -----------------------------------------------------------------------

  /** Queue a PTZ operation of a source: they run one after the other. */
  ptz(source, operation) {
    const run = source.ptzQueue.then(operation);
    source.ptzQueue = run.catch(() => {});
    return run;
  }

  async ptzCall(camera, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.kind === 'network') {
        await this.failed(camera);
      } else if (err.kind === 'auth') {
        await this.authFailed(camera);
      }
      throw err;
    }
  }

  /**
   * A movement value of the Gladys PTZ contract: 1-6 start a move bounded by
   * the watchdog (`durationMs`, the configured duration by default), 0
   * stops. A camera without continuous moves takes one relative step.
   */
  move(externalId, value, { durationMs } = {}) {
    const { camera, source } = this.require(externalId);
    const move = Number(value);
    if (move !== MOVES.STOP && !supportedMoves(source.ptz).includes(move)) {
      throw new Error(`${this.label(camera)} cannot do the movement ${value}`);
    }
    const profile = source.ptzProfile ?? source.mainProfile;
    return this.ptz(source, async () => {
      if (move === MOVES.STOP) {
        if (source.moving !== null) {
          this.clearWatchdog(source);
          try {
            await this.ptzCall(camera, () => camera.client.stop(profile));
          } catch (err) {
            // The camera may still be moving: the watchdog tries again.
            this.armWatchdog(camera, source, profile, STOP_RETRY_MS);
            throw err;
          }
          source.moving = null;
          this.scheduleImage(camera, source, this.timings.imageAfterMoveMs);
        }
        return;
      }
      const vector = moveVector(move);
      const axis = axisOf(move);
      if (!source.ptz.continuous?.[axis]) {
        // One step; a continuous move under way keeps its watchdog.
        await this.ptzCall(camera, () =>
          camera.client.relativeMove(profile, scaleVector(vector, RELATIVE_STEP)),
        );
        this.scheduleImage(camera, source, this.timings.imageAfterMoveMs);
        return;
      }
      if (source.moving !== null && source.moving !== move) {
        // Another direction: stop the previous move first.
        await this.ptzCall(camera, () => camera.client.stop(profile)).catch(() => {});
      }
      const limit = Math.min(durationMs ?? this.config.moveMs, MAX_MOVE_SECONDS * 1000);
      // Armed before the request: whether it failed or not, the camera may
      // be moving, and a stop to an idle camera does no harm.
      source.moving = move;
      this.armWatchdog(camera, source, profile, limit);
      await this.ptzCall(camera, () =>
        camera.client.continuousMove(profile, scaleVector(vector, MOVE_SPEED)),
      );
    });
  }

  clearWatchdog(source) {
    clearTimeout(source.watchdog);
    source.watchdog = null;
  }

  armWatchdog(camera, source, profile, delayMs) {
    this.clearWatchdog(source);
    if (this.stopped) {
      return;
    }
    source.watchdog = setTimeout(() => {
      source.watchdog = null;
      this.track(this.watchdogStop(camera, source, profile));
    }, delayMs);
  }

  /**
   * The watchdog: no stop came, stop now. A failed stop is tried again a few
   * times: a camera must never keep turning against its mechanical stop.
   */
  watchdogStop(camera, source, profile) {
    return this.ptz(source, async () => {
      if (source.moving === null || source.watchdog) {
        return;
      }
      try {
        await camera.client.stop(profile);
        source.moving = null;
        source.stopFailures = 0;
        this.scheduleImage(camera, source, this.timings.imageAfterMoveMs);
      } catch (err) {
        source.stopFailures = (source.stopFailures ?? 0) + 1;
        if (source.stopFailures >= MAX_STOP_TRIES) {
          logger.error(`Stop of ${this.label(camera)} failed: ${err.message}`);
          source.moving = null;
          source.stopFailures = 0;
          return;
        }
        logger.warn(`Stop of ${this.label(camera)} failed, trying again: ${err.message}`);
        this.armWatchdog(camera, source, profile, STOP_RETRY_MS);
      }
    });
  }

  /**
   * Move for a given time then stop (scene action): resolves once stopped.
   */
  async moveFor(externalId, value, seconds) {
    const durationMs = Math.round(
      Math.min(Math.max(Number(seconds) || 1, 0.5), MAX_MOVE_SECONDS) * 1000,
    );
    await this.move(externalId, value, { durationMs });
    const { source } = this.require(externalId);
    // Wait for the watchdog stop (queued behind the move).
    await sleep(durationMs);
    await source.ptzQueue;
  }

  /** The presets of a source with their Gladys values. */
  presets(source) {
    return presetValues(source.presets ?? []);
  }

  /**
   * Go to a preset given by its Gladys value, its name or its token.
   * @returns {object} the preset `{ token, name, value }`
   */
  async gotoPreset(externalId, wanted) {
    const { camera, source } = this.require(externalId);
    if (!source.ptz) {
      throw new Error(`${this.label(camera)} has no preset positions`);
    }
    const preset = findPreset(this.presets(source), wanted);
    if (!preset) {
      throw new Error(`${this.label(camera)} has no preset "${wanted}"`);
    }
    const profile = source.ptzProfile ?? source.mainProfile;
    await this.ptz(source, async () => {
      // A failed request leaves a move under way with its watchdog.
      await this.ptzCall(camera, () => camera.client.gotoPreset(profile, preset.token));
      this.clearWatchdog(source);
      source.moving = null;
    });
    this.scheduleImage(camera, source, this.timings.imageAfterPresetMs);
    return preset;
  }

  /** A Gladys command on a feature of a camera device. */
  async setValue(device, feature, value) {
    const prefix = `${device?.external_id}:`;
    const key = feature?.external_id?.startsWith(prefix)
      ? feature.external_id.slice(prefix.length)
      : null;
    if (key === FEATURE_KEYS.MOVE) {
      await this.move(device.external_id, value);
      return;
    }
    if (key === FEATURE_KEYS.PRESET) {
      await this.gotoPreset(device.external_id, Number(value));
      return;
    }
    throw new Error(`The feature ${feature?.external_id} takes no command`);
  }

  // --- Events --------------------------------------------------------------------

  startAllEvents() {
    for (const camera of this.cameras.values()) {
      this.startEvents(camera);
    }
  }

  /** The event loop of a camera, unless it runs or the camera has no events. */
  startEvents(camera) {
    if (
      !this.eventsEnabled ||
      this.stopped ||
      camera.events ||
      !camera.hasEvents ||
      camera.displaced
    ) {
      return;
    }
    if (camera.reachable !== true) {
      return;
    }
    const controller = new AbortController();
    camera.events = { controller, subscription: null, loop: null };
    camera.events.loop = this.runEvents(camera, controller).finally(() => {
      if (camera.events?.controller === controller) {
        camera.events = null;
      }
    });
  }

  async stopEvents(camera) {
    const events = camera.events;
    if (!events) {
      return;
    }
    camera.events = null;
    events.controller.abort();
    await events.loop?.catch(() => {});
  }

  /** PullPoint: subscribe, pull in long polling, renew, start again on errors. */
  async runEvents(camera, controller) {
    const { signal } = controller;
    const client = camera.client;
    const timings = this.timings;
    while (!signal.aborted && !this.stopped) {
      if (camera.authError) {
        // No more refused requests until a search finds the account again.
        await sleep(timings.eventRetryMs, signal);
        continue;
      }
      let subscription = null;
      try {
        subscription = await client.createPullPoint(timings.subscriptionSeconds);
        camera.events.subscription = subscription;
        let expiresAt = Date.now() + (subscription.ttlMs ?? timings.subscriptionSeconds * 1000);
        logger.info(`Following the events of ${this.label(camera)}`);
        while (!signal.aborted) {
          if (expiresAt - Date.now() < (timings.pullTimeoutSeconds + 10) * 1000) {
            const renewed = await client.renew(subscription, timings.subscriptionSeconds);
            expiresAt = Date.now() + (renewed.ttlMs ?? timings.subscriptionSeconds * 1000);
          }
          const startedAt = Date.now();
          const { notifications, ttlMs } = await client.pullMessages(subscription, {
            timeoutSeconds: timings.pullTimeoutSeconds,
            signal,
          });
          if (ttlMs) {
            expiresAt = Date.now() + ttlMs;
          }
          this.markReachable(camera);
          for (const notification of notifications) {
            await this.handleNotification(camera, notification);
          }
          if (notifications.length === 0 && Date.now() - startedAt < timings.emptyPullDelayMs) {
            // A camera answering at once without waiting: do not spin.
            await sleep(timings.emptyPullDelayMs, signal);
          }
        }
      } catch (err) {
        if (signal.aborted) {
          if (subscription) {
            // Stopped: free the camera's subscription (they are few).
            await client.unsubscribe(subscription).catch(() => {});
          }
          break;
        }
        logger.warn(`Events of ${this.label(camera)} interrupted: ${err.message}`);
        if (err.kind === 'network') {
          await this.failed(camera);
        } else if (err.kind === 'auth') {
          await this.authFailed(camera);
        }
        if (subscription) {
          await client.unsubscribe(subscription).catch(() => {});
        }
        await sleep(timings.eventRetryMs, signal);
        continue;
      }
      if (subscription) {
        await client.unsubscribe(subscription).catch(() => {});
      }
    }
  }

  /** The source an event is about: by its token, else the first one. */
  sourceOf(camera, tokens) {
    return (
      camera.sources.find(
        (source) =>
          tokens.includes(source.token) ||
          source.configTokens.some((token) => tokens.includes(token)),
      ) ?? camera.sources[0]
    );
  }

  /** One notification: states, trigger, image. */
  async handleNotification(camera, notification) {
    const detections = classify(notification);
    if (detections.length === 0) {
      return;
    }
    const source = this.sourceOf(camera, sourceTokens(notification.source));
    if (!source) {
      return;
    }
    const initial = notification.operation === 'Initialized';
    for (const detection of detections) {
      if (!camera.kinds.includes(detection.kind)) {
        camera.kinds = KINDS.filter(
          (kind) => kind === detection.kind || camera.kinds.includes(kind),
        );
        logger.info(`${this.label(camera)} reports a new detection: ${detection.kind}`);
        this.scheduleRepublish();
      }
      const state = notification.operation === 'Deleted' ? false : detection.state;
      await this.setDetection(camera, source, detection, state, { initial });
      if (detection.pulse && state) {
        clearTimeout(source.pulses.get(detection.rule));
        source.pulses.set(
          detection.rule,
          setTimeout(() => {
            source.pulses.delete(detection.rule);
            this.track(this.setDetection(camera, source, detection, false, { initial: false }));
          }, this.timings.pulseMs),
        );
      }
    }
  }

  async setDetection(camera, source, detection, state, { initial }) {
    const { kind } = detection;
    const before = this.detected(source, kind);
    if (!source.active.has(kind)) {
      source.active.set(kind, new Map());
    }
    source.active.get(kind).set(detection.rule, state);
    const after = this.detected(source, kind);
    if (before === after && !(detection.pulse && state)) {
      return;
    }
    if (SENSOR_KINDS.includes(kind)) {
      await this.publishStates(camera, source).catch((err) =>
        logger.warn(`Cannot publish the states of ${camera.uid}: ${err.message}`),
      );
      this.requestWidgetRefresh();
    }
    if (after && !initial && this.isCreated(camera, source) && this.triggerDue(source, detection)) {
      this.track(
        this.gladys.publishSceneEvent(TRIGGER, {
          camera: this.ids(camera, source).device,
          kind,
          rule: detection.ruleName || null,
        }),
      );
      if (IMAGE_KINDS.includes(kind)) {
        this.scheduleImage(camera, source, 0);
      }
    }
  }

  /**
   * One scene event per detector every few seconds at most: a detection
   * flapping on several cameras would reach the core's 300 events a minute,
   * and the events past it (a doorbell…) would be lost.
   */
  triggerDue(source, detection) {
    const key = `${detection.kind}|${detection.rule}`;
    const now = Date.now();
    const last = source.lastTriggers.get(key);
    if (last !== undefined && now - last < this.timings.triggerCooldownMs) {
      return false;
    }
    source.lastTriggers.set(key, now);
    return true;
  }

  // --- Report ----------------------------------------------------------------------

  /** What the Configuration screen's "Search" action reports. */
  summary() {
    return {
      scan: this.lastScan.status,
      invalidHosts: this.config.invalidHosts,
      failures: this.failures,
      cameras: [...this.cameras.values()].map((camera) => ({
        name: deviceName(camera, camera.sources[0] ?? { index: 0 }, this.config.language),
        host: camera.host,
        reachable: camera.reachable === true,
        authError: camera.authError,
        ptz: camera.sources.some((source) => supportedMoves(source.ptz).length > 0),
        presets: camera.sources.reduce((sum, source) => sum + (source.presets?.length ?? 0), 0),
        events: camera.hasEvents,
        sources: camera.sources.length,
      })),
    };
  }
}

/** Whether an address carries credentials (user:pass@, or in its query string). */
export function hasCredentials(address) {
  if (!address) {
    return false;
  }
  try {
    const url = new URL(address);
    return (
      Boolean(url.username || url.password) || /user|usr|pass|pwd|auth|token|key/i.test(url.search)
    );
  } catch {
    return true;
  }
}

/** A preset by Gladys value, then name (case and accents ignored), then token. */
export function findPreset(presets, wanted) {
  if (typeof wanted === 'number' || /^\s*\d+\s*$/.test(String(wanted))) {
    const value = Number(wanted);
    const byValue = presets.find((preset) => preset.value === value);
    if (byValue) {
      return byValue;
    }
  }
  const fold = (text) =>
    String(text ?? '')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .trim()
      .toLowerCase();
  const name = fold(wanted);
  return (
    presets.find((preset) => fold(preset.name) === name) ??
    presets.find((preset) => fold(preset.token) === name) ??
    null
  );
}

function moveVector(move) {
  switch (move) {
    case MOVES.PAN_LEFT:
      return { x: -1, y: 0 };
    case MOVES.PAN_RIGHT:
      return { x: 1, y: 0 };
    case MOVES.TILT_UP:
      return { x: 0, y: 1 };
    case MOVES.TILT_DOWN:
      return { x: 0, y: -1 };
    case MOVES.ZOOM_IN:
      return { zoom: 1 };
    case MOVES.ZOOM_OUT:
      return { zoom: -1 };
    default:
      throw new Error(`Unknown movement ${move}`);
  }
}

function axisOf(move) {
  if (move === MOVES.PAN_LEFT || move === MOVES.PAN_RIGHT) {
    return 'pan';
  }
  if (move === MOVES.TILT_UP || move === MOVES.TILT_DOWN) {
    return 'tilt';
  }
  return 'zoom';
}

function scaleVector(vector, factor) {
  const scaled = {};
  for (const [key, value] of Object.entries(vector)) {
    scaled[key] = value * factor;
  }
  return scaled;
}
