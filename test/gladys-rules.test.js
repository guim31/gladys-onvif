// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// fixtures: the recorded Happytime ONVIF server (PTZ with zoom, two profiles),
// a Hikvision-style fixed camera (motion, intrusion, line, tampering) and a
// Tapo-style pan/tilt camera with every detection — in every feature-name
// language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeCamera, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const cameras = () => [
  new FakeCamera(),
  new FakeCamera({ model: 'hikvision', host: '192.0.2.21', mac: '02-00-5E-10-00-02' }),
  new FakeCamera({ model: 'tapo', host: '192.0.2.22', mac: '02-00-5E-10-00-03' }),
];

const scenarios = [
  { label: 'default configuration (French names)', config: {} },
  { label: 'English names', config: { language: 'en' } },
  { label: 'German names', config: { language: 'de' } },
  { label: 'Spanish names', config: { language: 'es' } },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const { fake, app } = await createWorld({
      cameras: cameras(),
      config: { username: 'admin', password: 'secret', ...scenario.config },
    });
    try {
      const devices = fake.discoveredDevices;
      assert.equal(devices.length, 3, 'one device per camera');

      for (const device of devices) {
        const where = `${device.name} (${device.model})`;

        // should_poll: true if and only if poll_frequency is provided, in ms.
        if (device.poll_frequency === undefined) {
          assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
        } else {
          assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
          assert.ok(
            table.poll_frequencies_ms.includes(device.poll_frequency),
            `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
          );
        }

        assert.ok(device.features.length > 0, `${where}: no feature`);
        const externalIds = new Set();
        const names = new Set();
        for (const feature of device.features) {
          const at = `${where} / ${feature.name}`;
          const pair = table.pairs[`${feature.category}/${feature.type}`];
          assert.ok(
            pair,
            `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
          );
          assert.ok(
            pair.label_en && pair.label_fr && pair.icon,
            `${at}: couple without label or icon`,
          );

          assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
          assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
          assert.ok(
            Number.isFinite(feature.min) && Number.isFinite(feature.max),
            `${at}: finite min/max`,
          );
          assert.ok(feature.min <= feature.max, `${at}: min > max`);
          assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
          assert.equal(
            typeof feature.has_feedback,
            'boolean',
            `${at}: has_feedback must be a boolean`,
          );
          if (feature.unit !== undefined) {
            assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
          }
          for (const option of feature.supported_options ?? []) {
            // The core accepts integer values only on these features.
            assert.ok(Number.isInteger(option.value), `${at}: option value ${option.value}`);
            assert.ok(
              option.value >= feature.min && option.value <= feature.max,
              `${at}: option out of bounds`,
            );
            assert.ok(
              typeof option.label === 'string' && option.label.trim(),
              `${at}: option label`,
            );
          }
          const values = (feature.supported_options ?? []).map((option) => option.value);
          assert.equal(new Set(values).size, values.length, `${at}: duplicate option values`);

          assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
          externalIds.add(feature.external_id);
          assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
          names.add(feature.name);
        }
      }
    } finally {
      await app.stop();
    }
  });
}

test('the PTZ features follow the Gladys PTZ contract', async () => {
  const { fake, app } = await createWorld({ cameras: cameras() });
  try {
    for (const device of fake.discoveredDevices) {
      const move = device.features.find((feature) => feature.type === 'move');
      if (move) {
        assert.deepEqual(
          [move.min, move.max, move.read_only, move.keep_history],
          [0, 6, false, false],
        );
        // STOP (0) is always supported and never listed.
        assert.ok(!move.supported_options.some((option) => option.value === 0));
      }
      // Detections: 1 = detected, like every Gladys sensor of this kind.
      for (const feature of device.features.filter((item) => item.type === 'binary')) {
        assert.deepEqual([feature.min, feature.max, feature.read_only], [0, 1, true]);
      }
    }
  } finally {
    await app.stop();
  }
});
