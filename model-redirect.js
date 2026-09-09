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

// GPS route guard: browser location can legitimately improve its accuracy while
// the phone is stationary, but those accuracy-only fixes must never become route
// points. We also reject physically impossible jumps so a GPS glitch cannot draw
// a blue line across the map. The browser still provides the best current fix.
(function () {
  'use strict';

  function distance(a, b) {
    var R = 6371000, rad = Math.PI / 180;
    var p1 = a.lat * rad, p2 = b.lat * rad;
    var dp = (b.lat - a.lat) * rad, dl = (b.lon - a.lon) * rad;
    var x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  function cleanRoutes() {
    if (!window.roadMap || !window.L) return;
    var map = window.roadMap;
    map.eachLayer(function (layer) {
      if (!layer || typeof layer.getLatLngs !== 'function' || typeof layer.setLatLngs !== 'function') return;
      var raw = layer.getLatLngs();
      if (!Array.isArray(raw) || raw.length < 2 || !raw[0] || !raw[1] || Array.isArray(raw[0])) return;

      var bad = false;
      for (var i = 1; i < raw.length; i++) {
        var a = { lat: raw[i - 1].lat, lon: raw[i - 1].lng };
        var b = { lat: raw[i].lat, lon: raw[i].lng };
        if (distance(a, b) > 250) { bad = true; break; }
      }

      if (bad) map.removeLayer(layer);
    });
  }

  function install() {
    if (!window.navigator || !navigator.geolocation) return;

    window.gpsStart = function () {
      if (!navigator.geolocation) {
        var el = document.getElementById('gpsStatus');
        if (el) el.textContent = 'GPS not supported';
        return;
      }

      if (window.watch !== null && window.watch !== undefined) {
        try { navigator.geolocation.clearWatch(window.watch); } catch (_) {}
      }

      window.gps = null;
      window.points = [];
      window.bestAccuracy = Infinity;
      window.lastPointAt = 0;
      var statusEl = document.getElementById('gpsStatus');
      if (statusEl) statusEl.textContent = 'Finding best GPS fix…';

      var lastAccepted = null;
      var opts = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };

      function accept(position) {
        var c = position.coords;
        var accuracy = Number.isFinite(c.accuracy) ? c.accuracy : 9999;
        if (accuracy > 80) {
          if (statusEl) statusEl.textContent = 'GPS weak · waiting for a better fix';
          return;
        }

        var candidate = { lat: c.latitude, lon: c.longitude, accuracy: accuracy };
        var moved = lastAccepted ? distance(lastAccepted, candidate) : Infinity;

        if (!lastAccepted) {
          lastAccepted = candidate;
          window.gps = candidate;
          window.points = [[candidate.lat, candidate.lon]];
          window.bestAccuracy = accuracy;
          window.lastPointAt = Date.now();
        } else {
          var elapsed = Math.max(1, (Date.now() - window.lastPointAt) / 1000);
          var maxTravel = Math.max(120, elapsed * 45);
          if (moved < 5) {
            window.gps = candidate;
            if (statusEl) statusEl.textContent = 'Stationary · GPS ±' + Math.round(accuracy) + ' m';
          } else if (moved > maxTravel) {
            if (statusEl) statusEl.textContent = 'Ignoring GPS jump · reacquiring…';
            return;
          } else {
            lastAccepted = candidate;
            window.gps = candidate;
            window.points.push([candidate.lat, candidate.lon]);
            window.lastPointAt = Date.now();
            window.bestAccuracy = Math.min(window.bestAccuracy, accuracy);
          }
        }

        var loc = document.getElementById('lastLocation');
        if (loc) loc.textContent = candidate.lat.toFixed(6) + ', ' + candidate.lon.toFixed(6) + ' · ±' + Math.round(accuracy) + ' m';

        if (window.mapLine) window.mapLine.setLatLngs(window.points);
        if (window.roadMap) {
          if (window.points.length === 1) {
            window.roadMap.setView(window.points[0], 18, { animate: false });
          } else if (window.points.length > 1) {
            window.roadMap.fitBounds(L.latLngBounds(window.points), { padding: [30, 30], maxZoom: 19, animate: false });
          }
        }
        cleanRoutes();
      }

      window.watch = navigator.geolocation.watchPosition(accept, function (e) {
        if (!statusEl) return;
        statusEl.textContent = e.code === 1 ? 'Permission denied' : e.code === 3 ? 'GPS timeout · retrying…' : 'Location unavailable';
      }, opts);
    };
  }

  window.addEventListener('load', function () {
    setTimeout(install, 50);
    setInterval(cleanRoutes, 1000);
  });
})();

