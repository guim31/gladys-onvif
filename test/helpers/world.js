// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, fake cameras on a fake network
// (test/helpers/fakeCamera.js), a temporary /data and a fake image processor,
// with the integration wired on top through registerHandlers. No periodic
// timer runs; event subscriptions run only when asked (`events: true`), with
// short timings.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { MAX_JPEG_BYTES } from '../../src/image.js';
import { Store } from '../../src/store.js';
import { FakeCamera, SMALL_JPEG, createNetwork } from './fakeCamera.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const FAST_EVENTS = {
  pullTimeoutSeconds: 1,
  emptyPullDelayMs: 10,
  eventRetryMs: 50,
  pulseMs: 80,
  triggerCooldownMs: 0,
  imageAfterMoveMs: 10,
  imageAfterPresetMs: 10,
  minImageSpacingMs: 0,
  freshImageMs: 0,
};

/** Stands for ffmpeg: records what it is asked, answers a small JPEG. */
export class FakeImages {
  constructor() {
    this.fitted = [];
    this.grabbed = [];
  }

  async fit(image) {
    this.fitted.push(image.length);
    return image.length <= MAX_JPEG_BYTES ? image : SMALL_JPEG;
  }

  async grab(url) {
    this.grabbed.push(url);
    return SMALL_JPEG;
  }
}

export const DEFAULT_CONFIG = { username: 'admin', password: 'secret', language: 'en' };

/**
 * @param {object} [options]
 * @param {FakeCamera[]} [options.cameras]
 * @param {boolean} [options.scan] whether the core's discovery finds them
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.created] devices already created in Gladys
 * @param {boolean} [options.events] run the event subscriptions
 */
export async function createWorld({
  cameras = [new FakeCamera()],
  scan = true,
  config = DEFAULT_CONFIG,
  created = [],
  connect = true,
  events = false,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-onvif-')),
  timings = {},
} = {}) {
  const network = createNetwork(cameras);
  const gladys = createFakeGladys({
    config,
    devices: created,
    scanResults: { 'udp-active-broadcast': scan ? network.probeReplies() : [] },
  });
  const images = new FakeImages();
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: (options) => network.request(options),
    images,
    timers: false,
    events,
    timings: { ...(events ? FAST_EVENTS : {}), ...timings },
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
    await app.hub.idle();
  }
  return { gladys, fake: gladys.fake, network, app, hub: app.hub, images, dataDir };
}

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
  await world.hub.idle();
}

/** Wait until `check()` is true (event loops run in the background). */
export async function waitFor(check, { timeoutMs = 2000, message = 'condition' } = {}) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export { FakeCamera };
