// -----------------------------------------------------------------------------
// What an ONVIF event means: the topics and data items cameras use, mapped to
// a short list of detection kinds. The mapping follows onvif-parsers (Apache
// 2.0), the event parsers of Home Assistant's ONVIF integration, whose tests
// hold real notifications of Hikvision, Dahua, Reolink and TP-Link Tapo
// cameras.
//
// Topics are compared without their namespace prefixes:
// `tns1:RuleEngine/CellMotionDetector/Motion` and
// `RuleEngine/CellMotionDetector/Motion` are the same topic.
// -----------------------------------------------------------------------------

/** Every kind, in the order of the lists shown to the user. */
export const KINDS = [
  'motion',
  'person',
  'vehicle',
  'animal',
  'line_crossing',
  'intrusion',
  'tamper',
  'sound',
  'doorbell',
];

/** The kinds that become a sensor of the camera device (the others: trigger only). */
export const SENSOR_KINDS = [
  'motion',
  'person',
  'vehicle',
  'animal',
  'line_crossing',
  'intrusion',
  'tamper',
];

// Kinds whose notification says "it happened" with no end: the sensor goes
// back to 0 on its own after a few seconds.
export const PULSE_MS = 5000;

// Topic → kind and the data item holding the state. `pulse`: the item is not
// a state (an object id, a count).
const TOPICS = {
  'VideoSource/MotionAlarm': { kind: 'motion', item: 'State' },
  'RuleEngine/CellMotionDetector/Motion': { kind: 'motion', item: 'IsMotion' },
  'RuleEngine/MotionRegionDetector/Motion': { kind: 'motion', item: 'State' },
  'RuleEngine/MyRuleDetector/PeopleDetect': { kind: 'person', item: 'State' },
  'RuleEngine/MyRuleDetector/FaceDetect': { kind: 'person', item: 'State' },
  'RuleEngine/MyRuleDetector/VehicleDetect': { kind: 'vehicle', item: 'State' },
  'RuleEngine/MyRuleDetector/DogCatDetect': { kind: 'animal', item: 'State' },
  'RuleEngine/MyRuleDetector/Visitor': { kind: 'doorbell', item: 'State' },
  'UserAlarm/IVA/HumanShapeDetect': { kind: 'person', item: null },
  'RuleEngine/FieldDetector/ObjectsInside': { kind: 'intrusion', item: 'IsInside' },
  'RuleEngine/LineDetector/Crossed': { kind: 'line_crossing', item: null, pulse: true },
  'RuleEngine/TamperDetector/Tamper': { kind: 'tamper', item: 'IsTamper' },
  'AudioAnalytics/Audio/DetectedSound': { kind: 'sound', item: 'IsSoundDetected' },
};

// Data item names that say the kind by themselves (TP-Link Tapo and VIGI put
// several detections under one topic, others reuse these names).
const ITEMS = {
  IsMotion: 'motion',
  IsPeople: 'person',
  IsPerson: 'person',
  IsHuman: 'person',
  IsVehicle: 'vehicle',
  IsCar: 'vehicle',
  IsPet: 'animal',
  IsAnimal: 'animal',
  IsLineCross: 'line_crossing',
  IsIntrusion: 'intrusion',
  IsInside: 'intrusion',
  IsTamper: 'tamper',
  IsSoundDetected: 'sound',
};

// Source items naming the video source (or its configuration) of an event.
const SOURCE_ITEMS = ['VideoSourceConfigurationToken', 'VideoSourceToken', 'VideoSource', 'Source'];

/** `tns1:RuleEngine/tnshik:X/Y` → `RuleEngine/X/Y`. */
export function normalizeTopic(topic) {
  return String(topic ?? '')
    .trim()
    .split('/')
    .map((segment) => segment.slice(segment.indexOf(':') + 1))
    .join('/');
}

/** A data value read as a state: true, false, or null when it is not one. */
export function readState(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['true', '1', 'active', 'on'].includes(text)) {
    return true;
  }
  if (['false', '0', 'inactive', 'off'].includes(text)) {
    return false;
  }
  return null;
}

/**
 * The detections of one notification (see readNotification in camera.js):
 * `[{ kind, state, pulse, rule }]`. `rule` tells two detectors of the same
 * kind apart (two zones, two lines). An unknown event gives [].
 */
export function classify({ topic, source = [], data = [] }) {
  const name = normalizeTopic(topic);
  const rule = [name, ...source.map((item) => `${item.name}=${item.value}`)].join('|');
  const ruleName = source.find((item) => item.name === 'Rule')?.value ?? '';
  const known = TOPICS[name];
  if (known) {
    if (known.pulse) {
      return [{ kind: known.kind, state: true, pulse: true, rule, ruleName }];
    }
    const item = known.item ? data.find((entry) => entry.name === known.item) : data[0];
    const state = readState((item ?? data[0])?.value);
    return state === null ? [] : [{ kind: known.kind, state, pulse: false, rule, ruleName }];
  }
  const found = [];
  for (const item of data) {
    const kind = ITEMS[item.name];
    const state = readState(item.value);
    if (kind && state !== null) {
      found.push({ kind, state, pulse: false, rule: `${rule}|${item.name}`, ruleName });
    }
  }
  return found;
}

/**
 * The kinds a camera declares in GetEventProperties (readTopics in
 * camera.js). Some cameras declare less than they send: kinds seen later in
 * notifications are added too.
 */
export function kindsOfTopics(topics) {
  const kinds = new Set();
  for (const { topic, items } of topics) {
    const known = TOPICS[normalizeTopic(topic)];
    if (known) {
      kinds.add(known.kind);
    }
    for (const item of items ?? []) {
      if (ITEMS[item]) {
        kinds.add(ITEMS[item]);
      }
    }
  }
  return KINDS.filter((kind) => kinds.has(kind));
}

/** The tokens naming the video source of a notification. */
export function sourceTokens(source = []) {
  return source.filter((item) => SOURCE_ITEMS.includes(item.name)).map((item) => item.value);
}
