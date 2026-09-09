// RoadScan AI — ONNX Runtime Web compatibility configuration.
// Keep the production inference path untouched. The pothole model's tensor
// layout is decoded by app-v2.js and must not be replaced or intercepted.
(function () {
  'use strict';
  if (!window.ort) return;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  ort.env.logLevel = 'warning';
})();

// GPS route guard. GPS accuracy can improve while the phone is stationary;
// those accuracy-only fixes must not create route points. Also reject obvious
// GPS jumps so a bad fix cannot draw a long false segment across the map.
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
      for (var i = 1; i < raw.length; i++) {
        var a = { lat: raw[i - 1].lat, lon: raw[i - 1].lng };
        var b = { lat: raw[i].lat, lon: raw[i].lng };
        if (distance(a, b) > 250) {
          map.removeLayer(layer);
          return;
        }
      }
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

// Mobile map scroll-performance fix. Keep one-finger page scrolling natural;
// desktop mouse controls and the Leaflet zoom buttons remain available.
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
