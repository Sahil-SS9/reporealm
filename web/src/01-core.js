/* SOURCE DRIVE - core utilities.
 * Pure maths, deterministic RNG, settings store, tiny event bus.
 * No DOM, no THREE dependency: this file loads in node for unit tests.
 */
(function (SD) {
  'use strict';

  // ---------------------------------------------------------------- numbers
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sign(v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); }
  function round(v, places) {
    var f = Math.pow(10, places || 3);
    return Math.round(v * f) / f;
  }
  function nearly(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps); }

  // ------------------------------------------------------------ deterministic
  // mulberry32: small, fast, well-distributed, identical on every engine.
  function mulberry32(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // A named stream so adding a feature later cannot shift every other draw.
  function stream(seed, name) {
    return mulberry32((seed ^ hashString(String(name))) >>> 0);
  }

  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
  function shuffle(rng, arr) {
    var out = arr.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  // ------------------------------------------------------------------- vec3
  // Plain {x,y,z} objects so physics and level logic stay engine-free.
  function v3(x, y, z) { return { x: x || 0, y: y || 0, z: z || 0 }; }
  function v3add(a, b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
  function v3sub(a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
  function v3scale(a, s) { return v3(a.x * s, a.y * s, a.z * s); }
  function v3dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function v3cross(a, b) {
    return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  function v3len(a) { return Math.sqrt(v3dot(a, a)); }
  function v3norm(a) {
    var l = v3len(a);
    return l > 1e-9 ? v3scale(a, 1 / l) : v3(0, 0, 0);
  }
  function v3copy(a) { return v3(a.x, a.y, a.z); }

  // ---------------------------------------------------------------- 3x3 frames
  // A frame is {pos, x, y, z}: an orthonormal basis plus an origin.
  // Portal maths is expressed in frames so the transform is exactly rigid.
  function frameFromNormal(pos, normal, up) {
    var z = v3norm(normal);
    var y = v3norm(v3sub(up || v3(0, 1, 0), v3scale(z, v3dot(up || v3(0, 1, 0), z))));
    if (v3len(y) < 1e-6) {
      // normal parallel to up: choose any perpendicular
      y = v3norm(v3sub(Math.abs(z.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0), v3scale(z, v3dot(Math.abs(z.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0), z))));
    }
    var x = v3cross(y, z);
    return { pos: v3copy(pos), x: v3norm(x), y: v3norm(y), z: z };
  }

  function frameToLocal(frame, p) {
    var d = v3sub(p, frame.pos);
    return v3(v3dot(d, frame.x), v3dot(d, frame.y), v3dot(d, frame.z));
  }

  function frameToWorld(frame, local) {
    return v3(
      frame.pos.x + frame.x.x * local.x + frame.y.x * local.y + frame.z.x * local.z,
      frame.pos.y + frame.x.y * local.x + frame.y.y * local.y + frame.z.y * local.z,
      frame.pos.z + frame.x.z * local.x + frame.y.z * local.y + frame.z.z * local.z
    );
  }

  // A portal's destination frame is the source frame rotated 180 deg about its
  // own Y axis: you look into the source and see out of the destination.
  function flipLocal(local) { return v3(-local.x, local.y, -local.z); }
  function flipDir(dir) { return v3(-dir.x, dir.y, -dir.z); }

  function dirToLocal(frame, d) { return v3(v3dot(d, frame.x), v3dot(d, frame.y), v3dot(d, frame.z)); }
  function dirToWorld(frame, local) {
    return v3(
      frame.x.x * local.x + frame.y.x * local.y + frame.z.x * local.z,
      frame.x.y * local.x + frame.y.y * local.y + frame.z.y * local.z,
      frame.x.z * local.x + frame.y.z * local.y + frame.z.z * local.z
    );
  }

  // --------------------------------------------------------------- event bus
  function bus() {
    var map = {};
    return {
      on: function (name, fn) {
        (map[name] = map[name] || []).push(fn);
        return function () {
          var a = map[name] || [];
          var i = a.indexOf(fn);
          if (i >= 0) a.splice(i, 1);
        };
      },
      emit: function (name, payload) {
        var a = map[name] || [];
        for (var i = 0; i < a.length; i++) {
          try { a[i](payload); } catch (err) { if (SD.reportError) SD.reportError(err); }
        }
      }
    };
  }

  // ---------------------------------------------------------------- settings
  var SETTINGS_KEY = 'source-drive.settings.v1';
  var DEFAULTS = {
    fov: 78,
    sensitivity: 1.0,
    invertY: false,
    muted: false,
    narration: true,
    reducedMotion: false,
    renderScale: 1.0
  };

  function Storage(backing) { this.backing = backing; }
  Storage.prototype.read = function (key) {
    try { return this.backing ? this.backing.getItem(key) : null; } catch (e) { return null; }
  };
  Storage.prototype.write = function (key, value) {
    try { if (this.backing) this.backing.setItem(key, value); return true; } catch (e) { return false; }
  };

  function memoryStorage() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; }
    };
  }

  function Settings(store) {
    this.store = new Storage(store || memoryStorage());
    this.values = {};
    this.load();
  }

  Settings.prototype.load = function () {
    var raw = this.store.read(SETTINGS_KEY);
    var parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }
    this.values = {};
    for (var k in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
      var v = parsed && Object.prototype.hasOwnProperty.call(parsed, k) ? parsed[k] : DEFAULTS[k];
      this.values[k] = this._coerce(k, v);
    }
    return this.values;
  };

  Settings.prototype._coerce = function (key, value) {
    var d = DEFAULTS[key];
    if (typeof d === 'boolean') return !!value;
    if (key === 'fov') return clamp(Number(value) || d, 55, 110);
    if (key === 'sensitivity') return clamp(Number(value) || d, 0.15, 4);
    if (key === 'renderScale') return clamp(Number(value) || d, 0.4, 1);
    return value;
  };

  Settings.prototype.get = function (key) {
    return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : DEFAULTS[key];
  };

  Settings.prototype.set = function (key, value) {
    this.values[key] = this._coerce(key, value);
    this.store.write(SETTINGS_KEY, JSON.stringify(this.values));
    return this.values[key];
  };

  Settings.prototype.reset = function () {
    this.values = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) this.values[k] = DEFAULTS[k];
    }
    this.store.write(SETTINGS_KEY, JSON.stringify(this.values));
    return this.values;
  };

  // -------------------------------------------------------------- misc helpers
  function fmtNum(n, places) {
    var v = Number(n);
    if (!isFinite(v)) return '?';
    var s = v.toFixed(places === undefined ? 1 : places);
    return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  SD.Core = {
    clamp: clamp, lerp: lerp, sign: sign, round: round, nearly: nearly,
    mulberry32: mulberry32, hashString: hashString, stream: stream, pick: pick, shuffle: shuffle,
    v3: v3, v3add: v3add, v3sub: v3sub, v3scale: v3scale, v3dot: v3dot, v3cross: v3cross,
    v3len: v3len, v3norm: v3norm, v3copy: v3copy,
    frameFromNormal: frameFromNormal, frameToLocal: frameToLocal, frameToWorld: frameToWorld,
    flipLocal: flipLocal, flipDir: flipDir, dirToLocal: dirToLocal, dirToWorld: dirToWorld,
    bus: bus, Settings: Settings, memoryStorage: memoryStorage, DEFAULTS: DEFAULTS,
    SETTINGS_KEY: SETTINGS_KEY,
    fmtNum: fmtNum, escapeHtml: escapeHtml
  };
})(typeof window !== 'undefined' ? (window.SD = window.SD || {}) : (globalThis.SD = globalThis.SD || {}));
