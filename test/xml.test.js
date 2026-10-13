import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  XmlError,
  child,
  children,
  decodeEntities,
  escapeXml,
  find,
  findAll,
  parseXml,
  path,
  serialize,
  textOf,
} from '../src/onvif/xml.js';

test('elements are read by local name, with their namespace', () => {
  const root = parseXml(
    '<?xml version="1.0"?><!-- c --><s:Envelope xmlns:s="urn:s" xmlns="urn:d">' +
      '<s:Body><a x="1&amp;2" t:y="3" xmlns:t="urn:t">t &lt; u<![CDATA[<z>]]> &#233;&#x41;</a>' +
      '<b:c xmlns:b="urn:b"/></s:Body></s:Envelope>',
  );
  assert.equal(root.name, 'Envelope');
  assert.equal(root.ns, 'urn:s');
  const a = path(root, 'Body', 'a');
  assert.equal(a.ns, 'urn:d');
  assert.deepEqual(a.attrs, { x: '1&2', y: '3' });
  assert.equal(a.text, 't < u<z> éA');
  assert.equal(find(root, 'c').ns, 'urn:b');
  assert.equal(textOf(child(root, 'Body'), 'a'), 't < u<z> éA');
  assert.equal(textOf(null, 'a'), '');
  assert.deepEqual(children(null, 'a'), []);
  assert.equal(findAll(root, 'c').length, 1);
});

test('malformed documents and document types are refused', () => {
  for (const bad of [
    '',
    '<a>',
    '<a></b>',
    '<a x=1></a>',
    '<a><b></a>',
    '<a/><b/>',
    '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>',
    '<a><!-- open</a>',
    '<a><![CDATA[x</a>',
  ]) {
    assert.throws(() => parseXml(bad), XmlError, bad);
  }
});

test('escape and decode are inverse; unknown entities stay', () => {
  const text = `<a href="x" & 'y'>`;
  assert.equal(decodeEntities(escapeXml(text)), text);
  assert.equal(decodeEntities('&nbsp;&#0;'), '&nbsp;&#0;');
});

test('an element is written back with its namespaces (reference parameters)', () => {
  const root = parseXml(
    '<r xmlns:w="urn:w"><w:Ref><t:Id xmlns:t="urn:t" a="1">4&amp;2</t:Id></w:Ref></r>',
  );
  const xml = serialize(child(root, 'Ref'));
  assert.equal(xml, '<w:Ref xmlns:w="urn:w"><t:Id xmlns:t="urn:t" a="1">4&amp;2</t:Id></w:Ref>');
  assert.equal(textOf(child(parseXml(xml), 'Id')), '4&2');
});

test('every recorded answer of the Happytime server parses', () => {
  const dir = new URL('./fixtures/onvif/happytime/', import.meta.url);
  for (const name of ['GetProfiles', 'GetEventProperties', 'GetNodes', 'PullMessages']) {
    const root = parseXml(readFileSync(new URL(`${name}.xml`, dir), 'utf8'));
    assert.equal(child(root, 'Body').children[0].name, `${name}Response`);
  }
});
