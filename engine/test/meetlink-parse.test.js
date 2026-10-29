import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEvt, parsePpl, parseSch, findHeat } from '../meetlink/parse.js';
import { parseFields, decodeMeetText } from '../meetlink/text.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

test('FinishLynx manual example: headers, competitors, status line, comment, lane 0', () => {
  const heats = parseEvt(fixture('manual.evt'));
  assert.equal(heats.length, 3);
  const [h100, h200, h10k] = heats;

  assert.deepEqual(
    { event: h100.event, round: h100.round, heat: h100.heat, name: h100.name },
    { event: '999', round: 1, heat: 1, name: "Men's 100 Meter" },
  );
  assert.equal(h100.wind, null);
  assert.equal(h100.windUnit, null);
  assert.equal(h100.distance, null);
  assert.equal(h100.startTime, null);
  assert.deepEqual(h100.raw, ['999', '1', '1', "Men's 100 Meter"]);
  assert.deepEqual(
    h100.entries.map(({ raw, ...e }) => e),
    [
      { id: '23', lane: 1, last: '', first: '', affiliation: '', status: null },
      { id: '22', lane: 2, last: 'Jones', first: 'Bob', affiliation: '', status: 'DNS' },
      { id: '67', lane: 3, last: 'Mouse', first: 'Michael', affiliation: 'Florida State', status: null },
    ],
  );

  // Header-only event; the comment line between events is ignored.
  assert.equal(h200.event, '998');
  assert.equal(h200.name, "Men's 200 Meter");
  assert.deepEqual(h200.entries, []);

  // Lane 0 means no lane.
  assert.equal(h10k.name, "Women's 10000 Meter");
  assert.equal(h10k.entries.length, 1);
  assert.equal(h10k.entries[0].id, '15');
  assert.equal(h10k.entries[0].lane, null);
});

test('manual example parses the same with CRLF, LF, bare CR and a BOM', () => {
  const lf = readFileSync(new URL('./fixtures/manual.evt', import.meta.url), 'latin1');
  const base = parseEvt(lf);
  assert.deepEqual(parseEvt(lf.replaceAll('\n', '\r\n')), base);
  assert.deepEqual(parseEvt(lf.replaceAll('\n', '\r')), base);
  assert.deepEqual(parseEvt('﻿' + lf), base);
  const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lf, 'utf8')]);
  assert.deepEqual(parseEvt(bomBytes), base);
});

test('windows-1252 bytes, quoted fields, escaped quotes, tab/space competitor lines, alphanumeric event', () => {
  const heats = parseEvt(fixture('meet-cp1252.evt'));
  assert.deepEqual(heats.map((h) => [h.event, h.round, h.heat]), [['3', 1, 2], ['18B', 2, 1], ['1', 1, 1]]);
  const [h, relay, h1] = heats;

  assert.equal(h.name, 'Women’s 100m Hurdles, Final');
  assert.equal(h.wind, 1.2);
  assert.equal(h.windUnit, 'm/s');
  assert.equal(h.distance, 100);
  assert.equal(h.startTime, '15:30:00.00');
  assert.equal(h.raw.length, 13);

  const byId = Object.fromEntries(h.entries.map((e) => [e.id, e]));
  assert.equal(byId['101'].last, 'Renée');
  assert.equal(byId['101'].first, 'Zoë');
  assert.equal(byId['101'].affiliation, 'St. Mary’s, "Gaels"');
  assert.equal(byId['101'].lane, 4);
  assert.equal(byId['101'].raw[5], 'LIC1');
  assert.equal(byId['102'].last, 'O’Brien');
  assert.equal(byId['102'].affiliation, 'Lake – Shore');
  assert.equal(byId['102'].lane, 5);
  assert.equal(byId['103'].lane, 6);
  assert.equal(byId['105'].lane, 8, 'tab-started line without a leading comma');
  assert.equal(byId['104'].status, 'DNF');
  assert.equal(byId['104'].lane, 7);

  assert.equal(relay.event, '18B');
  assert.deepEqual(relay.entries, []);

  assert.equal(h1.distance, 100);
  assert.equal(h1.entries[0].lane, null, 'blank lane');
  assert.equal(h1.entries[1].id, null, 'ID 0 means no ID');
  assert.equal(h1.entries[1].lane, 3);

  assert.equal(findHeat(heats, { event: '18B', round: 2, heat: 1 }), relay);
  assert.equal(findHeat(heats, { event: 3, round: 1, heat: 2 }), h);
  assert.equal(findHeat(heats, { event: '3', round: 1, heat: 9 }), undefined);
});

test('events in any order; competitor lines attach to the nearest header above', () => {
  const heats = parseEvt('5,1,2,B\n,1,1\n2,1,1,A\n,2,2\n5,1,1,C\n,3,3\n');
  assert.deepEqual(heats.map((h) => `${h.event}/${h.heat}:${h.entries.map((e) => e.id)}`), ['5/2:1', '2/1:2', '5/1:3']);
});

test('competitor lines before any header are ignored; bad round throws', () => {
  assert.deepEqual(parseEvt(',1,1\n\\DNS,2,2\n'), []);
  assert.throws(() => parseEvt('7,x,1,Bad'), /round "x" is not an integer/);
  assert.throws(() => parseEvt('7,1,1,Ok\n\\,5,5'), /status line without a code/);
});

test('status codes are upper-cased', () => {
  const [h] = parseEvt('1,1,1,X\n\\dq,9,4,A,B\n');
  assert.equal(h.entries[0].status, 'DQ');
});

test('parseFields: quoting rules', () => {
  assert.deepEqual(parseFields('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseFields(' a , b ,c '), ['a', 'b', 'c']);
  assert.deepEqual(parseFields('"a,b",c'), ['a,b', 'c']);
  assert.deepEqual(parseFields('"say ""hi""",x'), ['say "hi"', 'x']);
  assert.deepEqual(parseFields('"",x,'), ['', 'x', '']);
  assert.deepEqual(parseFields('a,,b'), ['a', '', 'b']);
  assert.deepEqual(parseFields('O"Brien,x'), ['O"Brien', 'x']);
  assert.deepEqual(parseFields('"unterminated, still'), ['unterminated, still']);
  assert.deepEqual(parseFields(''), ['']);
});

test('decodeMeetText maps 0x80-0x9F through windows-1252', () => {
  assert.equal(decodeMeetText(Uint8Array.of(0x80, 0x93, 0x94, 0x96, 0xe9)), '€“”–é');
});

test('parsePpl', () => {
  const people = parsePpl(fixture('lynx-cp1252.ppl'));
  assert.deepEqual(people, [
    { id: '101', last: 'Renée', first: 'Zoë', affiliation: 'St. Mary’s, "Gaels"', license: 'LIC1', user1: 'u1', user2: 'u2', user3: 'u3' },
    { id: '102', last: 'O’Brien', first: 'Kate', affiliation: 'Lake – Shore', license: '', user1: '', user2: '', user3: '' },
    { id: null, last: 'Nobody', first: 'Here', affiliation: '', license: '', user1: '', user2: '', user3: '' },
  ]);
});

test('parseSch: missing round or heat defaults to 1, order kept', () => {
  assert.deepEqual(parseSch(fixture('lynx.sch')), [
    { event: '3', round: 1, heat: 2 },
    { event: '18B', round: 2, heat: 1 },
    { event: '1', round: 1, heat: 1 },
    { event: '999', round: 1, heat: 1 },
  ]);
  assert.deepEqual(parseSch('4,,3\n'), [{ event: '4', round: 1, heat: 3 }]);
  assert.deepEqual(parseSch(''), []);
});
