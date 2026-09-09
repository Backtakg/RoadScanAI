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

      if (bad) {
        // Detach the contaminated polyline. The owning tracker may continue
        // collecting data, but the bad historical jump can no longer be shown.
        map.removeLayer(layer);
      }
    });
  }

  function install() {
    if (!window.navigator || !navigator.geolocation) return;

    // Replace the app's route collector with a movement-only collector.
    // Accuracy improvements alone never create a new route point.
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

        // First fix establishes the route origin. After that, only genuine
        // movement is allowed to extend the blue route. Better accuracy alone
        // is never treated as movement.
        if (!lastAccepted) {
          lastAccepted = candidate;
          window.gps = candidate;
          window.points = [[candidate.lat, candidate.lon]];
          window.bestAccuracy = accuracy;
          window.lastPointAt = Date.now();
        } else {
          var elapsed = Math.max(1, (Date.now() - window.lastPointAt) / 1000);
          var maxTravel = Math.max(120, elapsed * 45); // ~162 km/h upper bound
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
            window.roadMap.setView(window.points[0], 18, { animate: true });
          } else if (window.points.length > 1) {
            window.roadMap.fitBounds(L.latLngBounds(window.points), { padding: [30, 30], maxZoom: 19 });
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

  // app-v2.js is loaded immediately after this file, so install after it has
  // executed and replaced the original gpsStart declaration.
  window.addEventListener('load', function () {
    setTimeout(install, 50);
    setInterval(cleanRoutes, 1000);
  });
})();
