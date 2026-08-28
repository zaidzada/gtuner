// Microphone capture and the worklet <-> worker plumbing.
//
//   mic -> AudioWorklet (ring buffer)  [audio thread]
//            | transfer
//          main thread (relay only)
//            | transfer
//          Worker -> WASM detect()     [worker thread]
//            | result
//          main thread -> onResult

// If no window arrives for this long while running, the capture chain has
// died. Windows normally arrive every ~23 ms, so this is a very quiet alarm.
const STALL_MS = 1500;
const WATCHDOG_INTERVAL_MS = 500;
const MAX_RECOVERIES = 6;

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

    // Every node in the graph is held here on purpose. A
    // MediaStreamAudioSourceNode that nothing references can be garbage
    // collected out from under a running graph — the classic Web Audio
    // failure where capture works for a few seconds and then silently stops.
    this.source = null;
    this.mute = null;

    this.frameCount = 0;      // windows delivered by the worklet
    this.resultCount = 0;     // results returned by the worker
    this.lastFrameAt = 0;
    this.stallCount = 0;
    this.recoveryCount = 0;
    this.watchdog = null;
    this.recovering = false;
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

    this.watchTrack();

    this.context = new (window.AudioContext || window.webkitAudioContext)();
    // Chrome can suspend a context and Safari can mark it "interrupted" (a
    // phone call, another app taking the audio device). Neither fires an
    // error — the graph just stops — so resume whenever it happens.
    this.context.onstatechange = () => {
      if (!this.context) return;
      if (this.context.state === 'suspended' || this.context.state === 'interrupted') {
        this.context.resume().catch(() => {});
      }
    };
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

    this.buildGraph();

    this.worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type !== 'result' && msg.type !== 'recycle') return;
      // The buffer goes home first, no matter what the UI callback does. If a
      // render error could swallow buffers, the pool would drain and the
      // worklet would allocate on the audio thread forever after.
      const frame = msg.frame;
      try {
        if (msg.type === 'result') {
          this.resultCount++;
          this.onResult(msg);
        }
      } finally {
        if (this.node && frame && frame.buffer.byteLength) {
          this.node.port.postMessage(frame, [frame.buffer]);
        }
      }
    };

    this.lastFrameAt = performance.now();
    this.startWatchdog();
    this.setState('running');
  }

  /** Wire mic -> worklet -> silent gain -> destination. */
  buildGraph() {
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'capture-processor');

    this.node.port.onmessage = (event) => {
      const frame = event.data;
      this.frameCount++;
      this.lastFrameAt = performance.now();
      this.worker.postMessage(
        { type: 'frame', frame, sampleRate: this.context.sampleRate, sentAt: this.lastFrameAt },
        [frame.buffer],
      );
    };

    // The graph only pulls nodes that reach the destination, so the worklet
    // has to be connected — but through a silent gain, or you get feedback.
    this.mute = this.context.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(this.context.destination);
  }

  teardownGraph() {
    for (const node of [this.source, this.node, this.mute]) {
      try { node && node.disconnect(); } catch { /* already gone */ }
    }
    if (this.node) this.node.port.onmessage = null;
    this.source = this.node = this.mute = null;
  }

  /** A microphone can be muted, stolen by another app, or unplugged. */
  watchTrack() {
    const track = this.stream && this.stream.getAudioTracks()[0];
    if (!track) return;
    track.onended = () => this.recover('the microphone was disconnected');
    track.onmute = () => this.setState('running', 'muted');
    track.onunmute = () => this.setState('running');
  }

  startWatchdog() {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.state !== 'running' || this.recovering) return;
      if (performance.now() - this.lastFrameAt < STALL_MS) return;
      this.stallCount++;
      this.recover('the audio pipeline stopped delivering samples');
    }, WATCHDOG_INTERVAL_MS);
  }

  stopWatchdog() {
    if (this.watchdog !== null) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  /**
   * Rebuild whatever died. Cheapest repair first: relink the graph. If the
   * microphone track itself is gone, go all the way back to getUserMedia.
   */
  async recover(reason) {
    if (this.recovering || this.state === 'idle') return;
    if (this.recoveryCount >= MAX_RECOVERIES) {
      this.stopWatchdog();
      this.setState('error', `Audio kept stopping (${reason}). Reload the page to try again.`);
      return;
    }
    this.recovering = true;
    this.recoveryCount++;
    this.setState('recovering', reason);

    try {
      const track = this.stream && this.stream.getAudioTracks()[0];
      const trackDead = !track || track.readyState === 'ended';

      this.teardownGraph();

      if (trackDead) {
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        });
        this.watchTrack();
      }

      if (this.context.state !== 'running') await this.context.resume();
      this.buildGraph();

      this.lastFrameAt = performance.now();
      this.setState('running');
    } catch (err) {
      this.setState('error', `Could not restart audio: ${err && err.message ? err.message : err}`);
    } finally {
      this.recovering = false;
    }
  }

  async stop() {
    this.stopWatchdog();
    if (this.node) this.node.port.postMessage('stop');
    this.teardownGraph();
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.context) { this.context.onstatechange = null; await this.context.close(); this.context = null; }
    this.setState('idle');
  }
}
