// RoadScan AI — ONNX Runtime Web compatibility fix.
// Do NOT redirect the pothole model to a different YOLO export: its tensor
// layout may not match the decoder in app-fixed.js.
(function () {
  if (!window.ort) return;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  ort.env.logLevel = 'warning';
})();
