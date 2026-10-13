// -----------------------------------------------------------------------------
// Simulated ONVIF cameras, behind the `request` seam of src/onvif/http.js (and
// behind a real HTTP server for the Docker checks, see serveCamera).
//
// Three models:
//   - `happytime`: the answers RECORDED from the Happytime ONVIF server 2.4
//     (test/fixtures/onvif/happytime, addresses anonymized): PTZ with zoom,
//     two profiles, events, snapshot without authentication;
//   - `hikvision`: a fixed bullet camera written after the Hikvision quirks of
//     onvif-zeep-async's fake camera (MIT): "Zulu" timestamps only,
//     `2024-08-17-12:30:45Z` subscription times, Digest on the snapshot,
//     no PTZ, a 4K main stream;
//   - `tapo`: a TP-Link Tapo style pan/tilt camera on port 2020, without
//     snapshot address (frames come from RTSP), numbered presets, the Tapo
//     event topics of onvif-parsers' tests.
//
// WS-Security is checked for real: the password digest, and the creation
// time against the camera's own clock (`clockOffsetMs`).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { authorization, parseChallenge } from '../../src/onvif/digest.js';
import { HttpError } from '../../src/onvif/http.js';
import { children, escapeXml, find, parseXml, textOf } from '../../src/onvif/xml.js';

const FIXTURES = new URL('../fixtures/onvif/', import.meta.url);

export const NOTIFICATIONS = JSON.parse(
  readFileSync(new URL('notifications.json', FIXTURES), 'utf8'),
).notifications;

const HAPPYTIME = Object.fromEntries(
  readdirSync(new URL('happytime/', FIXTURES))
    .filter((name) => name.endsWith('.xml'))
    .map((name) => [
      name.slice(0, -4),
      readFileSync(new URL(`happytime/${name}`, FIXTURES), 'utf8'),
    ]),
);

/** A small but real JPEG (the Happytime test image), and a large one. */
export const SMALL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
export const LARGE_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(300 * 1024, 7),
  Buffer.from([0xff, 0xd9]),
]);

const NS =
  'xmlns:env="http://www.w3.org/2003/05/soap-envelope" ' +
  'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" ' +
  'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ' +
  'xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" ' +
  'xmlns:tev="http://www.onvif.org/ver10/events/wsdl" ' +
  'xmlns:wsa="http://www.w3.org/2005/08/addressing" ' +
  'xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" ' +
  'xmlns:wstop="http://docs.oasis-open.org/wsn/t-1" ' +
  'xmlns:tns1="http://www.onvif.org/ver10/topics" ' +
  'xmlns:tt="http://www.onvif.org/ver10/schema"';

