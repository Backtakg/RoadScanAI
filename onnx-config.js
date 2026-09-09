/* RoadScan AI: ONNX Runtime Web compatibility configuration. */
(function () {
  if (!window.ort) return;
  // Keep inference compatible with Android browsers that cannot use WASM threads.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  ort.env.logLevel = 'warning';
})();
