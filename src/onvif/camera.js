// -----------------------------------------------------------------------------
// An ONVIF device, as far as the integration needs it (Profile S): identity,
// media profiles, snapshot and stream addresses, PTZ (continuous and relative
// moves, stop, presets) and events (PullPoint subscription).
//
// Every method sends one SOAP request (src/onvif/soap.js) and reads the answer
// by local element names: firmwares disagree on prefixes, never on names.
// -----------------------------------------------------------------------------

import { httpRequest, requestWithAuth } from './http.js';
import { NS, OnvifError, addressingHeaders, soapCall } from './soap.js';
import { child, children, escapeXml, find, path, serialize, textOf } from './xml.js';

export const DEFAULT_PORT = 80;
export const DEVICE_SERVICE_PATH = '/onvif/device_service';
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_TIMEOUT_MS = 10000;

const ACTIONS = {
  pull: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest',
  renew: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest',
  unsubscribe: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest',
};

const tag = (name, value) => `<${name}>${escapeXml(value)}</${name}>`;
const number = (value) => String(Math.round(value * 1000) / 1000);
const truthy = (text) => /^(true|1)$/i.test(String(text).trim());

/**
 * `2024-08-17T12:30:45Z`, or Hikvision's `2024-08-17-12:30:45Z` (see
 * onvif-zeep-async #178), to milliseconds; NaN when unreadable.
 */
export function parseOnvifTime(text) {
  const value = String(text ?? '')
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2})-(\d)/, '$1T$2');
  return value ? Date.parse(value) : Number.NaN;
}

/** The PTZ capabilities of a profile, from its configuration and its node. */
export function ptzCapabilities(configuration, node) {
  if (!configuration) {
    return null;
  }
  const spaces = child(node, 'SupportedPTZSpaces');
  const axes = (space) => {
    if (!space) {
      return { x: false, y: false };
    }
    // A range from 0 to 0 means the axis does not move.
    const moves = (range) =>
      !range || Number(textOf(range, 'Min')) !== 0 || Number(textOf(range, 'Max')) !== 0;
    return { x: moves(child(space, 'XRange')), y: moves(child(space, 'YRange')) };
  };
  const continuousPanTilt = spaces
    ? axes(child(spaces, 'ContinuousPanTiltVelocitySpace'))
    : { x: false, y: false };
  const relativePanTilt = spaces
    ? axes(child(spaces, 'RelativePanTiltTranslationSpace'))
    : { x: false, y: false };
  const fromConfiguration = (name) => textOf(configuration, name) !== '';
  const continuous = {
    pan:
      continuousPanTilt.x ||
      (!spaces && fromConfiguration('DefaultContinuousPanTiltVelocitySpace')),
    tilt:
      continuousPanTilt.y ||
      (!spaces && fromConfiguration('DefaultContinuousPanTiltVelocitySpace')),
    zoom: spaces
      ? Boolean(child(spaces, 'ContinuousZoomVelocitySpace'))
      : fromConfiguration('DefaultContinuousZoomVelocitySpace'),
  };
  const relative = {
    pan:
      relativePanTilt.x || (!spaces && fromConfiguration('DefaultRelativePanTiltTranslationSpace')),
    tilt:
      relativePanTilt.y || (!spaces && fromConfiguration('DefaultRelativePanTiltTranslationSpace')),
    zoom: spaces
      ? Boolean(child(spaces, 'RelativeZoomTranslationSpace'))
      : fromConfiguration('DefaultRelativeZoomTranslationSpace'),
  };
  const any = (set) => set.pan || set.tilt || set.zoom;
  if (!any(continuous) && !any(relative)) {
    return null;
  }
  return {
    nodeToken: textOf(configuration, 'NodeToken') || null,
    continuous,
    relative,
    maxPresets: Number(textOf(node, 'MaximumNumberOfPresets')) || null,
  };
}

