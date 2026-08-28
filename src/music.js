// Note names, tunings, and the logic that decides which string you're playing.

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A#2" | "Eb3" | "E4"  ->  MIDI note number (A4 = 69). */
export function noteToMidi(name) {
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) throw new Error(`bad note name: ${name}`);
  const [, letter, accidental, octave] = m;
  const alter = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  return 12 * (Number(octave) + 1) + SEMITONES[letter] + alter;
}

export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function noteToFreq(name, a4 = 440) {
  return midiToFreq(noteToMidi(name), a4);
}

/** Signed distance in cents. Positive = sharp. */
export function cents(freq, target) {
  return 1200 * Math.log2(freq / target);
}

export const TUNINGS = {
  standard:  { label: 'Standard',        notes: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  dropD:     { label: 'Drop D',          notes: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  halfStep:  { label: 'Half step down',  notes: ['D#2', 'G#2', 'C#3', 'F#3', 'A#3', 'D#4'] },
  wholeStep: { label: 'Whole step down', notes: ['D2', 'G2', 'C3', 'F3', 'A3', 'D4'] },
  openD:     { label: 'Open D',          notes: ['D2', 'A2', 'D3', 'F#3', 'A3', 'D4'] },
  openG:     { label: 'Open G',          notes: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'] },
  dadgad:    { label: 'DADGAD',          notes: ['D2', 'A2', 'D3', 'G3', 'A3', 'D4'] },
};

/** Build the target list for a tuning at a given A4 reference. */
export function buildTargets(tuningKey, a4 = 440) {
  return TUNINGS[tuningKey].notes.map((note, i) => ({
    index: i,                       // 0 = lowest (6th string)
    note,
    label: note.replace(/-?\d+$/, ''),
    octave: Number(/-?\d+$/.exec(note)[0]),
    freq: noteToFreq(note, a4),
  }));
}

/**
 * Pick which string a frequency belongs to.
 *
 * Naive nearest-target matching flickers badly when you sit near the midpoint
 * between two strings, which is exactly where you are while tuning a badly
 * flat string. So once a string is chosen we keep it until some other target
 * is closer by more than `hysteresis` cents.
 */
export function matchString(freq, targets, held = null, hysteresis = 40) {
  let best = null;
  let bestAbs = Infinity;
  for (const t of targets) {
    const abs = Math.abs(cents(freq, t.freq));
    if (abs < bestAbs) { bestAbs = abs; best = t; }
  }
  if (held === null) return best;

  const heldTarget = targets[held.index];
  if (!heldTarget) return best;
  const heldAbs = Math.abs(cents(freq, heldTarget.freq));
  return bestAbs < heldAbs - hysteresis ? best : heldTarget;
}

/** Median of a small array. Cheap outlier rejection for the frequency stream. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
