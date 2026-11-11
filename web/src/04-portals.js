/* SOURCE DRIVE - portal placement and traversable-pair transforms.
 *
 * Mechanics adapted from portal64-still-alive (MIT, commit 277172ab):
 *   - src/physics/rigid_body.c : rigidBodyCheckPortals / rigidBodyTeleport
 *     local-space crossing test with per-portal side flags, a WasTouching flag
 *     that suppresses immediate re-entry, aperture clamping before exit
 *     (rigidBodyClampToPortal), and min/max exit speed handling.
 *   - src/scene/portal.c : portalAttachToSurface
 *     refuses a placement unless the whole aperture fits inside the surface.
 *   - src/player/player.c : playerPortalGrabTransform
 *     a held object's offset is carried through the same transform as the
 *     player so a cube held across a crossing stays in hand.
 * Rewritten in JavaScript against plain AABBs and frames - no N64 code or
 * assets are used. See web/NOTICE.md for the full attribution.
 */
(function (SD) {
  'use strict';
  var C = SD.Core;

  var W = 1.15;          // aperture width  (m)
  var H = 2.05;          // aperture height (m)
  var APERTURE_PAD = 0.06;
  var MAX_SPEED = 34;    // m/s, clamp after transform
  var MIN_EXIT_SPEED = 1.4;
  var REENTRY_LOCK = 0.18; // seconds

  function surfaceFrame(hit) {
    var n = hit.normal;
    var up;
    // A portal lying flat is laid with its long axis along the room's length
    // (world Z), so a body that falls through it has 2.05 m of tolerance in the
    // direction the player chooses and 1.15 m across the drop edge, where the
    // walking drift is deterministic.
    if (Math.abs(n.y) > 0.9) up = { x: 0, y: 0, z: -1 };
    else up = { x: 0, y: 1, z: 0 };
    return C.frameFromNormal(hit.point, n, up);
  }

  // Extent of the hit solid's face, in the plane the portal would occupy.
  // The aperture must fit entirely; portal64 refuses the same way.
  function faceExtent(solid, normal) {
    var box = solid.aabb;
    if (Math.abs(normal.x) > 0.9) {
      return { u: box.max.z - box.min.z, v: box.max.y - box.min.y, uAxis: 'z', vAxis: 'y' };
    }
    if (Math.abs(normal.y) > 0.9) {
      return { u: box.max.x - box.min.x, v: box.max.z - box.min.z, uAxis: 'x', vAxis: 'z' };
    }
    return { u: box.max.x - box.min.x, v: box.max.y - box.min.y, uAxis: 'x', vAxis: 'y' };
  }

  function clampCentre(frame, solid, normal, width, height) {
    var ext = faceExtent(solid, normal);
    var box = solid.aabb;
    var centre = { x: frame.pos.x, y: frame.pos.y, z: frame.pos.z };
    // Snap onto the exact face plane so the quad cannot float or sink.
    if (Math.abs(normal.x) > 0.9) {
      centre.x = normal.x > 0 ? box.max.x : box.min.x;
      centre.z = C.clamp(centre.z, box.min.z + width / 2, box.max.z - width / 2);
      centre.y = C.clamp(centre.y, box.min.y + height / 2, box.max.y - height / 2);
    } else if (Math.abs(normal.y) > 0.9) {
      // Flat portal: the frame's local x runs along world X (width) and its
      // local y along world Z (height), matching the up vector above.
      centre.y = normal.y > 0 ? box.max.y : box.min.y;
      centre.x = C.clamp(centre.x, box.min.x + width / 2, box.max.x - width / 2);
      centre.z = C.clamp(centre.z, box.min.z + height / 2, box.max.z - height / 2);
    } else {
      centre.z = normal.z > 0 ? box.max.z : box.min.z;
      centre.x = C.clamp(centre.x, box.min.x + width / 2, box.max.x - width / 2);
      centre.y = C.clamp(centre.y, box.min.y + height / 2, box.max.y - height / 2);
    }
    // Lift the plane a hair off the surface to stop z-fighting with the wall.
    centre.x += normal.x * 0.012;
    centre.y += normal.y * 0.012;
    centre.z += normal.z * 0.012;
    ext.fits = ext.u >= width + 2 * APERTURE_PAD && ext.v >= height + 2 * APERTURE_PAD;
    return { centre: centre, ext: ext };
  }

  function apertureContainsLocal(local, pad) {
    var p = pad === undefined ? 0 : pad;
    return Math.abs(local.x) <= W / 2 - p && Math.abs(local.y) <= H / 2 - p;
  }

  // A mount region lives on the surface solid itself; hitting anywhere inside
  // it snaps the aperture to the recorded centre.
  function findMount(solid, point) {
    if (!solid || !solid.mounts) return null;
    for (var i = 0; i < solid.mounts.length; i++) {
      var m = solid.mounts[i];
      var r = m.region;
      if (point.x >= r.min.x - 0.06 && point.x <= r.max.x + 0.06 &&
        point.y >= r.min.y - 0.06 && point.y <= r.max.y + 0.06 &&
        point.z >= r.min.z - 0.06 && point.z <= r.max.z + 0.06) return m;
    }
    return null;
  }

  // Clamp an exit point into a slightly smaller aperture so nothing emerges
  // outside the portal - and therefore never outside the room.
  function clampApertureLocal(local) {
    var maxX = W / 2 * 0.86, maxY = H / 2 * 0.86;
    return {
      x: C.clamp(local.x, -maxX, maxX),
      y: C.clamp(local.y, -maxY, maxY),
      z: local.z
    };
  }

  function Portals(opts) {
    this.world = opts.world;
    this.bounds = opts.bounds;
    this.slots = { blue: null, orange: null };
    this.reason = '';
    this.time = 0;
  }

  Portals.prototype.reset = function () {
    this._closeHole(this.slots.blue);
    this._closeHole(this.slots.orange);
    this.slots.blue = null;
    this.slots.orange = null;
    this.reason = '';
    this.time = 0;
  };

  Portals.prototype.get = function (slot) { return this.slots[slot] || null; };

  Portals.prototype.activeCount = function () {
    return (this.slots.blue ? 1 : 0) + (this.slots.orange ? 1 : 0);
  };

  Portals.prototype.pair = function () {
    var b = this.slots.blue, o = this.slots.orange;
    return (b && o) ? { blue: b, orange: o } : null;
  };

  Portals.prototype.other = function (slot) { return this.slots[slot === 'blue' ? 'orange' : 'blue']; };

  /* Returns {ok:true, portal} or {ok:false, reason}. */
  Portals.prototype.place = function (slot, hit) {
    if (!hit || !hit.solid) return this._fail('Nothing in the crosshair to hold a portal.');
    var solid = hit.solid;
    if (!solid.portalable) return this._fail(solid.refusal || 'That surface will not hold a portal.');
    if (solid.dynamic) return this._fail('Moving surfaces cannot hold a portal.');

    var n = hit.normal;
    if (Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z) < 0.9) {
      return this._fail('That surface is not flat enough to hold a portal.');
    }

    var frame;
    var mount = findMount(solid, hit.point);
    if (mount) {
      // Aiming anywhere inside a mount region lands the portal on its centre,
      // so the designed puzzle geometry is reproducible from a rough aim.
      n = mount.normal;
      frame = C.frameFromNormal(
        { x: mount.centre.x + n.x * 0.012, y: mount.centre.y + n.y * 0.012, z: mount.centre.z + n.z * 0.012 },
        n, mount.up || (Math.abs(n.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }));
    } else {
      frame = surfaceFrame(hit);
      var clamped = clampCentre(frame, solid, n, W, H);
      if (!clamped.ext.fits) {
        return this._fail('The aperture does not fit on that panel - aim at the middle of a wall.');
      }
      frame.pos = clamped.centre;
    }

    // Reject a placement that would slice into the other portal's patch.
    var other = this.other(slot);
    if (other && other.solidId === solid.id) {
      var a = C.frameToLocal(other.frame, frame.pos);
      if (Math.abs(a.x) < W && Math.abs(a.y) < H) {
        return this._fail('The two portals cannot share the same patch of surface.');
      }
    }

    // Reject if the exit volume would start inside geometry.
    if (!this._exitIsClear(frame, solid)) {
      return this._fail('There is no clear space in front of that panel.');
    }

    var portal = {
      slot: slot,
      solidId: solid.id,
      solid: solid,
      frame: frame,
      normal: { x: n.x, y: n.y, z: n.z },
      width: W,
      height: H,
      active: true,
      placedAt: this.time
    };
    // Replace any previous portal in this slot and close its hole first.
    var previous = this.slots[slot];
    if (previous) this._closeHole(previous);
    this.slots[slot] = portal;
    this._cutHole(portal);
    this.reason = '';
    return { ok: true, portal: portal };
  };

  // Cut the aperture through the collider so bodies pass through the surface
  // instead of resting on it. portal64 pokes the portal surface mesh; the
  // equivalent here is an aperture window in the AABB.
  Portals.prototype._cutHole = function (portal) {
    var f = portal.frame, n = portal.normal;
    var hx = Math.abs(f.x.x) * W / 2 + Math.abs(f.y.x) * H / 2;
    var hy = Math.abs(f.x.y) * W / 2 + Math.abs(f.y.y) * H / 2;
    var hz = Math.abs(f.x.z) * W / 2 + Math.abs(f.y.z) * H / 2;
    var hole;
    if (Math.abs(n.y) > 0.9) {
      hole = { uAxis: 'x', vAxis: 'z', u0: f.pos.x - hx, u1: f.pos.x + hx, v0: f.pos.z - hz, v1: f.pos.z + hz };
    } else if (Math.abs(n.x) > 0.9) {
      hole = { uAxis: 'z', vAxis: 'y', u0: f.pos.z - hz, u1: f.pos.z + hz, v0: f.pos.y - hy, v1: f.pos.y + hy };
    } else {
      hole = { uAxis: 'x', vAxis: 'y', u0: f.pos.x - hx, u1: f.pos.x + hx, v0: f.pos.y - hy, v1: f.pos.y + hy };
    }
    hole.portalSlot = portal.slot;
    portal.hole = hole;
    this.world.addHole(portal.solid, hole);
  };

  Portals.prototype._closeHole = function (portal) {
    if (portal && portal.hole && portal.solid) {
      this.world.removeHole(portal.solid, portal.hole);
      portal.hole = null;
    }
  };

  Portals.prototype._exitIsClear = function (frame, solid) {
    var centre = C.frameToWorld(frame, { x: 0, y: 0, z: 0 });
    var n = frame.z;
    var pc = { x: centre.x + n.x * 0.5, y: centre.y + n.y * 0.5, z: centre.z + n.z * 0.5 };
    var probe = {
      min: { x: pc.x - 0.3, y: pc.y - 0.3, z: pc.z - 0.3 },
      max: { x: pc.x + 0.3, y: pc.y + 0.3, z: pc.z + 0.3 }
    };
    var all = this.world.solidsNow();
    for (var i = 0; i < all.length; i++) {
      if (all[i] === solid) continue;         // the mount itself is the surface
      if (SD.Physics.overlaps(probe, all[i].aabb, 1e-3)) return false;
    }
    return true;
  };

  Portals.prototype._fail = function (reason) {
    this.reason = reason;
    return { ok: false, reason: reason };
  };

  // ------------------------------------------------------------- traversal
  // body: {pos (feet centre), size, vel, _portal: {blue:{prevSide}, orange:{...}, lockUntil}}
  Portals.prototype.traverse = function (body, dt) {
    var pair = this.pair();
    if (!pair) return null;
    if (!body._portal) body._portal = { prevSide: {}, lockUntil: 0, lockSlot: null, lastSlot: null };
    var st = body._portal;
    var centre = { x: body.pos.x, y: body.pos.y + body.size.y / 2, z: body.pos.z };
    var result = null;

    var slots = ['blue', 'orange'];
    for (var i = 0; i < slots.length && !result; i++) {
      var slot = slots[i];
      var src = this.slots[slot];
      if (!src) continue;
      var local = C.frameToLocal(src.frame, centre);
      var side = local.z >= 0 ? 1 : -1;
      var prev = st.prevSide[slot];
      st.prevSide[slot] = side;
      if (prev === undefined) continue;           // first frame: no crossing yet
      if (prev <= 0 || side > 0) continue;        // only front -> back counts
      if (!apertureContainsLocal(local, -0.15)) continue; // body must be in the mouth
      if (st.lockUntil > this.time) continue;
      if (st.lastSlot === slot && this.time - (st.lastTime || 0) < REENTRY_LOCK) continue;

      var dst = this.other(slot);
      if (!dst) continue;

      var travel = this._teleport(body, src, dst, local);
      if (travel) {
        st.lastSlot = dst.slot;
        st.lastTime = this.time;
        st.lockUntil = this.time + REENTRY_LOCK;
        // Re-arm both sides from the new position so the exit mouth does not
        // fire again on the next frame (portal64 sets IsTouching on the exit).
        var dLocal = C.frameToLocal(dst.frame, { x: body.pos.x, y: body.pos.y + body.size.y / 2, z: body.pos.z });
        st.prevSide[dst.slot] = dLocal.z >= 0 ? 1 : -1;
        st.prevSide[slot] = 1;
        result = travel;
      }
    }
    return result;
  };

  Portals.prototype._teleport = function (body, src, dst, srcLocal) {
    // Exit point: clamped into the destination aperture, offset just clear of
    // the surface so the body is not born inside the wall.
    var clamped = clampApertureLocal(srcLocal);
    var exitLocal = C.flipLocal(clamped);
    var world = C.frameToWorld(dst.frame, exitLocal);
    var half = body.size.z / 2 + 0.05;
    var offset = {
      x: dst.normal.x * half, y: dst.normal.y * half, z: dst.normal.z * half
    };
    var target = { x: world.x + offset.x, y: world.y + offset.y - body.size.y / 2, z: world.z + offset.z };

    if (!this._insideBounds(target)) {
      this.reason = 'The exit would land outside the playable space.';
      return null;
    }

    var wasFree = this.world.isFree(body, target);
    if (!wasFree) {
      // Nudge further out of the wall once before giving up.
      target.x += dst.normal.x * 0.35;
      target.y += dst.normal.y * 0.35;
      target.z += dst.normal.z * 0.35;
      if (!this.world.isFree(body, target)) {
        var _box = { min: { x: target.x - body.size.x / 2, y: target.y, z: target.z - body.size.z / 2 },
          max: { x: target.x + body.size.x / 2, y: target.y + body.size.y, z: target.z + body.size.z / 2 } };
        var _name = '';
        var _probe = this.world.solidsNow();
        for (var _i = 0; _i < _probe.length; _i++) {
          var _s = _probe[_i];
          if (_s === dst.solid) continue;
          if (SD.Physics.overlaps(_box, _s.aabb, 1e-3)) { _name = _s.id; break; }
        }
        this.reason = 'Something solid stood in the exit' + (_name ? ' (' + _name + ')' : '') + ' - clear it and try again.';
        return null;
      }
    }

    var vLocal = C.dirToLocal(src.frame, body.vel);
    var vOut = C.dirToWorld(dst.frame, C.flipDir(vLocal));
    var speed = Math.sqrt(vOut.x * vOut.x + vOut.y * vOut.y + vOut.z * vOut.z);
    if (speed > MAX_SPEED) {
      var s = MAX_SPEED / speed;
      vOut = { x: vOut.x * s, y: vOut.y * s, z: vOut.z * s };
      speed = MAX_SPEED;
    }
    if (speed < MIN_EXIT_SPEED && dst.normal.y > 0.9) {
      // A floor exit must not leave the body standing in its own aperture.
      var d = speed < 1e-6 ? { x: dst.normal.x, y: dst.normal.y, z: dst.normal.z } :
        { x: vOut.x / speed, y: vOut.y / speed, z: vOut.z / speed };
      vOut = { x: d.x * MIN_EXIT_SPEED, y: d.y * MIN_EXIT_SPEED, z: d.z * MIN_EXIT_SPEED };
      speed = MIN_EXIT_SPEED;
    }

    var from = { x: body.pos.x, y: body.pos.y, z: body.pos.z };
    body.pos.x = target.x; body.pos.y = target.y; body.pos.z = target.z;
    body.vel.x = vOut.x; body.vel.y = vOut.y; body.vel.z = vOut.z;
    if (body.onGround) body.onGround = false;

    return {
      fromPortal: src.slot,
      toPortal: dst.slot,
      from: from,
      to: { x: body.pos.x, y: body.pos.y, z: body.pos.z },
      entrySpeed: Math.sqrt(vLocal.x * vLocal.x + vLocal.y * vLocal.y + vLocal.z * vLocal.z),
      exitSpeed: speed,
      velocity: { x: vOut.x, y: vOut.y, z: vOut.z }
    };
  };

  Portals.prototype._insideBounds = function (p) {
    var b = this.bounds;
    if (!b) return true;
    return p.x > b.min.x + 0.2 && p.x < b.max.x - 0.2 &&
      p.y > b.min.y - 4.5 && p.y < b.max.y - 0.2 &&
      p.z > b.min.z + 0.2 && p.z < b.max.z - 0.2;
  };

  // Transform a view direction for the player after a crossing.
  Portals.prototype.transformDirection = function (srcSlot, dir) {
    var src = this.slots[srcSlot];
    var dst = this.other(srcSlot);
    if (!src || !dst) return { x: dir.x, y: dir.y, z: dir.z };
    var local = C.dirToLocal(src.frame, dir);
    return C.dirToWorld(dst.frame, C.flipDir(local));
  };

  // Transform a held object's camera-space offset across the same pair.
  Portals.prototype.transformOffset = function (srcSlot, offset) {
    return this.transformDirection(srcSlot, offset);
  };

  Portals.prototype.tick = function (dt) { this.time += dt; };

  SD.Portals = {
    create: function (opts) { return new Portals(opts); },
    WIDTH: W,
    HEIGHT: H,
    clampApertureLocal: clampApertureLocal,
    apertureContainsLocal: apertureContainsLocal,
    faceExtent: faceExtent
  };
})(typeof window !== 'undefined' ? (window.SD = window.SD || {}) : (globalThis.SD = globalThis.SD || {}));
