// AudioWorklet processor. Runs on the realtime audio thread, so it does as
// little as possible: copy samples into a ring buffer and hand off a window
// every HOP samples. All the actual analysis happens in a Worker.
//
// Buffers are recycled rather than allocated. We transfer a Float32Array out
// to the main thread; once the Worker is done with it, it comes back here and
// goes on the free list. After a second or so this loop allocates nothing at
// all, which keeps the GC away from the audio thread.

const FRAME = 4096;          // analysis window (~93 ms at 44.1 kHz)
const HOP = 1024;            // emit this often (~23 ms -> ~43 updates/sec)
const MASK = FRAME - 1;      // FRAME is a power of two

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(FRAME);
    this.idx = 0;
    this.filled = 0;
    this.sinceEmit = 0;
    this.pool = [];
    this.running = true;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data === 'stop') {
        this.running = false;
      } else if (data && data.buffer instanceof ArrayBuffer) {
        // A window came back from the Worker; reuse it.
        if (this.pool.length < 4) this.pool.push(data);
      }
    };
  }

  process(inputs) {
    if (!this.running) return false;

    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.ring[this.idx] = channel[i];
      this.idx = (this.idx + 1) & MASK;
    }
    if (this.filled < FRAME) this.filled = Math.min(FRAME, this.filled + channel.length);
    this.sinceEmit += channel.length;

    if (this.sinceEmit >= HOP && this.filled >= FRAME) {
      this.sinceEmit = 0;
      const out = this.pool.pop() || new Float32Array(FRAME);
      // Linearize the ring, oldest sample first. this.idx is both the next
      // write position and, once full, the oldest sample.
      const head = FRAME - this.idx;
      out.set(this.ring.subarray(this.idx), 0);
      out.set(this.ring.subarray(0, this.idx), head);
      this.port.postMessage(out, [out.buffer]);
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
