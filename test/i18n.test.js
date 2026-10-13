// -----------------------------------------------------------------------------
// Every text Gladys shows exists in the four languages of its interface
// (English, French, German, Spanish): the manifest, the message tables of the
// code, the feature and movement names and the documentation. German says
// "du", never the polite "Sie".
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import { NAMES } from '../src/devices.js';
import { CONNECTION_TEXT, INIT_FAILED, SEARCH_TEXT, searchMessage } from '../src/texts.js';
import { TEXT } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const LANGS = ['en', 'fr', 'de', 'es'];
const POLITE_GERMAN = /(?<!\p{L})(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?!\p{L})/u;

// Upper bounds, in characters: what the Gladys interface shows without cutting.
const MAX = {
  catalog: 100,
  widgetLabel: 30,
  label: 60,
  placeholder: 60,
  description: 300,
  message: 200,
  short: 24,
  featureName: 40,
};

const sorted = (keys) => [...keys].sort();

/** Checks one multi-language object; returns its problems. */
function problems(value, path, max) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} must be a multi-language object`];
  }
  const found = [];
  if (JSON.stringify(sorted(Object.keys(value))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${path} has [${Object.keys(value)}], expected exactly [${LANGS}]`);
  }
  for (const [lang, text] of Object.entries(value)) {
    found.push(...textProblems(text, `${path}.${lang}`, lang, max));
  }
  return found;
}

function textProblems(text, path, lang, max) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [`${path} is empty`];
  }
  const found = [];
  if (text.length > max) {
    found.push(`${path} has ${text.length} characters (${max} at most)`);
  }
  if (lang === 'de' && POLITE_GERMAN.test(text)) {
    found.push(`${path} uses the polite form: "${text}"`);
  }
  return found;
}

/** Every multi-language object of the manifest, with its length limit. */
function manifestTexts(root) {
  const texts = [];
  const walk = (value, path, key) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, key));
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const isText =
      ['label', 'description', 'placeholder'].includes(key) ||
      Object.keys(value).some((child) => LANGS.includes(child));
    if (isText) {
      // The store schema caps the catalog and widget descriptions, and widget labels.
      const max =
        path === 'manifest.description' || /^manifest\.widgets\[\d+\]\.description$/.test(path)
          ? MAX.catalog
          : /^manifest\.widgets\[\d+\]\.label$/.test(path)
            ? MAX.widgetLabel
            : (MAX[key] ?? MAX.label);
      texts.push({ path, value, max });
      return;
    }
    for (const [child, item] of Object.entries(value)) {
      walk(item, `${path}.${child}`, child);
    }
  };
  walk(root, 'manifest', null);
  return texts;
}

test('the configuration offers the four languages', () => {
  assert.deepEqual(LANGUAGES, LANGS);
  assert.deepEqual(Object.keys(NAMES), LANGS);
});

test('every text of the manifest is in English, French, German and Spanish', () => {
  const texts = manifestTexts(manifest);
  assert.ok(texts.length >= 80, `only ${texts.length} texts found in the manifest`);
  const found = texts.flatMap(({ path, value, max }) => problems(value, path, max));
  assert.deepEqual(found, []);
});

test('the catalog description holds 10 characters at least in every language', () => {
  for (const lang of LANGS) {
    assert.ok(manifest.description[lang].length >= 10, `description.${lang} is too short`);
  }
});

test('every message table of the code has the four languages', () => {
  const longMessages = new Set(['pick', 'unknown']);
  const mediumMessages = new Set(['presetReached']);
  const found = [
    ...problems(INIT_FAILED, 'INIT_FAILED', MAX.message),
    ...Object.entries(CONNECTION_TEXT).flatMap(([key, value]) =>
      problems(value, `CONNECTION_TEXT.${key}`, MAX.message),
    ),
    ...Object.entries(TEXT).flatMap(([key, value]) =>
      problems(
        value,
        `TEXT.${key}`,
        longMessages.has(key) ? MAX.message : mediumMessages.has(key) ? MAX.label : MAX.short,
      ),
    ),
  ];
  assert.deepEqual(found, []);
});

