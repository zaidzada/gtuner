// Drives the WASM detector directly against synthetic guitar signals.
//
//   node test/detector.test.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PROFILES, pluck, mulberry32 } from './signal.mjs';

const FRAME = 4096;
const SAMPLE_RATES = [44100, 48000];
const TOLERANCE_CENTS = 1.0;

// Every distinct note across every tuning we ship.
const NOTES = {
  'D2': 73.4162, 'E2': 82.4069, 'G2': 97.9989, 'G#2': 103.8262, 'A2': 110.0000,
  'D#2': 77.7817, 'C3': 130.8128, 'C#3': 138.5913, 'D3': 146.8324, 'F3': 174.6141,
  'F#3': 184.9972, 'G3': 195.9977, 'A3': 220.0000, 'A#3': 233.0819, 'B3': 246.9417,
  'D4': 293.6648, 'D#4': 311.1270, 'E4': 329.6276,
};

const wasmPath = fileURLToPath(new URL('../wasm/yin.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {});
const wasm = instance.exports;
const input = new Float32Array(wasm.memory.buffer, wasm.input_ptr(), wasm.frame_size());
const output = new Float32Array(wasm.memory.buffer, wasm.output_ptr(), 4);

const cents = (freq, ref) => 1200 * Math.log2(freq / ref);
const rand = mulberry32(0x9e3779b9);

let run = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  run++;
  if (!condition) { failed++; failures.push(`${label}  ${detail}`); }
}

// --- accuracy across strings, timbres, detunings, decay, sample rates -------

for (const sampleRate of SAMPLE_RATES) {
  for (const [name, ref] of Object.entries(NOTES)) {
    for (const [profileName, amps] of Object.entries(PROFILES)) {
      for (const detune of [-50, -23, -7, 0, 11, 34, 49]) {
        for (const t0 of [0.02, 0.55, 1.10]) {
          const freq = ref * Math.pow(2, detune / 1200);
          input.set(pluck(freq, t0, amps, FRAME, sampleRate, 0.004, rand));
          const found = wasm.detect(FRAME, sampleRate, 0.15, 0);
          const error = found ? cents(output[0], freq) : NaN;
          check(
            `${name.padEnd(4)} ${profileName.padEnd(15)} ${String(detune).padStart(3)}¢ t=${t0} @${sampleRate}`,
            found === 1 && Math.abs(error) <= TOLERANCE_CENTS,
            found ? `err ${error.toFixed(3)}¢ (got ${output[0].toFixed(3)} want ${freq.toFixed(3)})`
                  : 'no detection',
          );
        }
      }
    }
  }
}

// --- quiet signals ----------------------------------------------------------
//
// Regression: the detector originally carried a hardcoded RMS gate of 0.005
// (-46 dBFS), which is loud. Every test signal above is normalized to full
// scale, so the gate was never exercised — but a real guitar into a laptop mic
// with automatic gain control disabled sits well below it, and notes were
// silently dropped a fraction of a second after the attack. Loudness must not
// gate detection; periodicity is what decides.

for (const [label, level] of [['-26 dBFS', 0.05], ['-36 dBFS', 0.015], ['-46 dBFS', 0.005], ['-56 dBFS', 0.0015]]) {
  for (const [name, ref] of [['E2', 82.4069], ['G3', 195.9977], ['E4', 329.6276]]) {
    const quiet = pluck(ref, 0.4, PROFILES.weakFundamental, FRAME, 44100, 0.00002, rand);
    for (let i = 0; i < FRAME; i++) quiet[i] *= level;
    input.set(quiet);
    const found = wasm.detect(FRAME, 44100, 0.15, 0);
    const error = found ? cents(output[0], ref) : NaN;
    check(
      `quiet ${label.padEnd(9)} ${name}`,
      found === 1 && Math.abs(error) <= TOLERANCE_CENTS,
      found ? `err ${error.toFixed(3)}¢` : `not detected (rms ${output[2].toExponential(2)})`,
    );
  }
}

// --- rejection --------------------------------------------------------------

input.fill(0);
check('silence', wasm.detect(FRAME, 44100, 0.15, 0) === 0, 'reported a pitch');

// Noise must be rejected at every amplitude, not just loud noise — otherwise
// lowering the level gate would trade dropped notes for phantom ones.
for (const amp of [0.5, 0.2, 0.05, 0.01, 0.002, 0.0005]) {
  for (let i = 0; i < FRAME; i++) input[i] = (rand() * 2 - 1) * amp;
  check(`white noise @${amp}`, wasm.detect(FRAME, 44100, 0.15, 0) === 0,
    `reported ${output[0].toFixed(1)} Hz, clarity ${output[1].toFixed(3)}`);
}

// rms must be reported even when no pitch is found, so the level meter works.
for (let i = 0; i < FRAME; i++) input[i] = (rand() * 2 - 1) * 0.02;
wasm.detect(FRAME, 44100, 0.15, 0);
check('rms reported without a pitch', output[2] > 0.005 && output[2] < 0.02,
  `rms ${output[2].toFixed(5)}`);

// --- clarity is meaningful on a real tone -----------------------------------

input.set(pluck(110, 0.05, PROFILES.bright, FRAME, 44100, 0.004, rand));
wasm.detect(FRAME, 44100, 0.15, 0);
check('clarity on clean tone', output[1] > 0.9, `clarity ${output[1].toFixed(3)}`);

// --- benchmark --------------------------------------------------------------

input.set(pluck(82.4069, 0.05, PROFILES.weakFundamental, FRAME, 44100, 0.004, rand));
const iterations = 400;
const started = process.hrtime.bigint();
for (let i = 0; i < iterations; i++) wasm.detect(FRAME, 44100, 0.15, 0);
const msPerFrame = Number(process.hrtime.bigint() - started) / 1e6 / iterations;
const hopMs = (1024 / 44100) * 1000;

// --- report -----------------------------------------------------------------

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  ' + f);
  if (failures.length > 25) console.log(`  … and ${failures.length - 25} more`);
}
console.log(`
detect():   ${msPerFrame.toFixed(3)} ms per ${FRAME}-sample window
duty cycle: ${((msPerFrame / hopMs) * 100).toFixed(1)}% of one thread at ${(1000 / hopMs).toFixed(0)} updates/sec
assertions: ${run - failed}/${run} passed (tolerance ${TOLERANCE_CENTS}¢)`);

process.exit(failed ? 1 : 0);