/** Read a GetProfiles answer (media service version 1). */
export function readProfiles(answer) {
  return children(answer, 'Profiles').map((profile) => {
    const source = child(profile, 'VideoSourceConfiguration');
    const encoder = child(profile, 'VideoEncoderConfiguration');
    const resolution = child(encoder, 'Resolution');
    return {
      token: profile.attrs.token ?? '',
      name: textOf(profile, 'Name'),
      sourceToken: textOf(source, 'SourceToken') || null,
      sourceConfigurationToken: source?.attrs.token ?? null,
      encoding: textOf(encoder, 'Encoding') || null,
      width: Number(textOf(resolution, 'Width')) || 0,
      height: Number(textOf(resolution, 'Height')) || 0,
      ptzConfiguration: child(profile, 'PTZConfiguration'),
    };
  });
}

/** Every topic a GetEventProperties answer declares: `[{ topic, items }]`. */
export function readTopics(answer) {
  const topics = [];
  const walk = (node, segments) => {
    for (const item of node.children) {
      if (item.name === 'MessageDescription') {
        continue;
      }
      const here = [...segments, item.name];
      const description = child(item, 'MessageDescription');
      if (description || truthy(item.attrs.topic ?? '')) {
        topics.push({
          topic: here.join('/'),
          items: [
            ...children(child(description, 'Data'), 'SimpleItemDescription').map(
              (entry) => entry.attrs.Name,
            ),
          ].filter(Boolean),
        });
      }
      walk(item, here);
    }
  };
  const set = child(answer, 'TopicSet');
  if (set) {
    walk(set, []);
  }
  return topics;
}

/** One notification of a PullMessages answer, or null. */
export function readNotification(node) {
  const topic = textOf(node, 'Topic');
  const message = path(node, 'Message', 'Message') ?? find(child(node, 'Message'), 'Message');
  if (!topic || !message) {
    return null;
  }
  const items = (name) =>
    children(child(message, name), 'SimpleItem').map((item) => ({
      name: item.attrs.Name ?? '',
      value: item.attrs.Value ?? '',
    }));
  return {
    topic,
    operation: message.attrs.PropertyOperation ?? null,
    time: message.attrs.UtcTime ?? null,
    source: items('Source'),
    key: items('Key'),
    data: items('Data'),
  };
}

export class OnvifCamera {
  /**
   * @param {object} options
   * @param {string} options.host address the user typed or the discovery found
   * @param {number} [options.port]
   * @param {string} [options.path] device service path
   * @param {{ username: string, password: string } | null} [options.credentials]
   * @param {Function} [options.request] httpRequest (tests replace it)
   */
  constructor({
    host,
    port = DEFAULT_PORT,
    path: devicePath = DEVICE_SERVICE_PATH,
    credentials = null,
    request = httpRequest,
  }) {
    this.host = host;
    this.port = port;
    this.devicePath = devicePath;
    this.credentials = credentials;
    this.request = request;
    this.timeOffsetMs = 0;
    this.services = { device: this.deviceUrl };
    // The port the camera reports for its own services: when its addresses
    // carry it, it is replaced by the one that answered (port forwarding).
    this.reportedPort = null;
  }

  get origin() {
    const host = this.host.includes(':') ? `[${this.host}]` : this.host;
    return `http://${host}${this.port === DEFAULT_PORT ? '' : `:${this.port}`}`;
  }

  get deviceUrl() {
    return `${this.origin}${this.devicePath}`;
  }

  /**
   * An address the camera gave about itself, pointed at the host that
   * answered: cameras behind a NAT, or with a wrong network setting, report
   * addresses the integration cannot reach.
   */
  fixUrl(raw) {
    let url;
    try {
      url = new URL(String(raw).trim());
    } catch {
      return null;
    }
    const reportedPort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    url.hostname = this.host.includes(':') ? `[${this.host}]` : this.host;
    if (
      url.protocol === 'http:' &&
      (this.reportedPort === null || reportedPort === this.reportedPort)
    ) {
      url.port = this.port === DEFAULT_PORT ? '' : String(this.port);
    }
    return url.toString();
  }

  call(url, body, options = {}) {
    return soapCall({
      url,
      body,
      credentials: options.anonymous ? null : this.credentials,
      timeOffsetMs: this.timeOffsetMs,
      headers: options.headers,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      request: this.request,
    });
  }