const soapEnvelope = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?><env:Envelope ${NS}><env:Body>${body}</env:Body></env:Envelope>`;

const soapFault = (reason, subcode) =>
  soapEnvelope(
    '<env:Fault><env:Code><env:Value>env:Sender</env:Value>' +
      `<env:Subcode><env:Value>ter:${subcode}</env:Value></env:Subcode></env:Code>` +
      `<env:Reason><env:Text xml:lang="en">${escapeXml(reason)}</env:Text></env:Reason></env:Fault>`,
  );

const zulu = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

// --- Models ---------------------------------------------------------------------

const MODELS = {
  happytime: {
    port: 8000,
    info: null, // from the recording
    snapshotAuth: false,
  },
  hikvision: {
    port: 80,
    info: {
      Manufacturer: 'HIKVISION',
      Model: 'DS-2CD2085FWD-I',
      FirmwareVersion: 'V5.5.82 build 190909',
      SerialNumber: 'DS-2CD2085FWD-I20190101AAWR000000000',
      HardwareId: '88',
    },
    paths: {
      device: '/onvif/device_service',
      media: '/onvif/Media',
      events: '/onvif/Events',
    },
    profiles: [
      {
        token: 'Profile_1',
        name: 'mainStream',
        source: 'VideoSource_1',
        width: 3840,
        height: 2160,
        encoding: 'H265',
      },
      {
        token: 'Profile_2',
        name: 'subStream',
        source: 'VideoSource_1',
        width: 640,
        height: 360,
        encoding: 'H264',
      },
    ],
    snapshotPath: '/onvif-http/snapshot?Profile_1',
    snapshotAuth: true,
    topics: [
      ['VideoSource/MotionAlarm', ['State']],
      ['RuleEngine/CellMotionDetector/Motion', ['IsMotion']],
      ['RuleEngine/TamperDetector/Tamper', ['IsTamper']],
      ['RuleEngine/FieldDetector/ObjectsInside', ['IsInside']],
      ['RuleEngine/LineDetector/Crossed', ['ObjectId']],
    ],
    dashedTimes: true,
  },
  tapo: {
    port: 2020,
    info: {
      Manufacturer: 'tp-link',
      Model: 'C200',
      FirmwareVersion: '1.3.6 Build 230526 Rel.58726n',
      SerialNumber: '00000000',
      HardwareId: '4.0',
    },
    paths: {
      device: '/onvif/device_service',
      media: '/onvif/service',
      ptz: '/onvif/service',
      events: '/onvif/service',
    },
    profiles: [
      {
        token: 'profile_1',
        name: 'mainStream',
        source: 'vsrc',
        width: 1920,
        height: 1080,
        encoding: 'H264',
        ptz: true,
      },
      {
        token: 'profile_2',
        name: 'minorStream',
        source: 'vsrc',
        width: 640,
        height: 360,
        encoding: 'H264',
        ptz: true,
      },
    ],
    snapshotPath: null,
    ptz: {
      panTilt: true,
      zoom: false,
      presets: [
        ['1', 'Porte'],
        ['2', 'Fenêtre'],
      ],
    },
    topics: [
      ['RuleEngine/CellMotionDetector/Motion', ['IsMotion']],
      ['RuleEngine/PeopleDetector/People', ['IsPeople']],
      ['RuleEngine/TPSmartEventDetector/TPSmartEvent', ['IsVehicle', 'IsPet']],
      ['RuleEngine/LineCrossDetector/LineCross', ['IsLineCross']],
      ['RuleEngine/CellMotionDetector/Tamper', ['IsTamper']],
      ['RuleEngine/CellMotionDetector/Intrusion', ['IsIntrusion']],
    ],
  },
};

export class FakeCamera {
  /**
   * @param {object} options
   * @param {string} [options.model] happytime | hikvision | tapo
   * @param {string} [options.host]
   * @param {number} [options.port]
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {string} [options.mac]
   * @param {number} [options.clockOffsetMs] camera clock minus real time
   * @param {Buffer} [options.snapshot] the image behind the snapshot address
   */
  constructor({
    model = 'happytime',
    host = '192.0.2.20',
    port,
    username = 'admin',
    password = 'secret',
    mac = '02-00-5E-10-00-01',
    clockOffsetMs = 0,
    snapshot = SMALL_JPEG,
  } = {}) {
    this.model = model;
    this.spec = MODELS[model];
    this.host = host;
    this.port = port ?? this.spec.port;
    this.username = username;
    this.password = password;
    this.mac = mac;
    this.clockOffsetMs = clockOffsetMs;
    this.snapshot = snapshot;
    this.online = true;
    // Notifications sent as `Initialized` when a subscription starts.
    this.initialState = [];
    this.calls = [];
    this.moves = [];
    this.queue = [];
    this.subscriptions = new Map();
    this.nextSubscription = 0;
    this.presets =
      model === 'happytime'
        ? null
        : (this.spec.ptz?.presets ?? []).map(([token, name]) => ({ token, name }));
  }

  get base() {
    return `http://${this.host}${this.port === 80 ? '' : `:${this.port}`}`;
  }

  /** Queue the notification of notifications.json `id`, with a state. */
  emit(id, { value, operation = 'Changed' } = {}) {
    const found = NOTIFICATIONS.find((item) => item.id === id);
    if (!found) {
      throw new Error(`No notification ${id}`);
    }
    const data =
      value === undefined ? found.data : found.data.map(([name]) => [name, String(value)]);
    this.queue.push({ ...found, data, operation });
  }

  operations() {
    return this.calls.map((call) => call.operation);
  }

  // --- HTTP ---------------------------------------------------------------------

  async handle({ method, url, headers = {}, body }) {
    const target = new URL(url);
    const path = `${target.pathname}${target.search}`;
    if (method === 'GET') {
      return this.handleSnapshot(path, headers);
    }
    const text = Buffer.from(body ?? '').toString('utf8');
    let root;
    try {
      root = parseXml(text);
    } catch {
      return respond(400, soapFault('Bad XML', 'InvalidArgVal'));
    }
    const request = find(root, 'Body')?.children[0];
    const operation = request?.name ?? '';
    const auth = this.checkAuth(root);
    this.calls.push({ operation, path, auth, request, headers: find(root, 'Header') });
    if (operation !== 'GetSystemDateAndTime' && auth !== 'ok') {
      return respond(400, soapFault('Sender not Authorized', 'NotAuthorized'));
    }
    const answer = this.answer(operation, request, path);
    if (answer === null) {
      return respond(400, soapFault(`Unknown operation ${operation}`, 'ActionNotSupported'));
    }
    if (answer.fault) {
      return respond(400, answer.fault);
    }
    return respond(200, answer);
  }

  handleSnapshot(path, headers) {
    const snapshotPath =
      this.model === 'happytime' ? '/snapshot/ProfileToken_1' : this.spec.snapshotPath;
    if (!snapshotPath || path !== snapshotPath) {
      return { status: 404, headers: {}, authenticate: [], body: Buffer.from('Not found') };
    }
    if (this.spec.snapshotAuth) {
      const header = headers.authorization ?? '';
      const challenge = { realm: 'IP Camera', nonce: 'fixednonce', qop: 'auth' };
      const params = parseChallenge(header.replace(/^Digest/, 'Digest'));
      const expected =
        params &&
        authorization({
          challenge,
          username: this.username,
          password: this.password,
          method: 'GET',
          uri: path,
          nc: Number.parseInt(params.nc ?? '1', 16),
          cnonce: params.cnonce,
        });
      if (!expected || !header || parseChallenge(expected).response !== params.response) {
        return {
          status: 401,
          headers: {},
          authenticate: ['Digest realm="IP Camera", nonce="fixednonce", qop="auth"'],
          body: Buffer.from('Unauthorized'),
        };
      }
    }
    return {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      authenticate: [],
      body: this.snapshot,
    };
  }

  /** 'ok', 'missing', 'bad-password' or 'bad-time'. */
  checkAuth(root) {
    const token = find(root, 'UsernameToken');
    if (!token) {
      return 'missing';
    }
    const created = textOf(token, 'Created');
    const nonce = Buffer.from(textOf(token, 'Nonce'), 'base64');
    const digest = createHash('sha1')
      .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(this.password)]))
      .digest('base64');
    if (textOf(token, 'Username') !== this.username || textOf(token, 'Password') !== digest) {
      return 'bad-password';
    }
    if (!/Z$/.test(created) || Math.abs(Date.parse(created) - this.now()) > 5 * 60_000) {
      return 'bad-time';
    }
    return 'ok';
  }

  now() {
    return Date.now() + this.clockOffsetMs;
  }

  // --- Operations ---------------------------------------------------------------

  fixture(name) {
    return HAPPYTIME[name]
      .replaceAll('{{base}}', this.base)
      .replaceAll('{{host}}', this.host)
      .replaceAll('02-00-5E-10-00-01', this.mac);
  }

  answer(operation, request, path) {
    const happy = this.model === 'happytime';
    switch (operation) {
      case 'GetSystemDateAndTime':
        return this.dateAndTime();
      case 'GetDeviceInformation':
        return happy ? this.fixture(operation) : this.deviceInformation();
      case 'GetNetworkInterfaces':
        return happy ? this.fixture(operation) : this.networkInterfaces();
      case 'GetCapabilities':
        return happy ? this.fixture(operation) : this.capabilities();
      case 'GetServices':
        return happy ? this.fixture(operation) : null;
      case 'GetProfiles':
        return happy ? this.fixture(operation) : this.profiles();
      case 'GetSnapshotUri':
        if (happy) {
          return textOf(request, 'ProfileToken') === 'ProfileToken_1'
            ? this.fixture(operation)
            : { fault: this.fixture('Fault-GetSnapshotUri') };
        }
        return this.spec.snapshotPath
          ? soapEnvelope(
              `<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>${escapeXml(this.base + this.spec.snapshotPath)}</tt:Uri>` +
                '<tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>' +
                '<tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetSnapshotUriResponse>',
            )
          : { fault: soapFault('Snapshot is not supported', 'ActionNotSupported') };
      case 'GetStreamUri':
        return happy
          ? this.fixture(operation)
          : soapEnvelope(
              `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://${this.host}:554/stream2</tt:Uri>` +
                '<tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>' +
                '<tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>',
            );
      case 'GetNodes':
        if (happy) {
          return this.fixture(operation);
        }
        return this.spec.ptz ? this.nodes() : null;
      case 'GetPresets':
        if (happy && this.presets === null) {
          return this.fixture(operation);
        }
        return this.spec.ptz || happy ? this.presetList() : null;
      case 'ContinuousMove':
      case 'RelativeMove':
      case 'Stop':
        if (!this.spec.ptz && !happy) {
          return null;
        }
        this.moves.push({ operation, profile: textOf(request, 'ProfileToken'), xml: request });
        return happy ? this.fixture(operation) : soapEnvelope(`<tptz:${operation}Response/>`);
      case 'GotoPreset': {
        const token = textOf(request, 'PresetToken');
        const known = this.presets ?? presetsOf(this.fixture('GetPresets'));
        if (!known.some((preset) => preset.token === token)) {
          return {
            fault: happy
              ? this.fixture('Fault-GotoPreset')
              : soapFault('No such preset', 'NoToken'),
          };
        }
        this.moves.push({ operation, profile: textOf(request, 'ProfileToken'), preset: token });
        return soapEnvelope('<tptz:GotoPresetResponse/>');
      }
      case 'GetEventProperties':
        return happy ? this.fixture(operation) : this.eventProperties();
      case 'CreatePullPointSubscription':
        return this.subscribe();
      case 'PullMessages':
        return this.pull(path);
      case 'Renew':
        return this.renew(path);
      case 'Unsubscribe':
        this.subscriptions.delete(path);
        return soapEnvelope('<wsnt:UnsubscribeResponse/>');
      default:
        return null;
    }
  }

  dateAndTime() {
    const date = new Date(this.now());
    return soapEnvelope(
      '<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime>' +
        '<tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings>' +
        '<tt:TimeZone><tt:TZ>CST-8:00:00</tt:TZ></tt:TimeZone><tt:UTCDateTime>' +
        `<tt:Time><tt:Hour>${date.getUTCHours()}</tt:Hour><tt:Minute>${date.getUTCMinutes()}</tt:Minute>` +
        `<tt:Second>${date.getUTCSeconds()}</tt:Second></tt:Time>` +
        `<tt:Date><tt:Year>${date.getUTCFullYear()}</tt:Year><tt:Month>${date.getUTCMonth() + 1}</tt:Month>` +
        `<tt:Day>${date.getUTCDate()}</tt:Day></tt:Date>` +
        '</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>',
    );
  }

  deviceInformation() {
    const fields = Object.entries(this.spec.info)
      .map(([key, value]) => `<tds:${key}>${escapeXml(value)}</tds:${key}>`)
      .join('');
    return soapEnvelope(
      `<tds:GetDeviceInformationResponse>${fields}</tds:GetDeviceInformationResponse>`,
    );
  }

  networkInterfaces() {
    // A dummy interface first, as some cameras list (same MAC on every unit).
    return soapEnvelope(
      '<tds:GetNetworkInterfacesResponse>' +
        '<tds:NetworkInterfaces token="dummy"><tt:Enabled>true</tt:Enabled><tt:Info><tt:Name>dummy0</tt:Name>' +
        '<tt:HwAddress>00:11:22:33:44:55</tt:HwAddress></tt:Info></tds:NetworkInterfaces>' +
        `<tds:NetworkInterfaces token="eth0"><tt:Enabled>true</tt:Enabled><tt:Info><tt:Name>eth0</tt:Name>` +
        `<tt:HwAddress>${this.mac}</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info></tds:NetworkInterfaces>` +
        '</tds:GetNetworkInterfacesResponse>',
    );
  }

  capabilities() {
    const { paths } = this.spec;
    const xaddr = (path) => `<tt:XAddr>${this.base}${path}</tt:XAddr>`;
    return soapEnvelope(
      '<tds:GetCapabilitiesResponse><tds:Capabilities>' +
        `<tt:Device>${xaddr(paths.device)}</tt:Device>` +
        (paths.events
          ? `<tt:Events>${xaddr(paths.events)}<tt:WSSubscriptionPolicySupport>true</tt:WSSubscriptionPolicySupport>` +
            '<tt:WSPullPointSupport>true</tt:WSPullPointSupport></tt:Events>'
          : '') +
        `<tt:Media>${xaddr(paths.media)}<tt:StreamingCapabilities><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP></tt:StreamingCapabilities></tt:Media>` +
        (paths.ptz ? `<tt:PTZ>${xaddr(paths.ptz)}</tt:PTZ>` : '') +
        '</tds:Capabilities></tds:GetCapabilitiesResponse>',
    );
  }

  profiles() {
    const ptzConfiguration = () => {
      const { panTilt, zoom } = this.spec.ptz;
      return (
        '<tt:PTZConfiguration token="PTZConfig"><tt:Name>PTZ</tt:Name><tt:NodeToken>PTZNode</tt:NodeToken>' +
        (panTilt
          ? '<tt:DefaultContinuousPanTiltVelocitySpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:DefaultContinuousPanTiltVelocitySpace>'
          : '') +
        (zoom
          ? '<tt:DefaultContinuousZoomVelocitySpace>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:DefaultContinuousZoomVelocitySpace>'
          : '') +
        '</tt:PTZConfiguration>'
      );
    };
    const profiles = this.spec.profiles
      .map(
        (profile) =>
          `<trt:Profiles token="${profile.token}" fixed="true"><tt:Name>${profile.name}</tt:Name>` +
          `<tt:VideoSourceConfiguration token="vsconf"><tt:Name>VideoSourceConfig</tt:Name>` +
          `<tt:UseCount>2</tt:UseCount><tt:SourceToken>${profile.source}</tt:SourceToken></tt:VideoSourceConfiguration>` +
          `<tt:VideoEncoderConfiguration token="enc_${profile.token}"><tt:Name>${profile.name}</tt:Name>` +
          `<tt:Encoding>${profile.encoding}</tt:Encoding><tt:Resolution><tt:Width>${profile.width}</tt:Width>` +
          `<tt:Height>${profile.height}</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>` +
          (profile.ptz ? ptzConfiguration() : '') +
          '</trt:Profiles>',
      )
      .join('');
    return soapEnvelope(`<trt:GetProfilesResponse>${profiles}</trt:GetProfilesResponse>`);
  }

  nodes() {
    const { panTilt, zoom } = this.spec.ptz;
    const range = (axis) =>
      `<tt:${axis}Range><tt:Min>-1.0</tt:Min><tt:Max>1.0</tt:Max></tt:${axis}Range>`;
    return soapEnvelope(
      '<tptz:GetNodesResponse><tptz:PTZNode token="PTZNode" FixedHomePosition="false">' +
        '<tt:Name>PTZNode</tt:Name><tt:SupportedPTZSpaces>' +
        (panTilt
          ? '<tt:RelativePanTiltTranslationSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:URI>' +
            `${range('X')}${range('Y')}</tt:RelativePanTiltTranslationSpace>` +
            '<tt:ContinuousPanTiltVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI>' +
            `${range('X')}${range('Y')}</tt:ContinuousPanTiltVelocitySpace>`
          : '') +
        (zoom
          ? '<tt:ContinuousZoomVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:URI>' +
            `${range('X')}</tt:ContinuousZoomVelocitySpace>`
          : '') +
        '</tt:SupportedPTZSpaces><tt:MaximumNumberOfPresets>8</tt:MaximumNumberOfPresets>' +
        '<tt:HomeSupported>true</tt:HomeSupported></tptz:PTZNode></tptz:GetNodesResponse>',
    );
  }

  presetList() {
    const presets = this.presets ?? [];
    return soapEnvelope(
      `<tptz:GetPresetsResponse>${presets
        .map(
          (preset) =>
            `<tptz:Preset token="${escapeXml(preset.token)}"><tt:Name>${escapeXml(preset.name)}</tt:Name></tptz:Preset>`,
        )
        .join('')}</tptz:GetPresetsResponse>`,
    );
  }

  eventProperties() {
    const tree = {};
    for (const [topic, items] of this.spec.topics) {
      let node = tree;
      for (const segment of topic.split('/')) {
        node[segment] ??= {};
        node = node[segment];
      }
      node.__items = items;
    }
    const write = (node, depth) =>
      Object.entries(node)
        .filter(([key]) => key !== '__items')
        .map(([key, value]) => {
          const name = depth === 0 ? `tns1:${key}` : key;
          const description = value.__items
            ? '<tt:MessageDescription IsProperty="true"><tt:Data>' +
              value.__items
                .map((item) => `<tt:SimpleItemDescription Name="${item}" Type="xs:boolean"/>`)
                .join('') +
              '</tt:Data></tt:MessageDescription>'
            : '';
          const attr = value.__items ? ' wstop:topic="true"' : '';
          return `<${name}${attr}>${description}${write(value, depth + 1)}</${name}>`;
        })
        .join('');
    return soapEnvelope(
      '<tev:GetEventPropertiesResponse><tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation>' +
        `<wsnt:FixedTopicSet>true</wsnt:FixedTopicSet><wstop:TopicSet>${write(tree, 0)}</wstop:TopicSet>` +
        '</tev:GetEventPropertiesResponse>',
    );
  }

  time(ms) {
    const text = zulu(ms);
    // Hikvision writes `2024-08-17-12:30:45Z` (onvif-zeep-async #178).
    return this.spec.dashedTimes ? text.replace('T', '-') : text;
  }

  subscribe() {
    this.nextSubscription += 1;
    const path =
      this.model === 'happytime'
        ? `/event_service/${this.nextSubscription - 1}`
        : `/onvif/Subscription?Idx=${this.nextSubscription}`;
    const now = this.now();
    this.subscriptions.set(path, { expiresAt: now + 60_000 });
    // Initialized: the state of every detector when the subscription starts.
    for (const item of this.initialState ?? []) {
      this.emit(item, { value: false, operation: 'Initialized' });
    }
    return soapEnvelope(
      '<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference>' +
        `<wsa:Address>${this.base}${escapeXml(path)}</wsa:Address>` +
        (this.model === 'tapo'
          ? '<wsa:ReferenceParameters><tt:SubscriptionId xmlns:tt="http://www.onvif.org/ver10/schema">42</tt:SubscriptionId></wsa:ReferenceParameters>'
          : '') +
        `</tev:SubscriptionReference><wsnt:CurrentTime>${this.time(now)}</wsnt:CurrentTime>` +
        `<wsnt:TerminationTime>${this.time(now + 60_000)}</wsnt:TerminationTime>` +
        '</tev:CreatePullPointSubscriptionResponse>',
    );
  }

  pull(path) {
    const subscription = this.subscriptions.get(path);
    if (!subscription) {
      return { fault: soapFault('Unknown subscription', 'InvalidArgVal') };
    }
    const now = this.now();
    // Each pull keeps the subscription alive, as Hikvision firmwares do.
    subscription.expiresAt = now + 60_000;
    const messages = this.queue
      .splice(0)
      .map((item) => notificationXml(item, now))
      .join('');
    return soapEnvelope(
      `<tev:PullMessagesResponse><tev:CurrentTime>${this.time(now)}</tev:CurrentTime>` +
        `<tev:TerminationTime>${this.time(subscription.expiresAt)}</tev:TerminationTime>${messages}</tev:PullMessagesResponse>`,
    );
  }

  renew(path) {
    const subscription = this.subscriptions.get(path);
    if (!subscription) {
      return { fault: soapFault('Unknown subscription', 'InvalidArgVal') };
    }
    const now = this.now();
    subscription.expiresAt = now + 60_000;
    return soapEnvelope(
      `<wsnt:RenewResponse><wsnt:TerminationTime>${this.time(subscription.expiresAt)}</wsnt:TerminationTime>` +
        `<wsnt:CurrentTime>${this.time(now)}</wsnt:CurrentTime></wsnt:RenewResponse>`,
    );
  }
}

