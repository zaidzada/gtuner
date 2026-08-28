# Guitar tuner

A static guitar tuner. No dependencies, no build step to deploy, no network
calls — the whole thing is a handful of files plus a 1.8 KB WebAssembly module.

## Run it

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

It has to come over `http://` or `https://`, not `file://` — see
[Deploying](#deploying) for why. Opening the file directly says so rather than
failing cryptically.

## Deploying

It is a static site with no build step and no server code. Commit the folder,
turn on GitHub Pages (or Netlify, Cloudflare Pages, S3, anything), and it
works. The `.wasm` is checked in, so nothing has to be compiled at deploy time.

There are two builds of the same app:

| | What it is | When to use it |
| --- | --- | --- |
| `index.html` + `src/` + `wasm/` | Normal multi-file site | Development, and the default for hosting |
| `tuner.html` | One 30 KB file, nothing else | Dropping a tuner somewhere with no folder structure |

`tuner.html` is generated — edit the files in `src/` and `wasm/`, then:

```sh
node tools/build-single.mjs
```

Both are tested against the same fixtures by `test/e2e.mjs`.

### Why it can't run from `file://`

`AudioWorklet.addModule()` and `new Worker()` take URLs, not source strings.
The single-file build mints those URLs from inline `<script>` blocks with
`URL.createObjectURL`, which works everywhere the page has a real origin. A
page opened from disk has an *opaque* origin, and Chrome refuses to load a
worklet from a blob URL there:

```
AbortError: Unable to load a worklet's module.
```

This has nothing to do with WebAssembly — the WASM inlines fine as base64 and
never gets fetched. A pure-JavaScript tuner would hit exactly the same wall,
because the obstacle is the worklet, not the detector. Any http host at all,
including `python3 -m http.server`, resolves it.

## How it works

```
mic ──> AudioContext ──> AudioWorklet          [audio thread]
                         ring buffer, emits a 4096-sample
                         window every 1024 samples (~23 ms)
                              │ transfer
                              ▼
                         main thread (relay only)
                              │ transfer
                              ▼
                         Worker                 [worker thread]
                         owns the WASM instance, runs detect()
                              │ {freq, clarity, rms}
                              ▼
                         main thread            [UI]
                         median filter → string match → cents → needle
```

Pitch detection is **YIN** (de Cheveigné & Kawahara, 2002), written in
freestanding C and compiled to WebAssembly. The cumulative-mean-normalization
step is what makes it reliable on guitar: a plucked string's fundamental is
often *weaker* than its second harmonic, which is exactly the case where FFT
peak-picking reports the wrong octave.

### Why the detector is in a Worker and not the AudioWorklet

`detect()` takes about **4 ms** per window. An AudioWorklet `process()`
callback has to return within about **2.9 ms** (128 frames at 44.1 kHz).
Average CPU load is only ~18%, but that 4 ms spike lands inside a single 2.9 ms
callback and causes dropouts. So the worklet does nothing but fill a ring
buffer, and the analysis happens on a worker thread where a spike is harmless.

The usual way to move audio between those threads is a `SharedArrayBuffer`,
but that needs COOP/COEP response headers, which static hosts like GitHub
Pages cannot set. Instead windows are passed as **transferables** — zero-copy,
and the buffers are recycled back to the worklet afterwards, so the audio
thread stops allocating entirely once the loop warms up.

## Layout

| Path | What it does |
| --- | --- |
| `index.html` | Markup and all styling |
| `src/app.js` | State, smoothing, rendering |
| `src/audio.js` | `getUserMedia`, graph setup, worklet/worker wiring |
| `src/sources.js` | Where the worklet, worker and WASM come from — the one seam the single-file build swaps |
| `src/capture-processor.js` | AudioWorklet — ring buffer only |
| `src/detector-worker.js` | Worker — hosts the WASM |
| `src/music.js` | Tunings, cents maths, string matching |
| `wasm/yin.c` | The detector |
| `wasm/yin.wasm` | Checked in — rebuild only if you change the C |
| `tools/build-single.mjs` | Inlines everything into `tuner.html` |
| `tuner.html` | Generated single-file build |

## Rebuilding the WASM

Only needed if you edit `wasm/yin.c`.

```sh
./wasm/build.sh
```

Needs `clang` and `wasm-ld` (`apt install clang lld`, or `brew install llvm`).
No Emscripten, no Rust, no wasm-bindgen: clang targets wasm32 directly, the
module imports nothing, and there is no glue code — JS writes floats straight
into linear memory and reads the answer back out.

## Tests

```sh
node test/music.test.mjs      # note maths, tunings, string-matching hysteresis
node test/detector.test.mjs   # WASM vs synthetic signals
node test/e2e.mjs             # headless Chromium with a WAV as fake microphone
```

`detector.test.mjs` drives the WASM directly across every string in every
tuning, three harmonic profiles (including a weak-fundamental one), a spread of
detunings and two points in the decay envelope, and asserts each result is
within one cent.

`e2e.mjs` feeds a generated WAV into a real browser through
`--use-file-for-fake-audio-capture` and asserts on the rendered DOM, so it
exercises the actual worklet → worker → WASM → UI path. It runs every fixture
against *both* builds — they share all their logic but reach their worklet,
worker and WASM by different routes — and checks that the `file://` case fails
with an explanation. Needs Playwright (`npm i playwright`), or set
`CHROME_PATH` to a Chrome binary.

## Input level meter

The thin bar under the strings shows microphone level in **dBFS**, with a tick
marking the point below which detection gets unreliable (-70 dB) and a peak
marker that falls back slowly. The scale is logarithmic because microphone
levels are — a guitar reading 5% of full scale linearly is a perfectly usable
-26 dB, and a linear bar would show it as nearly nothing.

If signal is arriving but nothing is being detected for a couple of seconds,
the page says so rather than just sitting there.

## When capture dies

A Web Audio capture chain can stop for reasons the page never gets told about:
a `MediaStreamAudioSourceNode` that nothing holds a reference to gets garbage
collected mid-run, another application takes the microphone, the OS suspends
the `AudioContext`, a USB interface is unplugged. In every case the graph just
goes quiet — no error, no event — and the screen freezes on its last reading.

Three defences, in order of how much they cost:

1. **Every node is referenced.** `TunerEngine` holds `source`, `node` and
   `mute` as fields. An unreferenced source node being collected out from
   under a running graph is the classic version of this bug.
2. **The context and track are watched.** `onstatechange` resumes a suspended
   or interrupted context; `track.onended` triggers a full re-acquire.
3. **A watchdog.** Windows arrive every ~23 ms, so if none arrives for 1.5 s
   something is wrong whatever the cause. The engine rebuilds the graph — or
   re-runs `getUserMedia` if the track itself is gone — and the page says
   "reconnecting…" rather than looking broken. After six failed recoveries it
   stops and asks you to reload, instead of thrashing forever.

`test/e2e.mjs` verifies this by severing `source -> worklet` on a live page
and asserting the watchdog notices and brings it back.

### Debug panel

Hidden by default. Press **`d`**, tap the level bar, or load with `?debug`.
The choice is remembered between visits.

```
pipeline  43 frames/s · 43 results/s · 1832 total
audio     running · 44.1 kHz · 4096-sample window every 23 ms
signal    -14.6 dBFS · peak -14.2 · clarity 1.000
timing    detect 4.06 ms · round trip 7.5 ms · 18% duty
pitch     195.999 Hz raw · 196.000 Hz median · G3 +0.0 ¢
engine    running · 0 stalls · 0 recoveries · A4 440 · Standard
```

Each line isolates a different stage, so a fault can be placed rather than
guessed at:

| Line | Answers |
| --- | --- |
| `pipeline` | Are windows arriving at all? ~43/s is healthy. **Zero means capture died** even though the page looks fine. If `results/s` trails `frames/s`, the worker is falling behind. |
| `audio` | Is the context actually running, and at what rate? `suspended` or `interrupted` explains a freeze on its own. |
| `signal` | Is sound reaching us (`dBFS`), and is it periodic enough to be a note (`clarity`)? Loud but low clarity means noise, not a string. |
| `timing` | Is detection keeping up? `detect` should sit near 4 ms and duty well under 100%. |
| `pitch` | `raw` is one window's estimate, `median` is after outlier rejection. A raw value jumping around a steady median is normal; both jumping is not. |
| `engine` | Current state, and whether the watchdog has had to step in. |

## Tuning behaviour worth knowing

- **String matching has 40 cents of hysteresis.** Without it the display
  flickers between two strings when you sit near the midpoint — which is
  exactly where you are while tuning a badly flat string.
- **The reading holds for 600 ms** after a note decays, so it doesn't vanish
  mid-peg-turn.
- **Browser voice processing is disabled** at capture (`echoCancellation`,
  `noiseSuppression`, `autoGainControl` all `false`). Those defaults are tuned
  for speech and mangle a sustained tone.
- **Detection floor is 40 Hz**, set by `TAUMAX` in `yin.c`.
- **Loudness does not gate detection.** `yin.c` only skips buffers below
  -80 dBFS, which is digital silence; what rejects a frame is lack of
  periodicity, not lack of volume. This matters because the capture path
  deliberately disables automatic gain control, so a real guitar sits far
  below any "comfortable" threshold. An earlier version gated at -46 dBFS and
  dropped real notes a fraction of a second after each attack — the tests all
  passed because every synthetic signal was normalized to full scale.
  `test/detector.test.mjs` now covers levels down to -56 dBFS, and
  `test/fixtures/a2-quiet.wav` exercises the same thing end to end.