  service(name) {
    const url = this.services[name];
    if (!url) {
      throw new OnvifError(`The camera has no ${name} service`, { kind: 'fault' });
    }
    return url;
  }

  // --- Device service ----------------------------------------------------------

  /**
   * Read the camera clock (no authentication needed on most firmwares) and
   * keep its offset for the WS-Security timestamps. Resolves with the offset.
   */
  async syncTime() {
    let answer;
    try {
      answer = await this.call(this.deviceUrl, '<tds:GetSystemDateAndTime/>', { anonymous: true });
    } catch (err) {
      if (err.kind !== 'auth' || !this.credentials) {
        throw err;
      }
      answer = await this.call(this.deviceUrl, '<tds:GetSystemDateAndTime/>');
    }
    const utc = find(answer, 'UTCDateTime');
    const date = child(utc, 'Date');
    const time = child(utc, 'Time');
    const parts = [
      textOf(date, 'Year'),
      textOf(date, 'Month'),
      textOf(date, 'Day'),
      textOf(time, 'Hour'),
      textOf(time, 'Minute'),
      textOf(time, 'Second'),
    ].map(Number);
    if (parts.every(Number.isFinite) && parts[0] > 2000) {
      const camera = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
      this.timeOffsetMs = camera - Date.now();
    }
    return this.timeOffsetMs;
  }

  async getDeviceInformation() {
    const answer = await this.call(this.deviceUrl, '<tds:GetDeviceInformation/>');
    return {
      manufacturer: textOf(answer, 'Manufacturer'),
      model: textOf(answer, 'Model'),
      firmware: textOf(answer, 'FirmwareVersion'),
      serial: textOf(answer, 'SerialNumber'),
      hardwareId: textOf(answer, 'HardwareId'),
    };
  }

  /**
   * The MAC address of the last enabled interface, or null: some cameras list
   * a dummy interface first, with the same address on every unit (the choice
   * of Home Assistant).
   */
  async getMacAddress() {
    const answer = await this.call(this.deviceUrl, '<tds:GetNetworkInterfaces/>');
    let mac = null;
    for (const item of children(answer, 'NetworkInterfaces')) {
      if (truthy(textOf(item, 'Enabled'))) {
        mac = textOf(path(item, 'Info'), 'HwAddress') || mac;
      }
    }
    return mac;
  }

  /** Service addresses (media, PTZ, events), GetCapabilities then GetServices. */
  async getServices() {
    const services = { device: this.deviceUrl };
    let pullPoint = null;
    try {
      const answer = await this.call(
        this.deviceUrl,
        '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>',
      );
      const capabilities = child(answer, 'Capabilities');
      const deviceAddress = textOf(child(capabilities, 'Device'), 'XAddr');
      this.reportedPort = portOf(deviceAddress);
      for (const [key, name] of [
        ['media', 'Media'],
        ['ptz', 'PTZ'],
        ['events', 'Events'],
      ]) {
        const address = textOf(child(capabilities, name), 'XAddr');
        if (address) {
          services[key] = this.fixUrl(address);
        }
      }
      const events = child(capabilities, 'Events');
      if (events) {
        pullPoint = truthy(textOf(events, 'WSPullPointSupport'));
      }
    } catch (err) {
      if (err.kind === 'auth' || err.kind === 'network') {
        throw err;
      }
    }
    if (!services.media || !services.ptz || !services.events) {
      try {
        const answer = await this.call(
          this.deviceUrl,
          '<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>',
        );
        const byNamespace = {
          [NS.trt]: 'media',
          [NS.tptz]: 'ptz',
          [NS.tev]: 'events',
        };
        const list = children(answer, 'Service');
        const device = list.find((service) => textOf(service, 'Namespace') === NS.tds);
        this.reportedPort ??= portOf(textOf(device, 'XAddr'));
        for (const service of list) {
          const key = byNamespace[textOf(service, 'Namespace')];
          const address = textOf(service, 'XAddr');
          if (key && address && !services[key]) {
            services[key] = this.fixUrl(address);
          }
        }
      } catch (err) {
        if (err.kind === 'auth' || err.kind === 'network') {
          throw err;
        }
      }
    }
    this.services = services;
    return { services, pullPoint };
  }

