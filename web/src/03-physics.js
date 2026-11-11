/* SOURCE DRIVE - axis-aligned collision world.
 *
 * Bodies are feet-centred boxes: min = pos - (x/2, 0, z/2), max = pos + (x/2, y, z/2).
 * Movement is resolved one axis at a time with sub-stepping, which keeps a fast
 * fling from tunnelling through a wall. Step-up assist lets a 0.5 m threshold be
 * walked over instead of blocking the player.
 */
(function (SD) {
  'use strict';
  var C = SD.Core;

  function aabbOf(body) {
    return {
      min: { x: body.pos.x - body.size.x / 2, y: body.pos.y, z: body.pos.z - body.size.z / 2 },
      max: { x: body.pos.x + body.size.x / 2, y: body.pos.y + body.size.y, z: body.pos.z + body.size.z / 2 }
    };
  }

  function overlaps(a, b, eps) {
    var e = eps || 0;
    return a.min.x < b.max.x - e && a.max.x > b.min.x + e &&
      a.min.y < b.max.y - e && a.max.y > b.min.y + e &&
      a.min.z < b.max.z - e && a.max.z > b.min.z + e;
  }

  function containsPoint(aabb, p) {
    return p.x >= aabb.min.x && p.x <= aabb.max.x &&
      p.y >= aabb.min.y && p.y <= aabb.max.y &&
      p.z >= aabb.min.z && p.z <= aabb.max.z;
  }

  // A portal punches a real hole in the collider: a body whose footprint lies
  // inside the aperture passes through the surface instead of standing on it.
  // (portal64 pokes the portal surface itself; here the collider is an AABB with
  // an aperture window cut through its thickness.)
  function holeAllows(solid, point) {
    var holes = solid.holes;
    if (!holes || !holes.length) return false;
    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      if (point[h.uAxis] >= h.u0 && point[h.uAxis] <= h.u1 &&
        point[h.vAxis] >= h.v0 && point[h.vAxis] <= h.v1) return true;
    }
    return false;
  }

  function World(solids) {
    this.solids = solids || [];
    this.triggers = [];
    this.statics = null;
  }

  World.prototype.addHole = function (solid, hole) {
    if (!solid.holes) solid.holes = [];
    solid.holes.push(hole);
    return hole;
  };

  World.prototype.removeHole = function (solid, hole) {
    if (!solid.holes) return;
    var i = solid.holes.indexOf(hole);
    if (i >= 0) solid.holes.splice(i, 1);
  };

  World.prototype.refresh = function () {
    this.statics = this.solids.filter(function (s) { return !s.dynamic; });
  };

  World.prototype.solidsNow = function () {
    var out = [];
    for (var i = 0; i < this.solids.length; i++) {
      var s = this.solids[i];
      if (s.disabled) continue;
      out.push(s);
    }
    return out;
  };

  // ------------------------------------------------------------- ray casting
  // Returns {t, normal, solid} or null. dir must be normalised.
  World.prototype.raycast = function (origin, dir, maxDist, filter) {
    var best = null;
    var solids = this.solidsNow();
    for (var i = 0; i < solids.length; i++) {
      var s = solids[i];
      if (filter && !filter(s)) continue;
      var hit = rayAabb(origin, dir, s.aabb, maxDist || 1e4);
      if (hit && (!best || hit.t < best.t)) {
        best = { t: hit.t, normal: hit.normal, solid: s };
      }
    }
    return best;
  };

  function rayAabb(o, d, box, maxDist) {
    var tmin = 0, tmax = maxDist, axis = -1, sign = 1;
    var axes = ['x', 'y', 'z'];
    for (var i = 0; i < 3; i++) {
      var a = axes[i];
      var d0 = d[a];
      if (Math.abs(d0) < 1e-9) {
        if (o[a] < box.min[a] || o[a] > box.max[a]) return null;
        continue;
      }
      var inv = 1 / d0;
      var t1 = (box.min[a] - o[a]) * inv;
      var t2 = (box.max[a] - o[a]) * inv;
      var s = -1;
      if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (axis < 0) return null;
    var normal = { x: 0, y: 0, z: 0 };
    normal[axes[axis]] = sign;
    return { t: tmin, normal: normal };
  }

  // ------------------------------------------------------------- movement
  var MAX_SUBSTEP = 0.18;

  World.prototype.moveBody = function (body, delta, opts) {
    var options = opts || {};
    var stepHeight = options.stepHeight === undefined ? 0.52 : options.stepHeight;
    var res = { hitX: false, hitZ: false, hitY: false, ceiling: false, ground: false, steppedUp: 0 };

    var steps = 1;
    var mag = Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z));
    if (mag > MAX_SUBSTEP) steps = Math.ceil(mag / MAX_SUBSTEP);
    var dx = delta.x / steps, dy = delta.y / steps, dz = delta.z / steps;

    if (body.onGround) body.onGround = false;

    for (var s = 0; s < steps; s++) {
      // ---- horizontal, one axis at a time
      this._axis(body, 'x', dx, res, stepHeight);
      this._axis(body, 'z', dz, res, stepHeight);
      // ---- vertical
      this._axis(body, 'y', dy, res, 0);
    }

    if (res.ground) body.onGround = true;
    return res;
  };

  World.prototype._axis = function (body, axis, amount, res, stepHeight) {
    if (!amount) return;
    body.pos[axis] += amount;
    var box = aabbOf(body);
    var solids = this.solidsNow();
    var bodyCentre = { x: body.pos.x, y: body.pos.y + body.size.y / 2, z: body.pos.z };
    for (var i = 0; i < solids.length; i++) {
      var s = solids[i];
      if (!overlaps(box, s.aabb, 1e-4)) continue;
      // an aperture cut through this solid lets the body pass
      if (holeAllows(s, bodyCentre)) continue;

      if (axis === 'y') {
        if (amount > 0) {
          body.pos.y = s.aabb.min.y - body.size.y - 1e-4;
          res.hitY = true; res.ceiling = true;
          body.vel.y = 0;
        } else {
          var top = s.aabb.max.y;
          // only land if we were above the surface
          if (body.pos.y >= top - 0.02 || body.pos.y > top - body.size.y) {
            body.pos.y = top + 1e-4;
            body.vel.y = 0;
            body.onGround = true;
            res.hitY = true; res.ground = true;
          }
        }
      } else {
        // horizontal block: try to step up onto a low ledge first
        var canStep = stepHeight > 0 && s.aabb.max.y - body.pos.y <= stepHeight &&
          s.aabb.max.y - body.pos.y > 0;
        if (canStep) {
          var trial = { pos: { x: body.pos.x, y: s.aabb.max.y + 1e-3, z: body.pos.z }, size: body.size };
          var trialBox = aabbOf(trial);
          var clear = true;
          for (var j = 0; j < solids.length; j++) {
            if (overlaps(trialBox, solids[j].aabb, 1e-4)) { clear = false; break; }
          }
          if (clear) {
            res.steppedUp += trial.pos.y - body.pos.y;
            body.pos.y = trial.pos.y;
            body.onGround = true;
            continue;
          }
        }
        // push back out along the movement axis
        if (amount > 0) body.pos[axis] = s.aabb.min[axis] - (axis === 'x' ? body.size.x : body.size.z) / 2 - 1e-4;
        else body.pos[axis] = s.aabb.max[axis] + (axis === 'x' ? body.size.x : body.size.z) / 2 + 1e-4;
        body.vel[axis] = 0;
        if (axis === 'x') res.hitX = true; else res.hitZ = true;
      }
      box = aabbOf(body);
    }
  };

  // Is the body's box free at this position?
  World.prototype.isFree = function (body, pos) {
    var probe = { pos: pos, size: body.size };
    var box = aabbOf(probe);
    var solids = this.solidsNow();
    for (var i = 0; i < solids.length; i++) {
      if (overlaps(box, solids[i].aabb, 1e-3)) return false;
    }
    return true;
  };

  World.prototype.overlappingTriggers = function (body, tag) {
    var box = aabbOf(body);
    var out = [];
    for (var i = 0; i < this.triggers.length; i++) {
      var t = this.triggers[i];
      if (tag && t.tag !== tag) continue;
      if (overlaps(box, t.aabb, 0)) out.push(t);
    }
    return out;
  };

  SD.Physics = {
    World: World,
    aabbOf: aabbOf,
    overlaps: overlaps,
    containsPoint: containsPoint,
    rayAabb: rayAabb,
    holeAllows: holeAllows
  };
})(typeof window !== 'undefined' ? (window.SD = window.SD || {}) : (globalThis.SD = globalThis.SD || {}));