// Tables written one language at a time: same keys everywhere, no empty text.
function tableProblems(table, name, max, render = (value) => value) {
  const found = [];
  if (JSON.stringify(sorted(Object.keys(table))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${name} has [${Object.keys(table)}], expected exactly [${LANGS}]`);
  }
  for (const lang of LANGS) {
    const entries = table[lang] ?? {};
    if (
      JSON.stringify(sorted(Object.keys(entries))) !== JSON.stringify(sorted(Object.keys(table.en)))
    ) {
      found.push(`${name}.${lang} does not have the keys of ${name}.en`);
    }
    for (const [key, value] of Object.entries(entries)) {
      found.push(...textProblems(render(value), `${name}.${lang}.${key}`, lang, max));
    }
  }
  return found;
}

test('the feature and device names exist in every language', () => {
  assert.deepEqual(tableProblems(NAMES, 'NAMES', MAX.featureName), []);
});

test('the search report exists in every language', () => {
  const render = (value) => (typeof value === 'function' ? value(12, 11) : value);
  assert.deepEqual(tableProblems(SEARCH_TEXT, 'SEARCH_TEXT', MAX.message, render), []);

  const report = searchMessage({
    cameras: [
      {
        name: 'HIKVISION DS-2CD2085FWD-I',
        host: '192.0.2.10',
        reachable: true,
        ptz: false,
        presets: 0,
        events: true,
      },
      {
        name: 'tp-link C200',
        host: '192.0.2.11',
        reachable: true,
        authError: true,
        ptz: true,
        presets: 2,
        events: true,
      },
      {
        name: 'Axis M1065',
        host: '192.0.2.12',
        reachable: false,
        ptz: false,
        presets: 0,
        events: false,
      },
    ],
    failures: [
      { host: '192.0.2.20', port: 80, reason: 'auth' },
      { host: '192.0.2.21', port: 2020, reason: 'error' },
      { host: '192.0.2.22', port: 80, reason: 'unreachable' },
    ],
    scan: 'unavailable',
    invalidHosts: ['300.1.1.1'],
  });
  assert.deepEqual(problems(report, 'searchMessage', 1200), []);
  assert.match(report.de, /3 Kamera\(s\), davon 2 erreichbar:/);
  assert.match(report.de, /Konto abgelehnt von 192\.0\.2\.20/);
  assert.match(report.fr, /192\.0\.2\.21:2020/);
  assert.match(report.es, /introduzca las direcciones/);
});

test('the guard catches a missing language, an empty text and the polite German form', () => {
  assert.equal(problems({ en: 'Light', fr: 'Éclairage', de: 'Licht' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'Light', fr: 'Éclairage', de: '', es: 'Luz' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a', es: 'a', it: 'a' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a'.repeat(61), es: 'a' }, 'x', 60).length, 1);
  for (const polite of ['Wählen Sie', 'Ihr Gerät', 'Ihre IP', 'mit Ihrem', 'Ihren', 'Ihrer']) {
    assert.equal(problems({ en: 'a', fr: 'a', de: polite, es: 'a' }, 'x', 60).length, 1, polite);
  }
  assert.deepEqual(
    problems({ en: 'a', fr: 'a', de: 'Siebenschläfer, ihre', es: 'a' }, 'x', 60),
    [],
  );
  // A manifest text forgotten in German is found.
  const forgotten = structuredClone(manifest);
  delete forgotten.scene_actions[1].fields[2].label.de;
  const found = manifestTexts(forgotten).flatMap(({ path, value, max }) =>
    problems(value, path, max),
  );
  assert.deepEqual(found, [
    'manifest.scene_actions[1].fields[2].label has [en,fr,es], expected exactly [en,fr,de,es]',
  ]);
});

// --- Documentation -------------------------------------------------------------

const docs = Object.fromEntries(
  await Promise.all(
    LANGS.map(async (lang) => [
      lang,
      await readFile(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8'),
    ]),
  ),
);

const headings = (markdown) =>
  markdown
    .split('\n')
    .filter((line) => /^#{1,3} /.test(line))
    .map((line) => line.match(/^#+/)[0].length);

test('the four documentation files exist, with the same sections', () => {
  for (const lang of LANGS) {
    assert.ok(docs[lang].length >= 300, `docs/${lang}.md is too short for the store`);
    assert.deepEqual(headings(docs[lang]), headings(docs.en), `docs/${lang}.md sections`);
  }
  assert.ok(headings(docs.en).length >= 8);
});

test('the documentation names every feature, trigger, action and widget setting', () => {
  const features = [
    'image',
    'move',
    'preset',
    'motion',
    'person',
    'vehicle',
    'animal',
    'line_crossing',
    'intrusion',
    'tamper',
  ];
  const moves = ['panLeft', 'panRight', 'tiltUp', 'tiltDown', 'zoomIn', 'zoomOut'];
  const [widget] = manifest.widgets;
  for (const lang of LANGS) {
    const doc = docs[lang].replace(/\s+/g, ' ');
    const has = (text, what) => assert.ok(doc.includes(text), `docs/${lang}.md: ${what} "${text}"`);
    for (const item of [
      ...manifest.scene_triggers,
      ...manifest.scene_actions,
      ...manifest.actions,
      widget,
    ]) {
      has(item.label[lang], 'label');
    }
    for (const key of [...features, ...moves]) {
      has(NAMES[lang][key], 'name');
    }
    for (const option of manifest.scene_triggers[0].fields[1].options) {
      has(option.label[lang], 'detection');
    }
    for (const field of manifest.config_schema.filter((item) => item.type !== 'section')) {
      if (!/_[23]$/.test(field.key)) {
        has(field.label[lang], 'setting');
      }
    }
    for (const field of widget.settings) {
      has(field.label[lang], 'widget setting');
    }
    for (const option of widget.settings[1].options) {
      has(option.label[lang], 'widget buttons');
    }
  }
});

test('the German documentation says "du"', () => {
  const polite = docs.de
    .split('\n')
    .filter((line) => !line.startsWith('`') && POLITE_GERMAN.test(line));
  assert.deepEqual(polite, []);
});

test('the documentation says it was developed without the hardware', () => {
  assert.match(docs.en, /Developed without the hardware: feedback welcome/);
  for (const lang of LANGS) {
    assert.match(docs[lang], /github\.com\/guim31\/gladys-onvif\/issues/);
  }
});