  // --- Media service -----------------------------------------------------------

  async getProfiles() {
    return readProfiles(await this.call(this.service('media'), '<trt:GetProfiles/>'));
  }

  async getSnapshotUri(profileToken) {
    const answer = await this.call(
      this.service('media'),
      `<trt:GetSnapshotUri>${tag('trt:ProfileToken', profileToken)}</trt:GetSnapshotUri>`,
    );
    const uri = textOf(child(answer, 'MediaUri'), 'Uri');
    return uri ? this.fixUrl(uri) : null;
  }

  async getStreamUri(profileToken) {
    const answer = await this.call(
      this.service('media'),
      '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>' +
        '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>' +
        `${tag('trt:ProfileToken', profileToken)}</trt:GetStreamUri>`,
    );
    const uri = textOf(child(answer, 'MediaUri'), 'Uri');
    if (!uri) {
      return null;
    }
    // The RTSP address keeps its own port; only its host is fixed.
    try {
      const url = new URL(uri);
      url.hostname = this.host.includes(':') ? `[${this.host}]` : this.host;
      return url.toString();
    } catch {
      return null;
    }
  }

  /** The JPEG (or other image) bytes behind a snapshot address. */
  async fetchSnapshot(uri, { signal } = {}) {
    const response = await requestWithAuth({
      method: 'GET',
      url: uri,
      credentials: this.credentials?.username ? this.credentials : null,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      maxBytes: SNAPSHOT_MAX_BYTES,
      signal,
      request: this.request,
    }).catch((err) => {
      throw new OnvifError(err.message, { kind: 'network', cause: err });
    });
    if (response.status === 401 || response.status === 403) {
      throw new OnvifError(`Snapshot refused (HTTP ${response.status})`, {
        kind: 'auth',
        status: response.status,
      });
    }
    if (response.status !== 200 || !isImage(response.body)) {
      throw new OnvifError(`No image at the snapshot address (HTTP ${response.status})`, {
        kind: 'http',
        status: response.status,
      });
    }
    return response.body;
  }

  // --- PTZ service ---------------------------------------------------------------

  async getNodes() {
    const answer = await this.call(this.service('ptz'), '<tptz:GetNodes/>');
    return children(answer, 'PTZNode');
  }

  async getPresets(profileToken) {
    const answer = await this.call(
      this.service('ptz'),
      `<tptz:GetPresets>${tag('tptz:ProfileToken', profileToken)}</tptz:GetPresets>`,
    );
    return children(answer, 'Preset')
      .map((preset) => ({ token: preset.attrs.token ?? '', name: textOf(preset, 'Name') }))
      .filter((preset) => preset.token);
  }

  gotoPreset(profileToken, presetToken) {
    return this.call(
      this.service('ptz'),
      `<tptz:GotoPreset>${tag('tptz:ProfileToken', profileToken)}` +
        `${tag('tptz:PresetToken', presetToken)}</tptz:GotoPreset>`,
    );
  }

  /** `vector`: `{ x, y }` for pan/tilt, `{ zoom }` for the zoom, in -1…1. */
  continuousMove(profileToken, vector) {
    return this.call(
      this.service('ptz'),
      `<tptz:ContinuousMove>${tag('tptz:ProfileToken', profileToken)}` +
        `<tptz:Velocity>${vectorXml(vector)}</tptz:Velocity></tptz:ContinuousMove>`,
    );
  }

  relativeMove(profileToken, vector) {
    return this.call(
      this.service('ptz'),
      `<tptz:RelativeMove>${tag('tptz:ProfileToken', profileToken)}` +
        `<tptz:Translation>${vectorXml(vector)}</tptz:Translation></tptz:RelativeMove>`,
    );
  }

  stop(profileToken) {
    return this.call(
      this.service('ptz'),
      `<tptz:Stop>${tag('tptz:ProfileToken', profileToken)}` +
        '<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>',
    );
  }

  // --- Event service -------------------------------------------------------------

