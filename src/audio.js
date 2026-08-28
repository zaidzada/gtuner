// Microphone capture and the worklet <-> worker plumbing.
//
//   mic -> AudioWorklet (ring buffer)  [audio thread]
//            | transfer
//          main thread (relay only)
//            | transfer
//          Worker -> WASM detect()     [worker thread]
//            | result
//          main thread -> onResult

export class TunerEngine {
  /**
   * @param {object} options
   * @param {(result: object) => void} options.onResult
   * @param {(state: string, detail?: string) => void} [options.onStateChange]
   * @param {string} options.workletUrl  AudioWorklet module (a real URL or a blob: URL)
   * @param {string} options.workerUrl   Worker script (a real URL or a blob: URL)
   * @param {string} [options.wasmUrl]   fetched by the worker
   * @param {Uint8Array} [options.wasmBytes]  used instead of wasmUrl when inlined
   */
  constructor({ onResult, onStateChange, workletUrl, workerUrl, wasmUrl, wasmBytes }) {
    this.onResult = onResult;
    this.onStateChange = onStateChange || (() => {});
    this.workletUrl = workletUrl;
    this.workerUrl = workerUrl;
    this.wasmUrl = wasmUrl;
    this.wasmBytes = wasmBytes;
    this.context = null;
    this.stream = null;
    this.node = null;
    this.worker = null;
    this.state = 'idle';
  }

  setState(state, detail) {
    this.state = state;
    this.onStateChange(state, detail);
  }

  async start() {
    if (this.state === 'running' || this.state === 'starting') return;
    this.setState('starting');

    // Opened straight from disk. The mic would prompt and then the worklet
    // would fail on an opaque origin, so say why up front instead.
    if (location.protocol === 'file:') {
      this.setState('error',
        'This page has to be served over http:// or https:// — browsers block audio worklets on pages opened directly from disk. Any static host works, or run "python3 -m http.server" in this folder and open localhost.');
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.setState('error', 'This browser has no microphone API. Note that microphone access requires https:// or localhost.');
      return;
    }

    try {
      // Browser voice processing is tuned for speech and will actively mangle
      // a sustained guitar tone. All three must be off.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      const name = err && err.name;
      const message =
        name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser settings and reload.'
        : name === 'NotFoundError' ? 'No microphone was found.'
        : `Could not open the microphone (${name || err}).`;
      this.setState('error', message);
      return;
    }

    this.context = new (window.AudioContext || window.webkitAudioContext)();
    if (this.context.state === 'suspended') await this.context.resume();

    try {
      await this.context.audioWorklet.addModule(this.workletUrl);
    } catch (err) {
      this.setState('error', `Could not load the audio processor: ${err}`);
      return;
    }

    this.worker = new Worker(this.workerUrl);

    const ready = new Promise((resolve, reject) => {
      const onFirst = (event) => {
        if (event.data.type === 'ready') { this.worker.removeEventListener('message', onFirst); resolve(); }
        else if (event.data.type === 'error') { this.worker.removeEventListener('message', onFirst); reject(new Error(event.data.message)); }
      };
      this.worker.addEventListener('message', onFirst);
    });
    if (this.wasmBytes) {
      // Inlined build: hand the module straight over. No fetch involved, which
      // also means no same-origin questions to answer.
      this.worker.postMessage({ type: 'init', wasmBytes: this.wasmBytes });
    } else {
      this.worker.postMessage({ type: 'init', wasmUrl: this.wasmUrl });
    }

    try {
      await ready;
    } catch (err) {
      this.setState('error', `Could not load the pitch detector: ${err.message}`);
      return;
    }

    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'capture-processor');

    // Relay windows out to the worker, and recycled buffers back to the worklet.
    this.node.port.onmessage = (event) => {
      const frame = event.data;
      this.worker.postMessage(
        { type: 'frame', frame, sampleRate: this.context.sampleRate },
        [frame.buffer],
      );
    };

    this.worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'result') {
        this.onResult(msg);
        this.node.port.postMessage(msg.frame, [msg.frame.buffer]);
      } else if (msg.type === 'recycle') {
        this.node.port.postMessage(msg.frame, [msg.frame.buffer]);
      }
    };

    // The graph only pulls nodes that reach the destination, so the worklet
    // has to be connected — but through a silent gain, or you get feedback.
    const mute = this.context.createGain();
    mute.gain.value = 0;
    source.connect(this.node);
    this.node.connect(mute);
    mute.connect(this.context.destination);

    this.setState('running');
  }

  async stop() {
    if (this.node) { this.node.port.postMessage('stop'); this.node.disconnect(); this.node = null; }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.context) { await this.context.close(); this.context = null; }
    this.setState('idle');
  }
}