// Mobile map scroll-performance fix.
// Leaflet can treat one-finger touches as map gestures, competing with vertical
// page scrolling. Disable touch map panning/zooming on touch devices so the page
// scrolls smoothly; desktop mouse controls and zoom buttons remain available.
(function () {
  'use strict';
  function tuneMapForScroll() {
    var map = window.roadMap;
    if (!map) return false;
    var touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (touch) {
      if (map.dragging) map.dragging.disable();
      if (map.touchZoom) map.touchZoom.disable();
      var el = document.getElementById('map');
      if (el) el.style.touchAction = 'pan-y';
    }
    return true;
  }
  window.addEventListener('load', function () {
    setTimeout(tuneMapForScroll, 100);
    setTimeout(tuneMapForScroll, 700);
  });
})();

// AI camera robustness layer.
// Phone footage is often shaky, low-contrast and very dark. The detector itself
// is unchanged; instead, adapt the tensor only when the incoming frame is dark
// enough to benefit. This avoids permanently boosting normal daylight frames.
// Gamma lift + contrast normalization improves visibility of road texture and
// pothole boundaries at dusk/night while keeping the original tensor layout.
(function () {
  'use strict';
  if (!window.ort || !ort.InferenceSession || !ort.Tensor) return;

  var proto = ort.InferenceSession.prototype;
  var originalRun = proto.run;
  if (!originalRun || originalRun.__roadscanRobust) return;

  function enhanceTensor(t) {
    if (!t || !t.data || !t.dims || t.type !== 'float32') return t;
    var data = t.data;
    var channels = 3;
    var n = Math.floor(data.length / channels);
    if (!n || data.length !== n * channels) return t;

    // Estimate luminance from the RGB planes. The YOLO input is RGB planar.
    var mean = 0;
    for (var i = 0; i < n; i += 32) {
      mean += 0.2126 * data[i] + 0.7152 * data[n + i] + 0.0722 * data[2 * n + i];
    }
    mean /= Math.ceil(n / 32);

    // Do nothing on normal daylight footage.
    if (mean >= 0.40) return t;

    var gamma = mean < 0.20 ? 0.62 : mean < 0.30 ? 0.70 : 0.80;
    var contrast = mean < 0.22 ? 1.18 : 1.12;
    var out = new Float32Array(data.length);

    for (var c = 0; c < channels; c++) {
      var base = c * n;
      for (var p = 0; p < n; p++) {
        var x = Math.max(0, Math.min(1, data[base + p]));
        // Gamma lift shadow detail, then gently expand local tonal range around mid-gray.
        x = Math.pow(x, gamma);
        x = 0.5 + (x - 0.5) * contrast;
        out[base + p] = Math.max(0, Math.min(1, x));
      }
    }
    return new ort.Tensor('float32', out, t.dims);
  }

  proto.run = function (feeds, options) {
    try {
      if (feeds && typeof feeds === 'object') {
        var keys = Object.keys(feeds);
        if (keys.length === 1) {
          var key = keys[0], tensor = feeds[key], enhanced = enhanceTensor(tensor);
          if (enhanced !== tensor) {
            var adapted = Object.assign({}, feeds);
            adapted[key] = enhanced;
            return originalRun.call(this, adapted, options);
          }
        }
      }
    } catch (e) {
      console.warn('RoadScan AI preprocessing fallback:', e);
    }
    return originalRun.call(this, feeds, options);
  };
  proto.run.__roadscanRobust = true;
})();
