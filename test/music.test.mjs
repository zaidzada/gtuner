// Note maths, tuning tables, and the string-matching hysteresis.
//
//   node test/music.test.mjs

import { strict as assert } from 'node:assert';
import {
  TUNINGS, noteToFreq, noteToMidi, cents, buildTargets, matchString, median,
} from '../src/music.js';

let run = 0;
const failures = [];
function test(name, fn) {
  run++;
  try { fn(); } catch (err) { failures.push(`${name}: ${err.message}`); }
}

test('A4 is the reference', () => {
  assert.equal(noteToMidi('A4'), 69);
  assert.equal(noteToFreq('A4', 440), 440);
  assert.equal(noteToFreq('A4', 432), 432);
});

test('standard tuning frequencies match published values', () => {
  const expected = { E2: 82.41, A2: 110.00, D3: 146.83, G3: 196.00, B3: 246.94, E4: 329.63 };
  for (const [note, freq] of Object.entries(expected)) {
    assert.ok(Math.abs(noteToFreq(note, 440) - freq) < 0.01, `${note} -> ${noteToFreq(note, 440)}`);
  }
});

test('enharmonic spellings agree', () => {
  assert.ok(Math.abs(noteToFreq('D#2') - noteToFreq('Eb2')) < 1e-9);
});

test('A4 calibration shifts everything proportionally', () => {
  const at440 = buildTargets('standard', 440);
  const at444 = buildTargets('standard', 444);
  for (let i = 0; i < at440.length; i++) {
    assert.ok(Math.abs(cents(at444[i].freq, at440[i].freq) - cents(444, 440)) < 1e-6);
  }
});

test('every shipped tuning has six parseable strings in ascending pitch', () => {
  for (const [key, tuning] of Object.entries(TUNINGS)) {
    assert.equal(tuning.notes.length, 6, `${key} string count`);
    const targets = buildTargets(key, 440);
    for (let i = 1; i < targets.length; i++) {
      assert.ok(targets[i].freq > targets[i - 1].freq,
        `${key}: ${targets[i].note} should be above ${targets[i - 1].note}`);
    }
  }
});

test('cents is signed and symmetric', () => {
  assert.ok(Math.abs(cents(440 * Math.pow(2, 1 / 12), 440) - 100) < 1e-9);
  assert.ok(cents(430, 440) < 0);
  assert.ok(cents(450, 440) > 0);
});

const standard = buildTargets('standard', 440);

test('picks the nearest string with no prior state', () => {
  assert.equal(matchString(82.4, standard, null).note, 'E2');
  assert.equal(matchString(196.0, standard, null).note, 'G3');
  assert.equal(matchString(330.0, standard, null).note, 'E4');
});

test('a badly flat string still resolves to that string', () => {
  // E4 tuned a whole tone flat is 293.7 Hz. D4 is not in standard tuning, and
  // the nearest standard target is still E4, so tuning it up should work.
  assert.equal(matchString(293.7, standard, null).note, 'E4');
});

test('hysteresis holds the current string near a midpoint', () => {
  const held = standard.find((t) => t.note === 'A2');
  // Drifting up from A2 toward D3: the midpoint is ~127 Hz. Just past it the
  // naive answer flips to D3, but we should still be holding A2.
  const nearMidpoint = 128;
  assert.equal(matchString(nearMidpoint, standard, null).note, 'D3', 'no-hold baseline');
  assert.equal(matchString(nearMidpoint, standard, held).note, 'A2', 'should hold A2');
});

test('hysteresis releases once another string is clearly closer', () => {
  const held = standard.find((t) => t.note === 'A2');
  assert.equal(matchString(144, standard, held).note, 'D3');
});

test('median rejects a single wild outlier', () => {
  assert.equal(median([110, 110.1, 220, 110.2, 109.9]), 110.1);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  ' + f);
}
console.log(`assertions: ${run - failures.length}/${run} passed`);
process.exit(failures.length ? 1 : 0);
