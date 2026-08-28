// Worker thread. Owns the WASM instance and runs pitch detection.
//
// This lives off the audio thread on purpose: detect() takes ~4 ms, while an
// AudioWorklet callback must return in under ~2.9 ms. Running it inline would
// glitch the audio even though average CPU load is low.

let exports_ = null;
let input = null;
let output = null;
let memoryBuffer = null;

// WebAssembly.Memory views detach if memory ever grows. We don't grow, but
// re-deriving on change costs nothing and removes a whole class of bug.
function views() {
  if (memoryBuffer !== exports_.memory.buffer) {
    memoryBuffer = exports_.memory.buffer;
    input = new Float32Array(memoryBuffer, exports_.input_ptr(), exports_.frame_size());
    output = new Float32Array(memoryBuffer, exports_.output_ptr(), 4);
  }
  return { input, output };
}

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'init') {
    try {
      let bytes = msg.wasmBytes;
      if (!bytes) {
        const response = await fetch(msg.wasmUrl);
        if (!response.ok) throw new Error(`fetch ${msg.wasmUrl}: ${response.status}`);
        bytes = await response.arrayBuffer();
      }
      const { instance } = await WebAssembly.instantiate(bytes, {});
      exports_ = instance.exports;
      views();
      self.postMessage({ type: 'ready', frameSize: exports_.frame_size() });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
    return;
  }

  if (msg.type === 'frame') {
    const frame = msg.frame;
    if (!exports_) {
      self.postMessage({ type: 'recycle', frame }, [frame.buffer]);
      return;
    }
    const { input: inputView, output: outputView } = views();
    const n = Math.min(frame.length, inputView.length);
    inputView.set(frame.subarray(0, n));

    const found = exports_.detect(n, msg.sampleRate, 0.15);

    self.postMessage({
      type: 'result',
      found: found === 1,
      freq: outputView[0],
      clarity: outputView[1],
      rms: outputView[2],
      frame,                       // hand the buffer back for reuse
    }, [frame.buffer]);
  }
};
