// Where the worklet, the worker, and the WASM binary come from.
//
// This is the one seam between the two builds. Served normally, everything is
// a separate file and these are ordinary URLs. In the single-file build
// (tools/build-single.mjs) this module is swapped for one that hands back blob
// URLs and inline bytes instead — nothing else in the app changes.

export function resolveSources() {
  return {
    workletUrl: new URL('./capture-processor.js', import.meta.url).href,
    workerUrl: new URL('./detector-worker.js', import.meta.url).href,
    wasmUrl: new URL('../wasm/yin.wasm', import.meta.url).href,
  };
}
