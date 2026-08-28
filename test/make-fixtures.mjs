// Generates the WAV files that the end-to-end test feeds to Chromium as a
// fake microphone. Run automatically by e2e.mjs; safe to run standalone.
//
//   node test/make-fixtures.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PROFILES, pluck, toWav, mulberry32 } from './signal.mjs';

const SAMPLE_RATE = 48000;
const DURATION = 10;
const PLUCK_EVERY = 1.6;      // seconds between re-plucks

export const FIXTURES = [
  { file: 'e2-flat20.wav',  note: 'E', octave: 2, ref: 82.4069,  detune: -20, profile: 'weakFundamental' },
  { file: 'g3-intune.wav',  note: 'G', octave: 3, ref: 195.9977, detune: 0,   profile: 'bright' },
  { file: 'e4-sharp15.wav', note: 'E', octave: 4, ref: 329.6276, detune: 15,  profile: 'dull' },
  // Realistic microphone level for a guitar with AGC off. This is the case
  // that was broken in the real world while every loud fixture passed.
  { file: 'a2-quiet.wav',   note: 'A', octave: 2, ref: 110.0000, detune: -8,  profile: 'weakFundamental', level: 0.04 },
];

/** A steady stream of re-plucked notes, so there is always a live signal. */
function sustainedPlucks(freq, amps, rand, level = 1) {
  const total = Math.floor(SAMPLE_RATE * DURATION);
  const out = new Float32Array(total);
  const period = Math.floor(SAMPLE_RATE * PLUCK_EVERY);
  for (let i = 0; i < total; i += period) {
    const n = Math.min(period, total - i);
    const chunk = pluck(freq, 0, amps, n, SAMPLE_RATE, 0.003 * level, rand);
    if (level !== 1) for (let j = 0; j < chunk.length; j++) chunk[j] *= level;
    out.set(chunk, i);
  }
  return out;
}

export async function generate() {
  const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
  await mkdir(dir, { recursive: true });
  const rand = mulberry32(1234);
  for (const fixture of FIXTURES) {
    const freq = fixture.ref * Math.pow(2, fixture.detune / 1200);
    const samples = sustainedPlucks(freq, PROFILES[fixture.profile], rand, fixture.level ?? 1);
    await writeFile(dir + fixture.file, toWav(samples, SAMPLE_RATE));
    fixture.freq = freq;
  }
  return { dir, fixtures: FIXTURES };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dir, fixtures } = await generate();
  console.log(`wrote ${fixtures.length} fixtures to ${dir}`);
}