function notificationXml({ topic, source, data, operation }, now) {
  const items = (list) =>
    list
      .map(([name, value]) => `<tt:SimpleItem Name="${name}" Value="${escapeXml(value)}"/>`)
      .join('');
  return (
    '<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">' +
    `${topic}</wsnt:Topic><wsnt:Message><tt:Message UtcTime="${zulu(now)}" PropertyOperation="${operation}">` +
    `<tt:Source>${items(source)}</tt:Source><tt:Data>${items(data)}</tt:Data></tt:Message></wsnt:Message>` +
    '</wsnt:NotificationMessage>'
  );
}

function presetsOf(xml) {
  const root = parseXml(xml);
  return children(find(root, 'GetPresetsResponse'), 'Preset').map((preset) => ({
    token: preset.attrs.token,
    name: textOf(preset, 'Name'),
  }));
}

function respond(status, xml) {
  return {
    status,
    headers: { 'content-type': 'application/soap+xml; charset=utf-8' },
    authenticate: [],
    body: Buffer.from(xml, 'utf8'),
  };
}

/**
 * A network of fake cameras: `request` has the signature of httpRequest, and
 * answers like a camera at the address, or fails like an absent host.
 */
export function createNetwork(cameras = []) {
  const network = {
    cameras,
    async request(options) {
      const target = new URL(options.url);
      const port = target.port ? Number(target.port) : 80;
      const camera = network.cameras.find(
        (item) => item.host === target.hostname && item.port === port && item.online,
      );
      if (!camera) {
        throw new HttpError('connect EHOSTUNREACH', { code: 'EHOSTUNREACH' });
      }
      if (options.signal?.aborted) {
        throw new HttpError('Request aborted', { code: 'EABORTED' });
      }
      return camera.handle(options);
    },
    /** The WS-Discovery answers of the cameras, as the core relays them. */
    probeReplies() {
      return network.cameras
        .filter((camera) => camera.online)
        .map((camera) => ({
          source_ip: camera.host,
          source_port: 3702,
          payload_base64: Buffer.from(probeMatch(camera)).toString('base64'),
        }));
    },
  };
  return network;
}

export function probeMatch(camera) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ' +
    'xmlns:dn="http://www.onvif.org/ver10/network/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">' +
    '<s:Header><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action></s:Header>' +
    '<s:Body><d:ProbeMatches><d:ProbeMatch><wsa:EndpointReference><wsa:Address>urn:uuid:' +
    `${randomBytes(16)
      .toString('hex')
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')}` +
    '</wsa:Address></wsa:EndpointReference><d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types>' +
    `<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/${encodeURIComponent(camera.model)} ` +
    `onvif://www.onvif.org/hardware/${camera.model}</d:Scopes>` +
    `<d:XAddrs>${camera.base}/onvif/device_service http://[fe80::1]/onvif/device_service</d:XAddrs>` +
    '<d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>'
  );
}

/** A real HTTP server around a fake camera (Docker checks). */
export function serveCamera(camera, port) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const answer = await camera.handle({
        method: req.method,
        url: `http://${camera.host}:${camera.port}${req.url}`,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const headers = { ...answer.headers };
      if (answer.authenticate.length > 0) {
        headers['www-authenticate'] = answer.authenticate;
      }
      res.writeHead(answer.status, headers);
      res.end(answer.body);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