  async getEventProperties() {
    return readTopics(await this.call(this.service('events'), '<tev:GetEventProperties/>'));
  }

  /** A PullPoint subscription: `{ address, referenceParameters, ttlMs }`. */
  async createPullPoint(seconds) {
    let answer;
    try {
      answer = await this.call(
        this.service('events'),
        `<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT${seconds}S` +
          '</tev:InitialTerminationTime></tev:CreatePullPointSubscription>',
      );
    } catch (err) {
      if (err.kind !== 'fault') {
        throw err;
      }
      // Some firmwares refuse a termination time: let them choose.
      answer = await this.call(this.service('events'), '<tev:CreatePullPointSubscription/>');
    }
    const reference = child(answer, 'SubscriptionReference');
    const address = textOf(reference, 'Address');
    if (!address) {
      throw new OnvifError('The camera gave no subscription address', { kind: 'parse' });
    }
    const parameters = child(reference, 'ReferenceParameters');
    return {
      address: this.fixUrl(address) ?? address,
      referenceParameters: parameters ? parameters.children.map(serialize).join('') : '',
      ttlMs: lifetime(answer),
    };
  }

  /** Pull the waiting notifications: `{ notifications, ttlMs }`. */
  async pullMessages(subscription, { timeoutSeconds, limit = 100, signal }) {
    const answer = await this.call(
      subscription.address,
      `<tev:PullMessages><tev:Timeout>PT${timeoutSeconds}S</tev:Timeout>` +
        `<tev:MessageLimit>${limit}</tev:MessageLimit></tev:PullMessages>`,
      {
        headers: addressingHeaders({
          action: ACTIONS.pull,
          to: subscription.address,
          referenceParameters: subscription.referenceParameters,
        }),
        // The camera holds the request until an event or the timeout.
        timeoutMs: (timeoutSeconds + 10) * 1000,
        signal,
      },
    );
    return {
      notifications: children(answer, 'NotificationMessage').map(readNotification).filter(Boolean),
      ttlMs: lifetime(answer),
    };
  }

  async renew(subscription, seconds) {
    const answer = await this.call(
      subscription.address,
      `<wsnt:Renew><wsnt:TerminationTime>PT${seconds}S</wsnt:TerminationTime></wsnt:Renew>`,
      {
        headers: addressingHeaders({
          action: ACTIONS.renew,
          to: subscription.address,
          referenceParameters: subscription.referenceParameters,
        }),
      },
    );
    return { ttlMs: lifetime(answer) };
  }

  unsubscribe(subscription) {
    return this.call(subscription.address, '<wsnt:Unsubscribe/>', {
      headers: addressingHeaders({
        action: ACTIONS.unsubscribe,
        to: subscription.address,
        referenceParameters: subscription.referenceParameters,
      }),
      timeoutMs: 5000,
    });
  }
}

function vectorXml({ x, y, zoom }) {
  const panTilt =
    x !== undefined || y !== undefined
      ? `<tt:PanTilt x="${number(x ?? 0)}" y="${number(y ?? 0)}"/>`
      : '';
  const zoomXml = zoom !== undefined ? `<tt:Zoom x="${number(zoom)}"/>` : '';
  return panTilt + zoomXml;
}

/** Time left on a subscription, from the camera's own clock (null if unknown). */
function lifetime(answer) {
  const current = parseOnvifTime(textOf(answer, 'CurrentTime'));
  const termination = parseOnvifTime(textOf(answer, 'TerminationTime'));
  return Number.isFinite(current) && Number.isFinite(termination) && termination > current
    ? termination - current
    : null;
}

function portOf(address) {
  try {
    const url = new URL(address);
    return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/** JPEG, PNG, GIF, BMP or WebP, by their magic numbers. */
export function isImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return false;
  }
  return (
    (buffer[0] === 0xff && buffer[1] === 0xd8) ||
    buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
    buffer.subarray(0, 3).toString('latin1') === 'GIF' ||
    buffer.subarray(0, 2).toString('latin1') === 'BM' ||
    (buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buffer.subarray(8, 12).toString('latin1') === 'WEBP')
  );
}
