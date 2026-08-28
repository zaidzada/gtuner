// Shared synthetic-signal generator for both test suites.

/** Harmonic amplitude profiles, roughly modelling different pickup/mic positions. */
export const PROFILES = {
  // Bridge pickup: fundamental is *weaker* than the 2nd harmonic. This is the
  // case that breaks FFT peak-picking tuners.
  weakFundamental: [0.10, 1.00, 0.85, 0.60, 0.45, 0.30, 0.20, 0.15],
  bright:          [0.60, 0.90, 0.70, 0.80, 0.50, 0.60, 0.40, 0.30],
  dull:            [1.00, 0.50, 0.15, 0.05, 0.02],
};

/**
 * One window of a decaying plucked note.
 * @param {number} f0        fundamental in Hz
 * @param {number} t0        seconds since the pluck (where in the decay we sample)
 * @param {number[]} amps    harmonic amplitudes
 * @param {number} n         samples
 * @param {number} sampleRate
 * @param {number} noise     additive white noise amplitude
 */
export function pluck(f0, t0, amps, n, sampleRate, noise = 0, rand = Math.random) {
  const buffer = new Float32Array(n);
  const norm = amps.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / sampleRate;
    let v = 0;
    for (let k = 0; k < amps.length; k++) {
      // Slight phase offset per harmonic so we never get a degenerate waveform.
      v += amps[k] * Math.sin(2 * Math.PI * f0 * (k + 1) * t + k * 0.7);
    }
    v *= Math.exp(-1.6 * t);
    if (noise) v += noise * (rand() * 2 - 1);
    buffer[i] = v / norm;
  }
  return buffer;
}

/** Deterministic PRNG so test runs are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Encode Float32 samples as a 16-bit mono PCM WAV. */
export function toWav(samples, sampleRate) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);            // PCM
  bytes.writeUInt16LE(1, 22);            // mono
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    bytes.writeInt16LE(Math.round(clipped * 30000), 44 + i * 2);
  }
  return bytes;
}
