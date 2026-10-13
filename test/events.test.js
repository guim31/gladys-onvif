import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTopics } from '../src/onvif/camera.js';
import {
  KINDS,
  SENSOR_KINDS,
  classify,
  kindsOfTopics,
  normalizeTopic,
  readState,
  sourceTokens,
} from '../src/onvif/events.js';
import { child, parseXml } from '../src/onvif/xml.js';
import { NOTIFICATIONS } from './helpers/fakeCamera.js';

const items = (list) => list.map(([name, value]) => ({ name, value }));
const detect = (id) => {
  const found = NOTIFICATIONS.find((item) => item.id === id);
  return classify({ topic: found.topic, source: items(found.source), data: items(found.data) });
};

test('the real notifications of each brand give the right detection', () => {
  const expected = {
    'hikvision-motion-alarm': 'motion',
    'cell-motion': 'motion',
    'tapo-line-cross': 'line_crossing',
    'tapo-vehicle': 'vehicle',
    'tapo-pet': 'animal',
    'tapo-person': 'person',
    'tapo-tamper': 'tamper',
    'tapo-intrusion': 'intrusion',
    'reolink-person': 'person',
    'reolink-visitor': 'doorbell',
    'line-detector-crossed': 'line_crossing',
    'field-detector': 'intrusion',
  };
  for (const [id, kind] of Object.entries(expected)) {
    const [detection, ...more] = detect(id);
    assert.equal(more.length, 0, id);
    assert.equal(detection.kind, kind, id);
    assert.equal(detection.state, true, id);
  }
  // The line detector says "crossed" with an object id: a pulse.
  assert.equal(detect('line-detector-crossed')[0].pulse, true);
  assert.equal(detect('tapo-line-cross')[0].pulse, false);
  assert.equal(detect('tapo-person')[0].ruleName, 'MyPeopleDetectorRule');
});

test('events the integration does not follow give nothing', () => {
  for (const id of ['tapo-package', 'hikvision-alarm-in', 'happytime-relay']) {
    assert.deepEqual(detect(id), [], id);
  }
  assert.deepEqual(
    classify({ topic: 'tns1:VideoSource/MotionAlarm', data: items([['State', 'maybe']]) }),
    [],
  );
});

test('two rules of one kind are told apart', () => {
  const zone = (rule) =>
    classify({
      topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
      source: items([['Rule', rule]]),
      data: items([['IsMotion', 'false']]),
    })[0];
  assert.notEqual(zone('A').rule, zone('B').rule);
  assert.equal(zone('A').state, false);
});

test('topics and states are normalized', () => {
  assert.equal(normalizeTopic('tns1:Device/Trigger/tnshik:AlarmIn'), 'Device/Trigger/AlarmIn');
  assert.equal(readState('Active'), true);
  assert.equal(readState('0'), false);
  assert.equal(readState('x'), null);
  assert.deepEqual(
    sourceTokens(
      items([
        ['VideoSourceConfigurationToken', 'vsconf'],
        ['Rule', 'r'],
        ['Source', '000'],
      ]),
    ),
    ['vsconf', '000'],
  );
});

test('the kinds a camera declares come from its topic set', () => {
  const xml = readFileSync(
    new URL('./fixtures/onvif/happytime/GetEventProperties.xml', import.meta.url),
    'utf8',
  );
  const topics = readTopics(child(parseXml(xml), 'Body').children[0]);
  assert.ok(topics.length > 20, 'the Happytime server declares many topics');
  assert.ok(topics.some((topic) => topic.topic === 'RuleEngine/CellMotionDetector/Motion'));
  // MotionAlarm, CellMotionDetector, MotionRegionDetector: all motion.
  assert.deepEqual(kindsOfTopics(topics), ['motion']);
  assert.deepEqual(
    kindsOfTopics([
      { topic: 'RuleEngine/TPSmartEventDetector/TPSmartEvent', items: ['IsVehicle', 'IsPet'] },
    ]),
    ['vehicle', 'animal'],
  );
  assert.ok(SENSOR_KINDS.every((kind) => KINDS.includes(kind)));
});
